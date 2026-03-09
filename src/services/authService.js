const db = require('../config/db');
const bcrypt = require('bcrypt');
const ClientUser = require('../models/ClientUser');
const OperationalUser = require('../models/OperationalUser');
const path = require('path');
const fs = require('fs');

// ─── Utility: map raw errors to friendly messages ─────────────────────────────
function friendlyError(error, context = 'operation') {
    const msg = error.message || '';

    if (msg.includes('duplicate key') && msg.includes('email')) {
        return 'An account with this email address already exists.';
    }
    if (msg.includes('duplicate key') && msg.includes('persal')) {
        return 'An account with this Persal ID already exists.';
    }
    if (msg.includes('duplicate key')) {
        return 'This record already exists.';
    }
    if (msg.includes('connect') || msg.includes('ECONNREFUSED')) {
        return 'We are having trouble reaching the server. Please try again shortly.';
    }

    console.error(`❌ AuthService error [${context}]:`, error);
    return `We could not complete this ${context}. Please try again.`;
}

class AuthService {

    // ─── REGISTRATION ─────────────────────────────────────────────────────────

    async registerUser(userData) {
        const { title, first_name, last_name, email, phone_number, region,
            persal_id, department_id, user_type, password } = userData;

        // Validate required fields with specific messages
        if (!first_name || !last_name) {
            throw new Error('Please provide your first and last name.');
        }
        if (!email) {
            throw new Error('Please provide your email address.');
        }
        if (!password) {
            throw new Error('Please provide a password.');
        }
        if (!persal_id) {
            throw new Error('Please provide your Persal ID.');
        }

        const hashedPassword = await bcrypt.hash(password, 10);

        const query = `
            INSERT INTO client_user (
                title, first_name, last_name, email, phone_number,
                region, persal_id, department_id, user_type,
                password_hash, registration_status
            )
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'Pending')
                RETURNING *;
        `;

        try {
            const result = await db.query(query, [
                title, first_name, last_name, email, phone_number,
                region, persal_id, department_id, user_type, hashedPassword
            ]);

            const user = new ClientUser(result.rows[0]);
            const userResponse = { ...user };
            delete userResponse.password_hash;

            return userResponse;
        } catch (error) {
            console.error('🔴 DB Error:', error.message);

            // Handle duplicate email
            if (error.message.includes('duplicate key') && error.message.includes('email')) {
                const err = new Error('An account with this email address already exists. Please log in instead.');
                err.statusCode = 409;
                throw err;
            }

            // Handle duplicate Persal ID
            if (error.message.includes('duplicate key') && error.message.includes('persal')) {
                const err = new Error('An account with this Persal ID already exists. Please contact support if you believe this is an error.');
                err.statusCode = 409;
                throw err;
            }

            // Handle any other duplicate
            if (error.message.includes('duplicate key')) {
                const err = new Error('This record already exists.');
                err.statusCode = 409;
                throw err;
            }

            // Other errors
            throw new Error(friendlyError(error, 'registration'));
        }
    }

    // ─── COMPLETE PROFILE ─────────────────────────────────────────────────────

