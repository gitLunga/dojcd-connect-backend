const db = require('../config/db');
const bcrypt = require('bcrypt');
const ClientUser = require('../models/ClientUser');
const OperationalUser = require('../models/OperationalUser');
const path = require('path');
const fs = require('fs');
const multer = require('multer'); // Added for file uploads

class AuthService {


    async registerUser(userData) {
        const { title, first_name, last_name, email, phone_number, region, persal_id,
            department_id, user_type, password } = userData; // NO network_provider, contract, invoice

        if (!first_name || !last_name || !email || !password || !persal_id) {
            throw new Error('Required fields missing');
        }

        // Check email and persal_id duplicates as before...
        const hashedPassword = await bcrypt.hash(password, 10);

        // Insert demographics only
        const query = `
        INSERT INTO client_user (
            title, first_name, last_name, email, phone_number,
            region, persal_id, department_id, user_type,
            password_hash, registration_status
        )
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'Pending')
        RETURNING *;
    `;
        const values = [
            title, first_name, last_name, email, phone_number,
            region, persal_id, department_id, user_type, hashedPassword
        ];

        const result = await db.query(query, values);
        const user = new ClientUser(result.rows[0]);
        const userResponse = { ...user };
        delete userResponse.password_hash;

        return userResponse;
    }

    // async completeProfile(clientUserId, profileData, invoiceFile) {
    //     const { network_provider, contract_duration_months, contract_end_date } = profileData;
    //
    //     if (!network_provider || !contract_duration_months || !contract_end_date) {
    //         throw new Error('All profile fields are required');
    //     }
    //
    //     let invoicePath = null;
    //
    //     // Handle invoice file if uploaded
    //     if (invoiceFile?.filename) {
    //         invoicePath = `/uploads/invoices/${invoiceFile.filename}`;
    //
    //
    //         console.log('📁 Invoice file received:', invoiceFile);
    //         console.log('📁 Original name:', invoiceFile.originalname);
    //         console.log('📁 File details:', {
    //             fieldname: invoiceFile.fieldname,
    //             filename: invoiceFile.filename,
    //             path: invoiceFile.path,
    //             size: invoiceFile.size,
    //             mimetype: invoiceFile.mimetype
    //         });
    //
    //         try {
    //             // Create uploads/invoices directory if it doesn't exist
    //             const uploadDir = path.join(__dirname, '../uploads/invoices');
    //             if (!fs.existsSync(uploadDir)) {
    //                 fs.mkdirSync(uploadDir, { recursive: true });
    //                 console.log('✅ Created directory:', uploadDir);
    //             }
    //
    //             // Get file extension
    //             const ext = path.extname(invoiceFile.originalname) ||
    //                 (invoiceFile.mimetype === 'application/pdf' ? '.pdf' :
    //                     invoiceFile.mimetype === 'image/jpeg' ? '.jpg' :
    //                         invoiceFile.mimetype === 'image/png' ? '.png' : '.bin');
    //
    //             // Generate unique filename
    //             const uniqueFilename = `invoice_${clientUserId}_${Date.now()}${ext}`;
    //             const finalPath = path.join(uploadDir, uniqueFilename);
    //
    //             console.log('📁 Final path to save:', finalPath);
    //
    //             // Check if file exists in temp location
    //             if (invoiceFile.path && fs.existsSync(invoiceFile.path)) {
    //                 // Move file from temp to permanent location
    //                 fs.renameSync(invoiceFile.path, finalPath);
    //                 console.log('✅ File moved from temp to:', finalPath);
    //             } else if (invoiceFile.buffer) {
    //                 // File is in memory buffer
    //                 fs.writeFileSync(finalPath, invoiceFile.buffer);
    //                 console.log('✅ File saved from buffer to:', finalPath);
    //             } else {
    //                 throw new Error('No file data found');
    //             }
    //
    //             // Verify file was saved
    //             if (fs.existsSync(finalPath)) {
    //                 const stats = fs.statSync(finalPath);
    //                 console.log('✅ File saved successfully. Size:', stats.size, 'bytes');
    //             } else {
    //                 throw new Error('File was not saved');
    //             }
    //
    //             // Store relative path for web access
    //             // IMPORTANT: This path should match what getClientInvoice expects
    //             invoicePath = `/uploads/invoices/${uniqueFilename}`;
    //             console.log('📝 Path to store in DB:', invoicePath);
    //
    //         } catch (error) {
    //             console.error('❌ Error saving invoice file:', error);
    //             throw new Error(`Failed to save invoice file: ${error.message}`);
    //         }
    //     }
    //
    //     // Update the database
    //     const query = `
    //         UPDATE client_user
    //         SET
    //             network_provider = $1,
    //             contract_duration_months = $2,
    //             contract_end_date = $3,
    //             invoice_path = $4,
    //             registration_status = 'Profile_Completed',
    //             updated_at = CURRENT_TIMESTAMP
    //         WHERE client_user_id = $5
    //             RETURNING *;
    //     `;
    //
    //     const values = [
    //         network_provider,
    //         contract_duration_months,
    //         contract_end_date,
    //         invoicePath,
    //         clientUserId
    //     ];
    //
    //     console.log('📝 Saving to database with values:', values);
    //
    //     const result = await db.query(query, values);
    //
    //     console.log('✅ Profile completed successfully for user:', clientUserId);
    //     console.log('📁 Invoice path in database:', result.rows[0].invoice_path);
    //
    //     return result.rows[0];
    // }

