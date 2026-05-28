const db           = require('../config/db');
const bcrypt       = require('bcrypt');
const ClientUser   = require('../models/ClientUser');
const OperationalUser = require('../models/OperationalUser');
const storage      = require('../config/localStorage');
const tokenService = require('./tokenService');
const auditService = require('./auditService');

class AuthService {

    async registerUser(userData) {
        const {
            title, first_name, last_name, email, phone_number, region, persal_id,
            department_id, user_type, password
        } = userData;

        if (!first_name || !last_name || !email || !password || !persal_id) {
            throw new Error('Required fields missing');
        }

        const hashedPassword = await bcrypt.hash(password, 10);

        const client = await db.connect();
        try {
            await client.query('BEGIN');

            const result = await client.query(
                `INSERT INTO client_user
                     (title, first_name, last_name, email, phone_number, region,
                      persal_id, department_id, user_type, password_hash, registration_status)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'Pending') RETURNING *`,
                [title, first_name, last_name, email, phone_number,
                 region, persal_id, department_id, user_type, hashedPassword]
            );

            const user = new ClientUser(result.rows[0]);

            await auditService.log(client, {
                actorId:    user.client_user_id,
                actorType:  'Client',
                action:     'CLIENT_REGISTERED',
                entityType: 'client_user',
                entityId:   user.client_user_id,
            });

            await client.query('COMMIT');

            const userResponse = {...user};
            delete userResponse.password_hash;

            const accessToken  = tokenService.generateAccessToken(userResponse.client_user_id, 'Client');
            const refreshToken = await tokenService.generateRefreshToken(userResponse.client_user_id, 'Client');

            return { user: userResponse, accessToken, refreshToken };

        } catch (err) {
            await client.query('ROLLBACK');
            throw err;
        } finally {
            client.release();
        }
    }

    async completeProfile(clientUserId, profileData, files) {
        const { network_provider, contract_duration_months, contract_end_date } = profileData;

        if (!network_provider || !contract_duration_months || !contract_end_date) {
            throw new Error('All profile fields are required');
        }

        console.log(`\n🔄 Starting profile completion for user ${clientUserId}`);

        const uploadedPaths = [];
        const client = await db.connect();

        try {
            await client.query('BEGIN');

            // 1. Upload invoice
            let invoicePath = null;
            if (files.invoice_file) {
                const invoiceFile = Array.isArray(files.invoice_file)
                    ? files.invoice_file[0] : files.invoice_file;
                invoicePath = await storage.uploadFile(
                    invoiceFile.buffer, invoiceFile.mimetype, 'invoices', 'invoice', clientUserId
                );
                uploadedPaths.push(invoicePath);
                console.log(`✅ Invoice uploaded: ${invoicePath}`);
            }

            // 2. Update user profile
            const userResult = await client.query(
                `UPDATE client_user
                 SET network_provider         = $1,
                     contract_duration_months = $2,
                     contract_end_date        = $3,
                     invoice_path             = $4,
                     registration_status      = 'Profile_Completed',
                     updated_at               = CURRENT_TIMESTAMP
                 WHERE client_user_id = $5
                 RETURNING *`,
                [network_provider, contract_duration_months, contract_end_date, invoicePath, clientUserId]
            );

            if (userResult.rows.length === 0) throw new Error(`User ${clientUserId} not found`);

            // 3. Upload and record documents
            const savedDocuments = [];
            const docDefs = [
                { key: 'id_document',        type: 'ID',                 prefix: 'id',        required: true  },
                { key: 'payslip_document',   type: 'Payslip',            prefix: 'payslip',   required: true  },
                { key: 'residence_document', type: 'Proof_of_Residence', prefix: 'residence', required: false },
            ];

            for (const def of docDefs) {
                if (!files[def.key]) {
                    if (def.required) throw new Error(`${def.key} is required`);
                    continue;
                }

                const file = Array.isArray(files[def.key]) ? files[def.key][0] : files[def.key];

                const savedPath = await storage.uploadFile(
                    file.buffer, file.mimetype, 'documents', def.prefix, clientUserId
                );
                uploadedPaths.push(savedPath);

                const docResult = await client.query(
                    `INSERT INTO document
                         (client_user_id, document_type, s3_path, document_status, upload_date)
                     VALUES ($1, $2, $3, 'Pending', CURRENT_TIMESTAMP)
                     RETURNING document_id, document_type, s3_path, upload_date`,
                    [clientUserId, def.type, savedPath]
                );

                if (docResult.rows.length === 0) throw new Error(`Failed to insert ${def.type} record`);
                savedDocuments.push(docResult.rows[0]);
            }

            // 4. Audit
            await auditService.log(client, {
                actorId:    clientUserId,
                actorType:  'Client',
                action:     'PROFILE_COMPLETED',
                entityType: 'client_user',
                entityId:   clientUserId,
                newValue:   { network_provider, contract_duration_months, contract_end_date },
            });

            await client.query('COMMIT');
            console.log(`✅ Profile completed successfully for user ${clientUserId}\n`);

            return {
                success:   true,
                user:      userResult.rows[0],
                documents: savedDocuments,
                message:   'Profile completed successfully',
            };

        } catch (error) {
            console.error(`❌ Error in completeProfile: ${error.message}`);
            await client.query('ROLLBACK');

            for (const p of uploadedPaths) {
                try { await storage.deleteFile(p); } catch (_) {}
            }

            throw error;
        } finally {
            client.release();
        }
    }