    async completeProfile(clientUserId, profileData, files) {
        const { network_provider, contract_duration_months, contract_end_date } = profileData;

        if (!network_provider) {
            throw new Error('Please select a network provider.');
        }
        if (!contract_duration_months) {
            throw new Error('Please specify the contract duration.');
        }
        if (!contract_end_date) {
            throw new Error('Please provide the contract end date.');
        }

        await db.query('BEGIN');

        try {
            let invoicePath = null;
            if (files.invoice_file) {
                const invoiceFile = Array.isArray(files.invoice_file) ? files.invoice_file[0] : files.invoice_file;
                invoicePath = await this.saveFile(invoiceFile, 'invoices', clientUserId, 'invoice');
            }

            const updateQuery = `
                UPDATE client_user
                SET
                    network_provider = $1,
                    contract_duration_months = $2,
                    contract_end_date = $3,
                    invoice_path = $4,
                    registration_status = 'Profile_Completed',
                    updated_at = CURRENT_TIMESTAMP
                WHERE client_user_id = $5
                RETURNING *;
            `;

            const userResult = await db.query(updateQuery, [
                network_provider, contract_duration_months,
                contract_end_date, invoicePath, clientUserId
            ]);

            if (userResult.rows.length === 0) {
                throw new Error('User not found. Please try again.');
            }

            const savedDocuments = [];

            if (files.id_document) {
                const idFile = Array.isArray(files.id_document) ? files.id_document[0] : files.id_document;
                const savedPath = await this.saveFile(idFile, 'documents', clientUserId, 'id');
                const docResult = await db.query(
                    `INSERT INTO document (client_user_id, document_type, s3_path, document_status)
                     VALUES ($1, $2, $3, 'Pending')
                     RETURNING document_id, document_type, s3_path`,
                    [clientUserId, 'ID', savedPath]
                );
                savedDocuments.push(docResult.rows[0]);
            }

            if (files.payslip_document) {
                const payslipFile = Array.isArray(files.payslip_document) ? files.payslip_document[0] : files.payslip_document;
                const savedPath = await this.saveFile(payslipFile, 'documents', clientUserId, 'payslip');
                const docResult = await db.query(
                    `INSERT INTO document (client_user_id, document_type, s3_path, document_status)
                     VALUES ($1, $2, $3, 'Pending')
                     RETURNING document_id, document_type, s3_path`,
                    [clientUserId, 'Payslip', savedPath]
                );
                savedDocuments.push(docResult.rows[0]);
            }

            if (files.residence_document) {
                const residenceFile = Array.isArray(files.residence_document) ? files.residence_document[0] : files.residence_document;
                const savedPath = await this.saveFile(residenceFile, 'documents', clientUserId, 'residence');
                const docResult = await db.query(
                    `INSERT INTO document (client_user_id, document_type, s3_path, document_status)
                     VALUES ($1, $2, $3, 'Pending')
                     RETURNING document_id, document_type, s3_path`,
                    [clientUserId, 'Proof_of_Residence', savedPath]
                );
                savedDocuments.push(docResult.rows[0]);
            }

            await db.query('COMMIT');

            return {
                success: true,
                user: userResult.rows[0],
                documents: savedDocuments,
                message: 'Your profile has been completed successfully! We will review your documents and get back to you shortly.'
            };

        } catch (error) {
            await db.query('ROLLBACK');
            console.error('Profile completion error:', error);
            if (error.message.includes('Please') || error.message.includes('not found')) {
                throw error;
            }
            throw new Error(friendlyError(error, 'profile completion'));
        }
    }

    // ─── FILE HELPER ──────────────────────────────────────────────────────────

    async saveFile(file, folder, clientUserId, prefix) {
        const uploadDir = path.join(__dirname, `../uploads/${folder}`);

        if (!fs.existsSync(uploadDir)) {
            fs.mkdirSync(uploadDir, { recursive: true });
        }

        let ext = path.extname(file.originalname);
        if (!ext) {
            if (file.mimetype === 'application/pdf') ext = '.pdf';
            else if (file.mimetype === 'image/jpeg') ext = '.jpg';
            else if (file.mimetype === 'image/png') ext = '.png';
            else ext = '.bin';
        }

        const uniqueFilename = `${prefix}_${clientUserId}_${Date.now()}${ext}`;
        const finalPath = path.join(uploadDir, uniqueFilename);

        if (file.path && fs.existsSync(file.path)) {
            fs.renameSync(file.path, finalPath);
        } else if (file.buffer) {
            fs.writeFileSync(finalPath, file.buffer);
        } else {
            throw new Error('The uploaded file could not be saved. Please try again.');
        }

        return `/uploads/${folder}/${uniqueFilename}`;
    }

    async handleInvoiceUpload(file) {
        try {
            const uploadDir = path.join(__dirname, '../uploads/invoices');
            if (!fs.existsSync(uploadDir)) {
                fs.mkdirSync(uploadDir, { recursive: true });
            }

            const timestamp = Date.now();
            const uniqueFilename = `temp_invoice_${timestamp}_${Math.random().toString(36).substr(2, 9)}${path.extname(file.originalname)}`;
            const filePath = path.join(uploadDir, uniqueFilename);

            if (file.buffer) {
                fs.writeFileSync(filePath, file.buffer);
            } else if (file.path) {
                fs.renameSync(file.path, filePath);
            }

            return {
                success: true,
                tempPath: filePath,
                filename: uniqueFilename,
                mimeType: file.mimetype,
                relativePath: `/uploads/invoices/${uniqueFilename}`
            };
        } catch (error) {
            console.error('Upload error:', error);
            throw new Error('Your invoice could not be uploaded. Please check the file and try again.');
        }
    }