    async completeProfile(clientUserId, profileData, files) {
        const { network_provider, contract_duration_months, contract_end_date } = profileData;

        if (!network_provider || !contract_duration_months || !contract_end_date) {
            throw new Error('All profile fields are required');
        }

        // Start transaction
        await db.query('BEGIN');

        try {
            // 1. Handle invoice file
            let invoicePath = null;
            if (files.invoice_file) {
                const invoiceFile = Array.isArray(files.invoice_file) ? files.invoice_file[0] : files.invoice_file;
                invoicePath = await this.saveFile(invoiceFile, 'invoices', clientUserId, 'invoice');
            }

            // 2. Update user profile
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

            const updateValues = [
                network_provider,
                contract_duration_months,
                contract_end_date,
                invoicePath,
                clientUserId
            ];

            const userResult = await db.query(updateQuery, updateValues);

            // 3. Save documents (ID, Payslip, Proof of Residence)
            const savedDocuments = [];

            // Save ID Document
            if (files.id_document) {
                const idFile = Array.isArray(files.id_document) ? files.id_document[0] : files.id_document;
                const savedPath = await this.saveFile(idFile, 'documents', clientUserId, 'id');

                const docResult = await db.query(
                    `INSERT INTO document 
                     (client_user_id, document_type, s3_path, document_status)
                     VALUES ($1, $2, $3, 'Pending')
                     RETURNING document_id, document_type, s3_path`,
                    [clientUserId, 'ID', savedPath]
                );

                savedDocuments.push(docResult.rows[0]);
            }

            // Save Payslip Document
            if (files.payslip_document) {
                const payslipFile = Array.isArray(files.payslip_document) ? files.payslip_document[0] : files.payslip_document;
                const savedPath = await this.saveFile(payslipFile, 'documents', clientUserId, 'payslip');

                const docResult = await db.query(
                    `INSERT INTO document 
                     (client_user_id, document_type, s3_path, document_status)
                     VALUES ($1, $2, $3, 'Pending')
                     RETURNING document_id, document_type, s3_path`,
                    [clientUserId, 'Payslip', savedPath]
                );

                savedDocuments.push(docResult.rows[0]);
            }

            // Save Proof of Residence Document (Optional)
            if (files.residence_document) {
                const residenceFile = Array.isArray(files.residence_document) ? files.residence_document[0] : files.residence_document;
                const savedPath = await this.saveFile(residenceFile, 'documents', clientUserId, 'residence');

                const docResult = await db.query(
                    `INSERT INTO document 
                     (client_user_id, document_type, s3_path, document_status)
                     VALUES ($1, $2, $3, 'Pending')
                     RETURNING document_id, document_type, s3_path`,
                    [clientUserId, 'Proof_of_Residence', savedPath]
                );

                savedDocuments.push(docResult.rows[0]);
            }

            // Commit transaction
            await db.query('COMMIT');

            return {
                success: true,
                user: userResult.rows[0],
                documents: savedDocuments,
                message: 'Profile completed successfully'
            };

        } catch (error) {
            // Rollback on error
            await db.query('ROLLBACK');
            console.error('Profile completion error:', error);
            throw error;
        }
    }

    // Helper function to save files
    async saveFile(file, folder, clientUserId, prefix) {
        const uploadDir = path.join(__dirname, `../uploads/${folder}`);

        if (!fs.existsSync(uploadDir)) {
            fs.mkdirSync(uploadDir, { recursive: true });
        }

        // Get file extension
        let ext = path.extname(file.originalname);
        if (!ext) {
            // Determine extension from mimetype
            if (file.mimetype === 'application/pdf') ext = '.pdf';
            else if (file.mimetype === 'image/jpeg') ext = '.jpg';
            else if (file.mimetype === 'image/png') ext = '.png';
            else ext = '.bin';
        }

        const uniqueFilename = `${prefix}_${clientUserId}_${Date.now()}${ext}`;
        const finalPath = path.join(uploadDir, uniqueFilename);

        // Save the file
        if (file.path && fs.existsSync(file.path)) {
            fs.renameSync(file.path, finalPath);
        } else if (file.buffer) {
            fs.writeFileSync(finalPath, file.buffer);
        } else {
            throw new Error('No file data found');
        }

        return `/uploads/${folder}/${uniqueFilename}`;
    }

