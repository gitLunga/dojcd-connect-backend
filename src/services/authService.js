const db = require('../config/db');
const bcrypt = require('bcrypt');
const ClientUser = require('../models/ClientUser');
const OperationalUser = require('../models/OperationalUser');
const storage = require('../config/supabaseStorage'); // ← Supabase Storage (replaces local disk)

class AuthService {


    async registerUser(userData) {
        const {
            title, first_name, last_name, email, phone_number, region, persal_id,
            department_id, user_type, password
        } = userData; // NO network_provider, contract, invoice

        if (!first_name || !last_name || !email || !password || !persal_id) {
            throw new Error('Required fields missing');
        }

        // Check email and persal_id duplicates as before...
        const hashedPassword = await bcrypt.hash(password, 10);

        // Insert demographics only
        const query = `
            INSERT INTO client_user (title, first_name, last_name, email, phone_number,
                                     region, persal_id, department_id, user_type,
                                     password_hash, registration_status)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'Pending') RETURNING *;
        `;
        const values = [
            title, first_name, last_name, email, phone_number,
            region, persal_id, department_id, user_type, hashedPassword
        ];

        const result = await db.query(query, values);
        const user = new ClientUser(result.rows[0]);
        const userResponse = {...user};
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

    // ── completeProfile — uploads all files to Supabase Storage ────────────
    async completeProfile(clientUserId, profileData, files) {
        const {network_provider, contract_duration_months, contract_end_date} = profileData;

        if (!network_provider || !contract_duration_months || !contract_end_date) {
            throw new Error('All profile fields are required');
        }

        const uploadedPaths = []; // Track uploads so we can clean up if DB write fails

        await db.query('BEGIN');
        try {
            // 1. Upload invoice to Supabase Storage
            let invoicePath = null;
            if (files.invoice_file) {
                const invoiceFile = Array.isArray(files.invoice_file) ? files.invoice_file[0] : files.invoice_file;
                invoicePath = await storage.uploadFile(
                    invoiceFile.buffer, invoiceFile.mimetype,
                    'invoices', 'invoice', clientUserId
                );
                uploadedPaths.push(invoicePath);
            }

            // 2. Update user profile row
            const userResult = await db.query(
                `UPDATE client_user
                 SET network_provider         = $1,
                     contract_duration_months = $2,
                     contract_end_date        = $3,
                     invoice_path             = $4,
                     registration_status      = 'Profile_Completed',
                     updated_at               = CURRENT_TIMESTAMP
                 WHERE client_user_id = $5 RETURNING *`,
                [network_provider, contract_duration_months, contract_end_date, invoicePath, clientUserId]
            );

            // 3. Upload and record each document
            const savedDocuments = [];

            const docDefs = [
                {key: 'id_document', type: 'ID', prefix: 'id'},
                {key: 'payslip_document', type: 'Payslip', prefix: 'payslip'},
                {key: 'residence_document', type: 'Proof_of_Residence', prefix: 'residence'},
            ];

            for (const def of docDefs) {
                if (!files[def.key]) continue;

                const file = Array.isArray(files[def.key]) ? files[def.key][0] : files[def.key];
                const savedPath = await storage.uploadFile(
                    file.buffer, file.mimetype,
                    'documents', def.prefix, clientUserId
                );
                uploadedPaths.push(savedPath);

                const docResult = await db.query(
                    `INSERT INTO document (client_user_id, document_type, s3_path, document_status)
                     VALUES ($1, $2, $3, 'Pending') RETURNING document_id, document_type, s3_path`,
                    [clientUserId, def.type, savedPath]
                );
                savedDocuments.push(docResult.rows[0]);
            }

            await db.query('COMMIT');

            return {
                success: true,
                user: userResult.rows[0],
                documents: savedDocuments,
                message: 'Profile completed successfully',
            };

        } catch (error) {
            await db.query('ROLLBACK');
            // Best-effort: remove any files already uploaded so storage stays clean
            for (const p of uploadedPaths) {
                await storage.deleteFile(p).catch(() => {
                });
            }
            console.error('Profile completion error:', error);
            throw error;
        }
    }

    // handleInvoiceUpload removed — files now go directly to Supabase Storage


    async registerOperationalUser(userData) {
        const {title, first_name, last_name, email, user_role, password} = userData;

        // Check if email already exists
        const emailCheck = await db.query(
            `SELECT *
             FROM operational_user
             WHERE email = $1`,
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
            VALUES ($1, $2, $3, $4, $5, $6) RETURNING *;
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
        const userResponse = {...user};
        delete userResponse.password_hash;

        return userResponse;
    }

    // Login Client User
    async loginClientUser(loginData) {
        const {email, password} = loginData;

        // Find user by email
        const result = await db.query(
            `SELECT *
             FROM client_user
             WHERE email = $1`,
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
        const userResponse = {...user};
        delete userResponse.password_hash;

        return userResponse;
    }

    // Login Operational User
    async loginOperationalUser(loginData) {
        const {email, password} = loginData;

        // Find user by email
        const result = await db.query(
            `SELECT *
             FROM operational_user
             WHERE email = $1`,
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
        const userResponse = {...user};
        delete userResponse.password_hash;

        return userResponse;
    }

    // Generic login that tries both tables
    async loginUser(loginData) {
        const {email, password} = loginData;

        // Try client_user first
        let result = await db.query(
            `SELECT *, 'client' as user_type
             FROM client_user
             WHERE email = $1`,
            [email]
        );

        // If not found in client_user, try operational_user
        if (result.rows.length === 0) {
            result = await db.query(
                `SELECT *, 'operational' as user_type
                 FROM operational_user
                 WHERE email = $1`,
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
        const userResponse = {...user};
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