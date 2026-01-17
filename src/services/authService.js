const db = require('../config/db');
const bcrypt = require('bcrypt');
const ClientUser = require('../models/ClientUser');
const OperationalUser = require('../models/OperationalUser');
const path = require('path');
const fs = require('fs');
const multer = require('multer'); // Added for file uploads

class AuthService {
    // Register new ClientUser
    async registerUser(userData,  invoiceFile = null) {
        const { title, first_name, last_name, email, phone_number, region, persal_id,
            department_id, user_type, password,  network_provider,         // Add this
            contract_duration_months, // Add this
            contract_end_date,        // Add this
            invoice_data,             // Add this
            invoice_filename     } = userData;

        if (!title || !first_name || !last_name || !email || !password || !persal_id) {
            throw new Error('All required fields must be filled');
        }
        // Check if email already exists
        const emailCheck = await db.query(
            `SELECT * FROM client_user WHERE email = $1`,
            [email]
        );
        if (emailCheck.rows.length > 0) {
            throw new Error('Email already registered');
        }

        // Check if Persal ID already exists
        const persalCheck = await db.query(
            `SELECT * FROM client_user WHERE persal_id = $1`,
            [persal_id]
        );
        if (persalCheck.rows.length > 0) {
            throw new Error('ID already registered');
        }

        // Hash password
        const hashedPassword = await bcrypt.hash(password, 10);

        // Handle invoice file if uploaded
        let invoicePath = null;

        // FIXED: Simplified file handling
        if (invoiceFile) {
            console.log('📁 File received:', invoiceFile);

            // Multer already saved the file, just get the path
            // invoiceFile.path contains the full path where multer saved it
            // invoiceFile.filename contains just the filename

            if (invoiceFile.filename) {
                // Store relative path in database
                invoicePath = `/uploads/invoices/${invoiceFile.filename}`;
                console.log('✅ Invoice path stored:', invoicePath);
            } else {
                console.warn('⚠️ No filename in invoiceFile:', invoiceFile);
            }
        }

        // Insert into database
        const query = `
            INSERT INTO client_user (
                title, first_name, last_name, email, phone_number,
                region, persal_id, department_id, user_type,
                network_provider, contract_duration_months,
                contract_end_date, invoice_path, password_hash,
                registration_status
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, 'Pending')
                RETURNING *;
        `;

        const values = [
            title,
            first_name,
            last_name,
            email,
            phone_number,
            region,
            persal_id,
            department_id,
            user_type,
            network_provider,
            contract_duration_months,
            contract_end_date,
            invoicePath,
            hashedPassword
        ];


        const result = await db.query(query, values);

        if (result.rows.length === 0) {
            throw new Error('Registration failed - no data returned');
        }

        // Create user instance with all returned data
        const user = new ClientUser(result.rows[0]);

        // Remove password hash from response for security
        const userResponse = { ...user };
        delete userResponse.password_hash;

        return userResponse;
    }


    async handleInvoiceUpload(file) {
        try {
            // Create uploads directory if it doesn't exist
            const uploadDir = path.join(__dirname, '../uploads/temp');
            if (!fs.existsSync(uploadDir)) {
                fs.mkdirSync(uploadDir, { recursive: true });
            }

            // Generate unique filename
            const timestamp = Date.now();
            const uniqueFilename = `temp_invoice_${timestamp}_${Math.random().toString(36).substr(2, 9)}`;
            const tempPath = path.join(uploadDir, uniqueFilename);

            // Move uploaded file (FormData file is already on disk)
            fs.renameSync(file.path, tempPath);

            return {
                success: true,
                tempPath: tempPath,
                filename: file.originalname,
                mimeType: file.mimetype
            };

        } catch (error) {
            console.error('Upload error:', error);
            throw new Error('Failed to upload invoice');
        }
    }

    // Helper to serve invoice files
    // async getInvoiceFile(filename, isTemp = false) {
    //     const folder = isTemp ? 'temp' : 'invoices';
    //     const filePath = path.join(__dirname, `../uploads/${folder}/${filename}`);
    //
    //     if (!fs.existsSync(filePath)) {
    //         throw new Error('File not found');
    //     }
    //
    //     return {
    //         path: filePath,
    //         stats: fs.statSync(filePath),
    //         mimeType: getMimeTypeFromExtension(path.extname(filename))
    //     };
    // }


    async registerOperationalUser(userData) {
        const { first_name, last_name, email, user_role, password } = userData;

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
            (first_name, last_name, email, user_role, password_hash)
            VALUES ($1, $2, $3, $4, $5)
            RETURNING *;
        `;
        const values = [
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