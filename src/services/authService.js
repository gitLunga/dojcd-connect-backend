const crypto          = require('crypto');
const db              = require('../config/db');
const bcrypt          = require('bcrypt');
const ClientUser      = require('../models/ClientUser');
const OperationalUser = require('../models/OperationalUser');
const storage         = require('../config/localStorage');
const tokenService    = require('./tokenService');
const auditService    = require('./auditService');
const emailService    = require('./emailService');
const passwordPolicy  = require('../utils/passwordPolicy');

const RESET_TOKEN_TTL_MS  = 60 * 60 * 1000; // 1 hour
const RESET_RATE_LIMIT_MS = 5  * 60 * 1000; // 1 request per 5 min per email

class AuthService {

    // ── REGISTER CLIENT ───────────────────────────────────────────────────────

    async registerUser(userData) {
        const {
            title, first_name, last_name, email, phone_number, region, persal_id,
            department_id, user_type, password
        } = userData;

        if (!first_name || !last_name || !email || !password || !persal_id) {
            throw new Error('Required fields missing');
        }

        passwordPolicy.enforce(password);

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
                actorId: user.client_user_id, actorType: 'Client',
                action: 'CLIENT_REGISTERED', entityType: 'client_user', entityId: user.client_user_id,
            });

            await client.query('COMMIT');

            const userResponse = { ...user };
            delete userResponse.password_hash;

            // Fire-and-forget — email failure must not block registration
            emailService.sendWelcomeClient(email, first_name).catch(() => {});

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

    // ── COMPLETE PROFILE ──────────────────────────────────────────────────────

    async completeProfile(clientUserId, profileData, files) {
        const { network_provider, contract_duration_months, contract_end_date } = profileData;

        if (!network_provider || !contract_duration_months || !contract_end_date) {
            throw new Error('All profile fields are required');
        }

        const uploadedPaths = [];
        const client = await db.connect();

        try {
            await client.query('BEGIN');

            let invoicePath = null;
            if (files.invoice_file) {
                const f = Array.isArray(files.invoice_file) ? files.invoice_file[0] : files.invoice_file;
                invoicePath = await storage.uploadFile(f.buffer, f.mimetype, 'invoices', 'invoice', clientUserId);
                uploadedPaths.push(invoicePath);
            }

            const userResult = await client.query(
                `UPDATE client_user
                 SET network_provider=$1, contract_duration_months=$2, contract_end_date=$3,
                     invoice_path=$4, registration_status='Profile_Completed', updated_at=CURRENT_TIMESTAMP
                 WHERE client_user_id=$5 RETURNING *`,
                [network_provider, contract_duration_months, contract_end_date, invoicePath, clientUserId]
            );
            if (userResult.rows.length === 0) throw new Error(`User ${clientUserId} not found`);

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
                const f = Array.isArray(files[def.key]) ? files[def.key][0] : files[def.key];
                const savedPath = await storage.uploadFile(f.buffer, f.mimetype, 'documents', def.prefix, clientUserId);
                uploadedPaths.push(savedPath);

                const docResult = await client.query(
                    `INSERT INTO document (client_user_id, document_type, s3_path, document_status, upload_date)
                     VALUES ($1,$2,$3,'Pending',CURRENT_TIMESTAMP)
                     RETURNING document_id, document_type, s3_path, upload_date`,
                    [clientUserId, def.type, savedPath]
                );
                if (docResult.rows.length === 0) throw new Error(`Failed to insert ${def.type} record`);
                savedDocuments.push(docResult.rows[0]);
            }

            await auditService.log(client, {
                actorId: clientUserId, actorType: 'Client',
                action: 'PROFILE_COMPLETED', entityType: 'client_user', entityId: clientUserId,
                newValue: { network_provider, contract_duration_months, contract_end_date },
            });

            await client.query('COMMIT');

            const row = userResult.rows[0];
            emailService.sendProfileUnderReview(row.email, row.first_name).catch(() => {});

            return { success: true, user: row, documents: savedDocuments, message: 'Profile completed successfully' };

        } catch (error) {
            await client.query('ROLLBACK');
            for (const p of uploadedPaths) { try { await storage.deleteFile(p); } catch (_) {} }
            throw error;
        } finally {
            client.release();
        }
    }

    // ── REGISTER OPERATIONAL USER ─────────────────────────────────────────────

    async registerOperationalUser(userData, createdByAdminId = null) {
        const { title, first_name, last_name, email, user_role, password, department_id } = userData;

        const validRoles = ['Admin', 'MTN_Staff', 'Approver', 'Manager', 'Finance'];
        if (!validRoles.includes(user_role)) {
            throw new Error(`Invalid user role. Must be one of: ${validRoles.join(', ')}`);
        }

        passwordPolicy.enforce(password);

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
                     (title, first_name, last_name, email, user_role, department_id, password_hash)
                 VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
                [title, first_name, last_name, email, user_role, department_id || null, hashedPassword]
            );
            if (result.rows.length === 0) throw new Error('Operational user registration failed');

            const user = new OperationalUser(result.rows[0]);

            await auditService.log(client, {
                actorId: createdByAdminId || user.op_user_id,
                actorType: createdByAdminId ? 'Operational' : 'System',
                action: 'OPERATIONAL_USER_CREATED', entityType: 'operational_user', entityId: user.op_user_id,
                newValue: { email, user_role },
            });

            await client.query('COMMIT');

            emailService.sendOperationalUserWelcome(email, first_name, user_role, password).catch(() => {});

            const userResponse = { ...user };
            delete userResponse.password_hash;
            return userResponse;
        } catch (err) {
            await client.query('ROLLBACK');
            throw err;
        } finally {
            client.release();
        }
    }

    // ── LOGIN CLIENT ──────────────────────────────────────────────────────────

    async loginClientUser(loginData, ipAddress = null) {
        const { email, password } = loginData;

        const result = await db.query(`SELECT * FROM client_user WHERE email = $1`, [email]);

        if (result.rows.length === 0) {
            await auditService.logLoginAttempt(email, ipAddress, false);
            throw new Error('Invalid email or password');
        }

        const user = new ClientUser(result.rows[0]);
        const isValid = await bcrypt.compare(password, user.password_hash);
        await auditService.logLoginAttempt(email, ipAddress, isValid);
        if (!isValid) throw new Error('Invalid email or password');

        const userResponse = { ...user };
        delete userResponse.password_hash;

        const accessToken  = tokenService.generateAccessToken(userResponse.client_user_id, 'Client');
        const refreshToken = await tokenService.generateRefreshToken(userResponse.client_user_id, 'Client');

        return { user: userResponse, accessToken, refreshToken };
    }

    // ── LOGIN OPERATIONAL ─────────────────────────────────────────────────────

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
        const isValid = await bcrypt.compare(password, user.password_hash);
        await auditService.logLoginAttempt(email, ipAddress, isValid);
        if (!isValid) throw new Error('Invalid email or password');

        const userResponse = { ...user };
        delete userResponse.password_hash;
        userResponse.name = `${user.first_name} ${user.last_name}`.trim();

        const accessToken = tokenService.generateAccessToken(
            userResponse.op_user_id, 'Operational', userResponse.user_role,
            userResponse.department_id || null, userResponse.must_change_password
        );
        const refreshToken = await tokenService.generateRefreshToken(userResponse.op_user_id, 'Operational');

        return { user: userResponse, accessToken, refreshToken };
    }

    // ── GENERIC LOGIN ─────────────────────────────────────────────────────────

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
        let user, userType, userId, role = null, departmentId = null, mustChangePassword = false;

        if (userData.table_type === 'client') {
            user       = new ClientUser(userData);
            userType   = 'Client';
            userId     = user.client_user_id;
            departmentId = user.department_id || null;
        } else {
            user              = new OperationalUser(userData);
            userType          = 'Operational';
            userId            = user.op_user_id;
            role              = user.user_role;
            departmentId      = user.department_id || null;
            mustChangePassword = user.must_change_password;
        }

        const isValid = await bcrypt.compare(password, user.password_hash);
        await auditService.logLoginAttempt(email, ipAddress, isValid);
        if (!isValid) throw new Error('Invalid email or password');

        const userResponse = { ...user };
        delete userResponse.password_hash;
        delete userResponse.table_type;

        const accessToken  = tokenService.generateAccessToken(userId, userType, role, departmentId, mustChangePassword);
        const refreshToken = await tokenService.generateRefreshToken(userId, userType);

        return { user: userResponse, accessToken, refreshToken };
    }

    // ── CHANGE PASSWORD (logged-in user) ──────────────────────────────────────

    async changePassword(userId, userType, currentPassword, newPassword) {
        passwordPolicy.enforce(newPassword);

        const client = await db.connect();
        try {
            await client.query('BEGIN');

            let row, table, idCol;
            if (userType === 'Client') {
                table = 'client_user'; idCol = 'client_user_id';
            } else {
                table = 'operational_user'; idCol = 'op_user_id';
            }

            const result = await client.query(
                `SELECT password_hash, email, first_name FROM ${table} WHERE ${idCol} = $1`, [userId]
            );
            if (result.rows.length === 0) throw new Error('User not found.');

            const { password_hash, email, first_name } = result.rows[0];
            const isValid = await bcrypt.compare(currentPassword, password_hash);
            if (!isValid) throw new Error('Current password is incorrect.');

            const isSame = await bcrypt.compare(newPassword, password_hash);
            if (isSame) throw new Error('New password must be different from the current password.');

            const newHash = await bcrypt.hash(newPassword, 10);

            if (userType === 'Operational') {
                await client.query(
                    `UPDATE operational_user SET password_hash=$1, must_change_password=false, updated_at=NOW() WHERE op_user_id=$2`,
                    [newHash, userId]
                );
            } else {
                await client.query(
                    `UPDATE client_user SET password_hash=$1, updated_at=NOW() WHERE client_user_id=$2`,
                    [newHash, userId]
                );
            }

            await auditService.log(client, {
                actorId: userId, actorType: userType,
                action: 'PASSWORD_CHANGED', entityType: table, entityId: userId,
            });

            await client.query('COMMIT');

            emailService.sendPasswordChanged(email, first_name).catch(() => {});

            return { success: true };
        } catch (err) {
            await client.query('ROLLBACK');
            throw err;
        } finally {
            client.release();
        }
    }

    // ── FORGOT PASSWORD ───────────────────────────────────────────────────────

    async requestPasswordReset(email, resetBaseUrl) {
        // Find user in either table
        let userRow = null, userType = null;

        const clientResult = await db.query(
            `SELECT client_user_id AS id, first_name, email FROM client_user WHERE email = $1`, [email]
        );
        if (clientResult.rows.length > 0) {
            userRow  = clientResult.rows[0];
            userType = 'Client';
        } else {
            const opResult = await db.query(
                `SELECT op_user_id AS id, first_name, email FROM operational_user WHERE email = $1 AND is_deleted = false`,
                [email]
            );
            if (opResult.rows.length > 0) {
                userRow  = opResult.rows[0];
                userType = 'Operational';
            }
        }

        // Always return success — do not reveal whether email exists
        if (!userRow) return { success: true };

        // Rate-limit: one request per 5 minutes per email
        const recent = await db.query(
            `SELECT created_at FROM password_reset_token
             WHERE email = $1 AND created_at > NOW() - INTERVAL '5 minutes'
             ORDER BY created_at DESC LIMIT 1`,
            [email]
        );
        if (recent.rows.length > 0) return { success: true }; // silently throttle

        const rawToken  = crypto.randomBytes(32).toString('hex');
        const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
        const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS);

        await db.query(
            `INSERT INTO password_reset_token (email, user_type, token_hash, expires_at)
             VALUES ($1, $2, $3, $4)`,
            [email, userType, tokenHash, expiresAt]
        );

        const resetUrl = `${resetBaseUrl}?token=${rawToken}`;

        // This one IS fatal — if we can't send the email the user has no way to reset
        await emailService.sendPasswordResetRequest(email, userRow.first_name, resetUrl);

        return { success: true };
    }

    // ── RESET PASSWORD (via token) ────────────────────────────────────────────

    async resetPassword(rawToken, newPassword) {
        passwordPolicy.enforce(newPassword);

        const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');

        const tokenResult = await db.query(
            `SELECT * FROM password_reset_token WHERE token_hash = $1`, [tokenHash]
        );
        if (tokenResult.rows.length === 0) throw new Error('Invalid or expired reset link.');

        const stored = tokenResult.rows[0];
        if (stored.used_at)                         throw new Error('This reset link has already been used.');
        if (new Date(stored.expires_at) < new Date()) throw new Error('This reset link has expired. Please request a new one.');

        const client = await db.connect();
        try {
            await client.query('BEGIN');

            const newHash = await bcrypt.hash(newPassword, 10);
            let userId, firstName;

            if (stored.user_type === 'Client') {
                const r = await client.query(
                    `UPDATE client_user SET password_hash=$1, updated_at=NOW()
                     WHERE email=$2 RETURNING client_user_id AS id, first_name`,
                    [newHash, stored.email]
                );
                if (r.rows.length === 0) throw new Error('User not found.');
                userId    = r.rows[0].id;
                firstName = r.rows[0].first_name;
            } else {
                const r = await client.query(
                    `UPDATE operational_user
                     SET password_hash=$1, must_change_password=false, updated_at=NOW()
                     WHERE email=$2 AND is_deleted=false
                     RETURNING op_user_id AS id, first_name`,
                    [newHash, stored.email]
                );
                if (r.rows.length === 0) throw new Error('User not found.');
                userId    = r.rows[0].id;
                firstName = r.rows[0].first_name;
            }

            await client.query(
                `UPDATE password_reset_token SET used_at=NOW() WHERE token_hash=$1`, [tokenHash]
            );

            await auditService.log(client, {
                actorId: userId, actorType: stored.user_type,
                action: 'PASSWORD_RESET', entityType: stored.user_type === 'Client' ? 'client_user' : 'operational_user',
                entityId: userId,
            });

            await client.query('COMMIT');

            emailService.sendPasswordChanged(stored.email, firstName).catch(() => {});

            return { success: true, message: 'Password reset successfully. You can now log in.' };
        } catch (err) {
            await client.query('ROLLBACK');
            throw err;
        } finally {
            client.release();
        }
    }
}

module.exports = new AuthService();