    // Optional: Keep handleInvoiceUpload if you need it for separate uploads
    async handleInvoiceUpload(file) {
        try {
            // Create uploads directory if it doesn't exist
            const uploadDir = path.join(__dirname, '../uploads/invoices');
            if (!fs.existsSync(uploadDir)) {
                fs.mkdirSync(uploadDir, { recursive: true });
            }

            // Generate unique filename
            const timestamp = Date.now();
            const uniqueFilename = `temp_invoice_${timestamp}_${Math.random().toString(36).substr(2, 9)}${path.extname(file.originalname)}`;
            const filePath = path.join(uploadDir, uniqueFilename);

            // Save the file
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
            throw new Error('Failed to upload invoice');
        }
    }


    async registerOperationalUser(userData) {
        const { title, first_name, last_name, email, user_role, password } = userData;

        // Check if email already exists
        const emailCheck = await db.query(
            `SELECT * FROM operational_user WHERE email = $1`,
            [email]
        );
        if (emailCheck.rows.length > 0) {
            throw new Error('Email already registered');
        }

        // Validate user_role
        const validRoles = ['Admin', 'MTN_Staff', 'Warehouse', 'Approver'];
        if (!validRoles.includes(user_role)) {
            throw new Error(`Invalid user role. Must be one of: ${validRoles.join(', ')}`);
        }

        // Hash password
        const hashedPassword = await bcrypt.hash(password, 10);

        // Insert into database
        const query = `
            INSERT INTO operational_user 
            (title, first_name, last_name, email, user_role, password_hash)
            VALUES ($1, $2, $3, $4, $5, $6)
            RETURNING *;
        `;
        const values = [
            title,
            first_name,
            last_name,
            email,
            user_role,
            hashedPassword
        ];

        const result = await db.query(query, values);

        if (result.rows.length === 0) {
            throw new Error('Operational user registration failed - no data returned');
        }

        // Create user instance with all returned data
        const user = new OperationalUser(result.rows[0]);

        // Remove password hash from response for security
        const userResponse = { ...user };
        delete userResponse.password_hash;

        return userResponse;
    }

    // Login Client User
    async loginClientUser(loginData) {
        const { email, password } = loginData;

        // Find user by email
        const result = await db.query(
            `SELECT * FROM client_user WHERE email = $1`,
            [email]
        );

        if (result.rows.length === 0) {
            throw new Error('Invalid email or password');
        }

        const user = new ClientUser(result.rows[0]);

        // Verify password
        const isPasswordValid = await bcrypt.compare(password, user.password_hash);
        if (!isPasswordValid) {
            throw new Error('Invalid email or password');
        }

        // Remove password hash from response
        const userResponse = { ...user };
        delete userResponse.password_hash;

        return userResponse;
    }

    // Login Operational User
    async loginOperationalUser(loginData) {
        const { email, password } = loginData;

        // Find user by email
        const result = await db.query(
            `SELECT * FROM operational_user WHERE email = $1`,
            [email]
        );

        if (result.rows.length === 0) {
            throw new Error('Invalid email or password');
        }

        const user = new OperationalUser(result.rows[0]);

        // Verify password
        const isPasswordValid = await bcrypt.compare(password, user.password_hash);
        if (!isPasswordValid) {
            throw new Error('Invalid email or password');
        }

        // Remove password hash from response
        const userResponse = { ...user };
        delete userResponse.password_hash;

        return userResponse;
    }

    // Generic login that tries both tables
    async loginUser(loginData) {
        const { email, password } = loginData;

        // Try client_user first
        let result = await db.query(
            `SELECT *, 'client' as user_type FROM client_user WHERE email = $1`,
            [email]
        );

        // If not found in client_user, try operational_user
        if (result.rows.length === 0) {
            result = await db.query(
                `SELECT *, 'operational' as user_type FROM operational_user WHERE email = $1`,
                [email]
            );
        }

        if (result.rows.length === 0) {
            throw new Error('Invalid email or password');
        }

        const userData = result.rows[0];
        let user;

        if (userData.user_type === 'client') {
            user = new ClientUser(userData);
        } else {
            user = new OperationalUser(userData);
        }

        // Verify password
        const isPasswordValid = await bcrypt.compare(password, user.password_hash);
        if (!isPasswordValid) {
            throw new Error('Invalid email or password');
        }

        // Remove password hash from response
        const userResponse = { ...user };
        delete userResponse.password_hash;

        // Add user_type to response
        userResponse.user_type = userData.user_type;

        return userResponse;
    }

}

function getMimeTypeFromExtension(extension) {
    const extToMime = {
        '.pdf': 'application/pdf',
        '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
        '.png': 'image/png', '.gif': 'image/gif',
        '.doc': 'application/msword',
        '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        '.xls': 'application/vnd.ms-excel',
        '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        '.txt': 'text/plain', '.csv': 'text/csv',
        '.webp': 'image/webp', '.svg': 'image/svg+xml',
    };
    return extToMime[extension.toLowerCase()] || 'application/octet-stream';
}

module.exports = new AuthService();