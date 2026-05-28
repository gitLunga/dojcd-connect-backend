const db = require('../config/db');
const bcrypt = require('bcrypt');
const ClientUser = require('../models/ClientUser');
const OperationalUser = require('../models/OperationalUser');
const storage = require('../config/localStorage');
const tokenService = require('./tokenService');

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

        const accessToken  = tokenService.generateAccessToken(userResponse.client_user_id, 'Client');
        const refreshToken = await tokenService.generateRefreshToken(userResponse.client_user_id, 'Client');

        return { user: userResponse, accessToken, refreshToken };
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
    // authService.js - FIXED completeProfile

    async completeProfile(clientUserId, profileData, files) {
        const { network_provider, contract_duration_months, contract_end_date } = profileData;

        if (!network_provider || !contract_duration_months || !contract_end_date) {
            throw new Error('All profile fields are required');
        }

        console.log(`\n🔄 Starting profile completion for user ${clientUserId}`);

        const uploadedPaths = [];

        try {
            // ✅ START TRANSACTION
            console.log('📊 Starting database transaction...');
            await db.query('BEGIN');

            // ✅ 1. Upload invoice
            console.log('📄 Processing invoice file...');
            let invoicePath = null;
            if (files.invoice_file) {
                const invoiceFile = Array.isArray(files.invoice_file)
                    ? files.invoice_file[0]
                    : files.invoice_file;

                try {
                    invoicePath = await storage.uploadFile(
                        invoiceFile.buffer,
                        invoiceFile.mimetype,
                        'invoices',
                        'invoice',
                        clientUserId
                    );
                    uploadedPaths.push(invoicePath);
                    console.log(`✅ Invoice uploaded: ${invoicePath}`);
                } catch (err) {
                    throw new Error(`Failed to upload invoice: ${err.message}`);
                }
            }

            // ✅ 2. Update user profile
            console.log('👤 Updating user profile...');
            let userResult;
            try {
                userResult = await db.query(
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

                if (userResult.rows.length === 0) {
                    throw new Error(`User ${clientUserId} not found`);
                }

                console.log(`✅ User profile updated for user ${clientUserId}`);
            } catch (err) {
                throw new Error(`Failed to update user profile: ${err.message}`);
            }

            // ✅ 3. Upload and record documents
            console.log('📋 Processing documents...');
            const savedDocuments = [];
            const docDefs = [
                { key: 'id_document', type: 'ID', prefix: 'id', required: true },
                { key: 'payslip_document', type: 'Payslip', prefix: 'payslip', required: true },
                { key: 'residence_document', type: 'Proof_of_Residence', prefix: 'residence', required: false },
            ];

            for (const def of docDefs) {
                // ✅ VALIDATE required documents
                if (!files[def.key]) {
                    if (def.required) {
                        throw new Error(`${def.key} is required`);
                    }
                    console.log(`⏭️  Skipping ${def.key} (not provided)`);
                    continue;
                }

                try {
                    const file = Array.isArray(files[def.key])
                        ? files[def.key][0]
                        : files[def.key];

                    // ✅ UPLOAD FILE TO DISK
                    console.log(`   📁 Uploading ${def.type}...`);
                    const savedPath = await storage.uploadFile(
                        file.buffer,
                        file.mimetype,
                        'documents',
                        def.prefix,
                        clientUserId
                    );
                    uploadedPaths.push(savedPath);
                    console.log(`   ✅ File uploaded: ${savedPath}`);

                    // ✅ INSERT INTO DATABASE
                    console.log(`   💾 Inserting ${def.type} record into database...`);
                    const docResult = await db.query(
                        `INSERT INTO document 
                     (client_user_id, document_type, s3_path, document_status, upload_date)
                     VALUES ($1, $2, $3, 'Pending', CURRENT_TIMESTAMP) 
                     RETURNING document_id, document_type, s3_path, upload_date`,
                        [clientUserId, def.type, savedPath]
                    );

                    if (docResult.rows.length === 0) {
                        throw new Error(`Failed to insert ${def.type} record`);
                    }

                    const docRecord = docResult.rows[0];
                    savedDocuments.push(docRecord);
                    console.log(`   ✅ ${def.type} record inserted (ID: ${docRecord.document_id})`);

                } catch (err) {
                    console.error(`❌ Error processing ${def.type}:`, err.message);
                    throw new Error(`Failed to process ${def.type}: ${err.message}`);
                }
            }

            // ✅ COMMIT TRANSACTION
            console.log('✅ Committing transaction...');
            await db.query('COMMIT');
            console.log(`✅ Profile completed successfully for user ${clientUserId}\n`);

            return {
                success: true,
                user: userResult.rows[0],
                documents: savedDocuments,
                message: 'Profile completed successfully',
            };

        } catch (error) {
            // ✅ ROLLBACK ON ANY ERROR
            console.error(`❌ Error in completeProfile: ${error.message}`);
            console.log('🔄 Rolling back transaction...');

            try {
                await db.query('ROLLBACK');
                console.log('✅ Transaction rolled back');
            } catch (rollbackErr) {
                console.error('❌ Rollback failed:', rollbackErr.message);
            }

            // ✅ CLEANUP UPLOADED FILES
            console.log(`🗑️  Cleaning up ${uploadedPaths.length} uploaded file(s)...`);
            for (const p of uploadedPaths) {
                try {
                    await storage.deleteFile(p);
                    console.log(`   ✅ Deleted: ${p}`);
                } catch (delErr) {
                    console.warn(`   ⚠️  Could not delete ${p}: ${delErr.message}`);
                }
            }

            console.error(`\n`);
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
        const validRoles = ['Admin', 'MTN_Staff', 'Approver', 'Manager', 'Finance'];
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

        const result = await db.query(
            `SELECT * FROM client_user WHERE email = $1`,
            [email]
        );

        if (result.rows.length === 0) throw new Error('Invalid email or password');

        const user = new ClientUser(result.rows[0]);

        const isPasswordValid = await bcrypt.compare(password, user.password_hash);
        if (!isPasswordValid) throw new Error('Invalid email or password');

        const userResponse = {...user};
        delete userResponse.password_hash;

        const accessToken  = tokenService.generateAccessToken(userResponse.client_user_id, 'Client');
        const refreshToken = await tokenService.generateRefreshToken(userResponse.client_user_id, 'Client');

        return { user: userResponse, accessToken, refreshToken };
    }

    // Login Operational User
    async loginOperationalUser(loginData) {
        const {email, password} = loginData;

        const result = await db.query(
            `SELECT * FROM operational_user WHERE email = $1 AND is_deleted = false`,
            [email]
        );

        if (result.rows.length === 0) throw new Error('Invalid email or password');

        const user = new OperationalUser(result.rows[0]);

        const isPasswordValid = await bcrypt.compare(password, user.password_hash);
        if (!isPasswordValid) throw new Error('Invalid email or password');

        const userResponse = {...user};
        delete userResponse.password_hash;
        userResponse.name = `${user.first_name} ${user.last_name}`.trim();

        const accessToken  = tokenService.generateAccessToken(userResponse.op_user_id, 'Operational', userResponse.user_role);
        const refreshToken = await tokenService.generateRefreshToken(userResponse.op_user_id, 'Operational');

        return { user: userResponse, accessToken, refreshToken };
    }

    // Generic login that tries both tables
    async loginUser(loginData) {
        const {email, password} = loginData;

        let result = await db.query(
            `SELECT *, 'client' as table_type FROM client_user WHERE email = $1`,
            [email]
        );

        if (result.rows.length === 0) {
            result = await db.query(
                `SELECT *, 'operational' as table_type FROM operational_user WHERE email = $1 AND is_deleted = false`,
                [email]
            );
        }

        if (result.rows.length === 0) throw new Error('Invalid email or password');

        const userData = result.rows[0];
        let user;
        let userType;
        let userId;
        let role = null;

        if (userData.table_type === 'client') {
            user = new ClientUser(userData);
            userType = 'Client';
            userId = user.client_user_id;
        } else {
            user = new OperationalUser(userData);
            userType = 'Operational';
            userId = user.op_user_id;
            role = user.user_role;
        }

        const isPasswordValid = await bcrypt.compare(password, user.password_hash);
        if (!isPasswordValid) throw new Error('Invalid email or password');

        const userResponse = {...user};
        delete userResponse.password_hash;
        delete userResponse.table_type;

        const accessToken  = tokenService.generateAccessToken(userId, userType, role);
        const refreshToken = await tokenService.generateRefreshToken(userId, userType);

        return { user: userResponse, accessToken, refreshToken };
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