    async registerOperationalUser(userData, createdByAdminId = null) {
        const { title, first_name, last_name, email, user_role, password } = userData;

        const validRoles = ['Admin', 'MTN_Staff', 'Approver', 'Manager', 'Finance'];
        if (!validRoles.includes(user_role)) {
            throw new Error(`Invalid user role. Must be one of: ${validRoles.join(', ')}`);
        }

        const hashedPassword = await bcrypt.hash(password, 10);

        const client = await db.connect();
        try {
            await client.query('BEGIN');

            const emailCheck = await client.query(
                `SELECT op_user_id FROM operational_user WHERE email = $1`, [email]
            );
            if (emailCheck.rows.length > 0) throw new Error('Email already registered');

            const result = await client.query(
                `INSERT INTO operational_user
                     (title, first_name, last_name, email, user_role, password_hash)
                 VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
                [title, first_name, last_name, email, user_role, hashedPassword]
            );

            if (result.rows.length === 0) throw new Error('Operational user registration failed');

            const user = new OperationalUser(result.rows[0]);

            await auditService.log(client, {
                actorId:    createdByAdminId || user.op_user_id,
                actorType:  createdByAdminId ? 'Operational' : 'System',
                action:     'OPERATIONAL_USER_CREATED',
                entityType: 'operational_user',
                entityId:   user.op_user_id,
                newValue:   { email, user_role },
            });

            await client.query('COMMIT');

            const userResponse = {...user};
            delete userResponse.password_hash;
            return userResponse;

        } catch (err) {
            await client.query('ROLLBACK');
            throw err;
        } finally {
            client.release();
        }
    }

    // Login Client User
    async loginClientUser(loginData, ipAddress = null) {
        const { email, password } = loginData;

        const result = await db.query(
            `SELECT * FROM client_user WHERE email = $1`, [email]
        );

        if (result.rows.length === 0) {
            await auditService.logLoginAttempt(email, ipAddress, false);
            throw new Error('Invalid email or password');
        }

        const user = new ClientUser(result.rows[0]);
        const isPasswordValid = await bcrypt.compare(password, user.password_hash);
        await auditService.logLoginAttempt(email, ipAddress, isPasswordValid);

        if (!isPasswordValid) throw new Error('Invalid email or password');

        const userResponse = {...user};
        delete userResponse.password_hash;

        const accessToken  = tokenService.generateAccessToken(userResponse.client_user_id, 'Client');
        const refreshToken = await tokenService.generateRefreshToken(userResponse.client_user_id, 'Client');

        return { user: userResponse, accessToken, refreshToken };
    }

    // Login Operational User
    async loginOperationalUser(loginData, ipAddress = null) {
        const { email, password } = loginData;

        const result = await db.query(
            `SELECT * FROM operational_user WHERE email = $1 AND is_deleted = false`, [email]
        );

        if (result.rows.length === 0) {
            await auditService.logLoginAttempt(email, ipAddress, false);
            throw new Error('Invalid email or password');
        }

        const user = new OperationalUser(result.rows[0]);
        const isPasswordValid = await bcrypt.compare(password, user.password_hash);
        await auditService.logLoginAttempt(email, ipAddress, isPasswordValid);

        if (!isPasswordValid) throw new Error('Invalid email or password');

        const userResponse = {...user};
        delete userResponse.password_hash;
        userResponse.name = `${user.first_name} ${user.last_name}`.trim();

        const accessToken  = tokenService.generateAccessToken(userResponse.op_user_id, 'Operational', userResponse.user_role);
        const refreshToken = await tokenService.generateRefreshToken(userResponse.op_user_id, 'Operational');

        return { user: userResponse, accessToken, refreshToken };
    }

    // Generic login — tries client first, then operational
    async loginUser(loginData, ipAddress = null) {
        const { email, password } = loginData;

        let result = await db.query(
            `SELECT *, 'client' as table_type FROM client_user WHERE email = $1`, [email]
        );

        if (result.rows.length === 0) {
            result = await db.query(
                `SELECT *, 'operational' as table_type FROM operational_user WHERE email = $1 AND is_deleted = false`,
                [email]
            );
        }

        if (result.rows.length === 0) {
            await auditService.logLoginAttempt(email, ipAddress, false);
            throw new Error('Invalid email or password');
        }

        const userData = result.rows[0];
        let user, userType, userId, role = null;

        if (userData.table_type === 'client') {
            user     = new ClientUser(userData);
            userType = 'Client';
            userId   = user.client_user_id;
        } else {
            user     = new OperationalUser(userData);
            userType = 'Operational';
            userId   = user.op_user_id;
            role     = user.user_role;
        }

        const isPasswordValid = await bcrypt.compare(password, user.password_hash);
        await auditService.logLoginAttempt(email, ipAddress, isPasswordValid);

        if (!isPasswordValid) throw new Error('Invalid email or password');

        const userResponse = {...user};
        delete userResponse.password_hash;
        delete userResponse.table_type;

        const accessToken  = tokenService.generateAccessToken(userId, userType, role);
        const refreshToken = await tokenService.generateRefreshToken(userId, userType);

        return { user: userResponse, accessToken, refreshToken };
    }
}

module.exports = new AuthService();