    // ─── OPERATIONAL USER REGISTRATION ───────────────────────────────────────

    async registerOperationalUser(userData) {
        const { title, first_name, last_name, email, user_role, password } = userData;

        if (!first_name || !last_name || !email || !password || !user_role) {
            throw new Error('Please fill in all required fields.');
        }

        const emailCheck = await db.query(
            `SELECT op_user_id FROM operational_user WHERE email = $1`, [email]
        );
        if (emailCheck.rows.length > 0) {
            throw new Error('An operational account with this email already exists.');
        }

        const validRoles = ['Admin', 'MTN_Staff', 'Warehouse', 'Approver'];
        if (!validRoles.includes(user_role)) {
            throw new Error(`"${user_role}" is not a valid role. Please choose from: ${validRoles.join(', ')}.`);
        }

        const hashedPassword = await bcrypt.hash(password, 10);

        try {
            const result = await db.query(
                `INSERT INTO operational_user
                 (title, first_name, last_name, email, user_role, password_hash)
                 VALUES ($1, $2, $3, $4, $5, $6)
                 RETURNING *;`,
                [title, first_name, last_name, email, user_role, hashedPassword]
            );

            if (result.rows.length === 0) {
                throw new Error('Registration could not be completed. Please try again.');
            }

            const user = new OperationalUser(result.rows[0]);
            const userResponse = { ...user };
            delete userResponse.password_hash;

            return userResponse;
        } catch (error) {
            if (error.message.includes('Please') || error.message.includes('already exists')) {
                throw error;
            }
            throw new Error(friendlyError(error, 'registration'));
        }
    }

    // ─── LOGIN ────────────────────────────────────────────────────────────────

    async loginClientUser(loginData) {
        const { email, password } = loginData;

        if (!email || !password) {
            throw new Error('Please provide your email and password.');
        }

        const result = await db.query(
            `SELECT * FROM client_user WHERE email = $1`, [email]
        );

        if (result.rows.length === 0) {
            throw new Error('No account found with this email address.');
        }

        const user = new ClientUser(result.rows[0]);
        const isPasswordValid = await bcrypt.compare(password, user.password_hash);

        if (!isPasswordValid) {
            throw new Error('Incorrect password. Please try again.');
        }

        const userResponse = { ...user };
        delete userResponse.password_hash;

        return userResponse;
    }

    async loginOperationalUser(loginData) {
        const { email, password } = loginData;

        if (!email || !password) {
            throw new Error('Please provide your email and password.');
        }

        const result = await db.query(
            `SELECT * FROM operational_user WHERE email = $1`, [email]
        );

        if (result.rows.length === 0) {
            throw new Error('No account found with this email address.');
        }

        const user = new OperationalUser(result.rows[0]);
        const isPasswordValid = await bcrypt.compare(password, user.password_hash);

        if (!isPasswordValid) {
            throw new Error('Incorrect password. Please try again.');
        }

        const userResponse = { ...user };
        delete userResponse.password_hash;

        return userResponse;
    }

    async loginUser(loginData) {
        const { email, password } = loginData;

        if (!email || !password) {
            throw new Error('Please provide your email and password.');
        }

        let result = await db.query(
            `SELECT *, 'client' as user_type FROM client_user WHERE email = $1`, [email]
        );

        if (result.rows.length === 0) {
            result = await db.query(
                `SELECT *, 'operational' as user_type FROM operational_user WHERE email = $1`, [email]
            );
        }

        if (result.rows.length === 0) {
            throw new Error('No account found with this email address. Please check and try again.');
        }

        const userData = result.rows[0];
        const user = userData.user_type === 'client'
            ? new ClientUser(userData)
            : new OperationalUser(userData);

        const isPasswordValid = await bcrypt.compare(password, user.password_hash);
        if (!isPasswordValid) {
            throw new Error('Incorrect password. Please try again.');
        }

        const userResponse = { ...user };
        delete userResponse.password_hash;
        userResponse.user_type = userData.user_type;

        return userResponse;
    }
}

module.exports = new AuthService();