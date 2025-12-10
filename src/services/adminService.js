const db = require('../config/db');

class AdminService {
    // Get all client users
    async getAllClientUsers() {
        try {
            const result = await db.query(
                `SELECT 
                    client_user_id,
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
                    registration_status,
                    verification_notes
                 FROM client_user 
                 ORDER BY created_at DESC`,
                []
            );

            return result.rows;
        } catch (error) {
            throw new Error(`Error fetching client users: ${error.message}`);
        }
    }

    // Get client user by ID
    async getClientUserById(userId) {
        try {
            const result = await db.query(
                `SELECT 
                    client_user_id,
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
                    registration_status,
                    verification_notes
                 FROM client_user 
                 WHERE client_user_id = $1`,
                [userId]
            );

            if (result.rows.length === 0) {
                throw new Error('Client user not found');
            }

            return result.rows[0];
        } catch (error) {
            throw new Error(`Error fetching client user: ${error.message}`);
        }
    }

    // Get all operational users
    async getAllOperationalUsers() {
        try {
            const result = await db.query(
                `SELECT 
                    op_user_id,
                    first_name,
                    last_name,
                    email,
                    user_role
                 FROM operational_user 
                 ORDER BY created_at DESC`,
                []
            );

            return result.rows;
        } catch (error) {
            throw new Error(`Error fetching operational users: ${error.message}`);
        }
    }

    // Get operational user by ID
    async getOperationalUserById(userId) {
        try {
            const result = await db.query(
                `SELECT 
                    op_user_id,
                    first_name,
                    last_name,
                    email,
                    user_role
                 FROM operational_user 
                 WHERE op_user_id = $1`,
                [userId]
            );

            if (result.rows.length === 0) {
                throw new Error('Operational user not found');
            }

            return result.rows[0];
        } catch (error) {
            throw new Error(`Error fetching operational user: ${error.message}`);
        }
    }
    async updateUserRegistrationStatus(userId, status, notes) {
        try {
            const result = await db.query(
                `UPDATE client_user 
                 SET registration_status = $1, 
                     verification_notes = $2,
                     updated_at = CURRENT_TIMESTAMP
                 WHERE client_user_id = $3
                 RETURNING 
                    client_user_id,
                    first_name,
                    last_name,
                    email,
                    registration_status,
                    verification_notes`,
                [status, notes, userId]
            );

            if (result.rows.length === 0) {
                throw new Error('User not found');
            }

            return result.rows[0];
        } catch (error) {
            throw new Error(`Error updating user status: ${error.message}`);
        }
    }

    // Get user statistics
    async getUserStatistics() {
        try {
            // Client user statistics
            const clientStats = await db.query(
                `SELECT 
                    registration_status,
                    COUNT(*) as count
                 FROM client_user 
                 GROUP BY registration_status`
            );

            // Operational user statistics
            const operationalStats = await db.query(
                `SELECT 
                    user_role,
                    COUNT(*) as count
                 FROM operational_user 
                 GROUP BY user_role`
            );

            // Total counts
            const totalClients = await db.query(
                `SELECT COUNT(*) as total FROM client_user`
            );

            const totalOperational = await db.query(
                `SELECT COUNT(*) as total FROM operational_user`
            );

            return {
                client_users: {
                    stats: clientStats.rows,
                    total: parseInt(totalClients.rows[0].total)
                },
                operational_users: {
                    stats: operationalStats.rows,
                    total: parseInt(totalOperational.rows[0].total)
                },
                total_users: parseInt(totalClients.rows[0].total) + parseInt(totalOperational.rows[0].total)
            };
        } catch (error) {
            throw new Error(`Error fetching statistics: ${error.message}`);
        }
    }

    // Get recent registrations (last 7 days)
    async getRecentRegistrations() {
        try {
            const result = await db.query(
                `SELECT 
                    'client' as user_type,
                    client_user_id as id,
                    first_name,
                    last_name,
                    email,
                    registration_status,
                    created_at
                 FROM client_user 
                 WHERE created_at >= NOW() - INTERVAL '7 days'
                 
                 UNION ALL
                 
                 SELECT 
                    'operational' as user_type,
                    op_user_id as id,
                    first_name,
                    last_name,
                    email,
                    'Verified' as registration_status,
                    created_at
                 FROM operational_user 
                 WHERE created_at >= NOW() - INTERVAL '7 days'
                 
                 ORDER BY created_at DESC
                 LIMIT 20`
            );

            return result.rows;
        } catch (error) {
            throw new Error(`Error fetching recent registrations: ${error.message}`);
        }
    }

    // Search users by name, email, or persal_id
    async searchUsers(searchTerm) {
        try {
            const result = await db.query(
                `SELECT 
                    'client' as user_type,
                    client_user_id as id,
                    first_name,
                    last_name,
                    email,
                    phone_number,
                    persal_id,
                    registration_status,
                    user_type as client_user_type
                 FROM client_user 
                 WHERE 
                    first_name ILIKE $1 OR
                    last_name ILIKE $1 OR
                    email ILIKE $1 OR
                    persal_id ILIKE $1
                 
                 UNION ALL
                 
                 SELECT 
                    'operational' as user_type,
                    op_user_id as id,
                    first_name,
                    last_name,
                    email,
                    NULL as phone_number,
                    NULL as persal_id,
                    'Verified' as registration_status,
                    user_role as client_user_type
                 FROM operational_user 
                 WHERE 
                    first_name ILIKE $1 OR
                    last_name ILIKE $1 OR
                    email ILIKE $1
                 
                 ORDER BY last_name, first_name
                 LIMIT 50`,
                [`%${searchTerm}%`]
            );

            return result.rows;
        } catch (error) {
            throw new Error(`Error searching users: ${error.message}`);
        }
    }

    // Get user activity summary (applications, orders, etc.)
    async getUserActivitySummary() {
        try {
            const [applicationsByUser, ordersByUser, activeContracts] = await Promise.all([
                // Applications per user
                db.query(`
                    SELECT 
                        cu.client_user_id,
                        cu.first_name,
                        cu.last_name,
                        COUNT(a.application_id) as application_count
                    FROM client_user cu
                    LEFT JOIN application a ON cu.client_user_id = a.client_user_id
                    GROUP BY cu.client_user_id
                    ORDER BY application_count DESC
                    LIMIT 10
                `),

                // Orders per user
                db.query(`
                    SELECT 
                        cu.client_user_id,
                        cu.first_name,
                        cu.last_name,
                        COUNT(o.order_id) as order_count
                    FROM client_user cu
                    LEFT JOIN application a ON cu.client_user_id = a.client_user_id
                    LEFT JOIN "order" o ON a.application_id = o.application_id
                    WHERE o.order_status = 'Delivered'
                    GROUP BY cu.client_user_id
                    ORDER BY order_count DESC
                    LIMIT 10
                `),

                // Active contracts count
                db.query(`
                    SELECT COUNT(*) as active_contracts 
                    FROM contract c
                    JOIN "order" o ON c.order_id = o.order_id
                    WHERE o.order_status = 'Delivered'
                `)
            ]);

            return {
                top_applicants: applicationsByUser.rows,
                top_ordered_users: ordersByUser.rows,
                active_contracts: parseInt(activeContracts.rows[0].active_contracts)
            };
        } catch (error) {
            throw new Error(`Error fetching activity summary: ${error.message}`);
        }
    }
}

module.exports = new AdminService();