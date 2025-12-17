const db = require('../config/db');
const ClientUser = require('../models/ClientUser');
const OperationalUser = require('../models/OperationalUser');

class AdminService {
    /**
     * Fetch all users: clients + operational
     */
    async getAllUsers() {
        try {
            const query = `
                SELECT
                    client_user_id AS id,
                    'client' AS user_type,
                    NULL AS user_role,
                    title,
                    first_name,
                    last_name,
                    email,
                    phone_number,
                    region,
                    persal_id,
                    department_id,
                    registration_status,
                    created_at
                FROM client_user

                UNION ALL

                SELECT
                    operational_user_id AS id,
                    'operational' AS user_type,
                    user_role,
                    title,
                    first_name,
                    last_name,
                    email,
                    phone_number,
                    region,
                    NULL AS persal_id,
                    department_id,
                    registration_status,
                    created_at
                FROM operational_user

                ORDER BY created_at DESC;
            `;

            const result = await db.query(query);
            return result.rows;
        } catch (error) {
            console.error('❌ AdminService.getAllUsers error:', error);
            throw new Error('Failed to fetch all users');
        }
    }
}

module.exports = new AdminService();
