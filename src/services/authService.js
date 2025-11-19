const db = require('../config/db');
const bcrypt = require('bcrypt');
const ClientUser = require('../models/ClientUser');
const OperationalUser = require('../models/OperationalUser');

class AuthService {
    // Register new ClientUser
    async registerUser(userData) {
        const { first_name, last_name, email, phone_number, persal_id,
            department_id, user_type, password } = userData;

        // Check if email already exists
        const emailCheck = await db.query(
            `SELECT * FROM client_user WHERE email = $1`,
            [email]
        );
        if (emailCheck.rows.length > 0) {
            throw new Error('Email already registered');
        }

        // Hash password
        const hashedPassword = await bcrypt.hash(password, 10);

        // Insert into database
        const query = `
            INSERT INTO client_user
            (first_name, last_name, email, phone_number, persal_id, department_id, user_type, password_hash)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                RETURNING *;
        `;
        const values = [
            first_name,
            last_name,
            email,
            phone_number,
            persal_id,
            department_id,
            user_type,
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
        const validRoles = ['Admin', 'MTN_Staff', 'Warehouse', 'Support'];
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

module.exports = new AuthService();