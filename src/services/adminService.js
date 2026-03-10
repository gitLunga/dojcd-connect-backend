const db = require('../config/db');
const path = require('path');
const storage = require('../config/supabaseStorage');


class AdminService {
    async getClientInvoice(userId) {
        const result = await db.query(
            `SELECT invoice_path, first_name, last_name FROM client_user WHERE client_user_id = $1`,
            [userId]
        );
        if (result.rows.length === 0 || !result.rows[0].invoice_path) {
            throw new Error('Invoice not found for this user');
        }
        const storagePath = result.rows[0].invoice_path;
        const { buffer, contentType } = await storage.downloadFile(storagePath);
        return {
            buffer,
            mimeType: contentType || storage.getMimeFromPath(storagePath),
            fileName: `invoice_${result.rows[0].first_name}_${result.rows[0].last_name}${path.extname(storagePath)}`,
        };
    }

    async downloadInvoice(userId, res) {
        const invoiceInfo = await this.getClientInvoice(userId);
        res.setHeader('Content-Disposition', `attachment; filename="${invoiceInfo.fileName}"`);
        res.setHeader('Content-Type', invoiceInfo.mimeType);
        res.setHeader('Content-Length', invoiceInfo.buffer.length);
        res.end(invoiceInfo.buffer);
    }

    // Helper method to get MIME type
    getMimeType(filePath) {
        const ext = path.extname(filePath).toLowerCase();
        const mimeTypes = {
            '.pdf': 'application/pdf',
            '.jpg': 'image/jpeg',
            '.jpeg': 'image/jpeg',
            '.png': 'image/png',
            '.doc': 'application/msword',
            '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
        };

        return mimeTypes[ext] || 'application/octet-stream';
    }

    //Sphelele
    async getAllUsers() {
        try {
            const query = `
                SELECT *
                FROM (
                         SELECT
                             client_user_id AS id,
                             'client' AS user_category,
                             user_type AS role,        -- Advocate / Magistrate
                             title,
                             first_name,
                             last_name,
                             email,
                             phone_number,
                             region,
                             created_at
                         FROM client_user

                         UNION ALL

                         SELECT
                             op_user_id AS id,
                             'operational' AS user_category,
                             user_role AS role,        -- Admin / MTN_Staff / etc
                             title,
                             first_name,
                             last_name,
                             email,
                             NULL AS phone_number,
                             NULL AS region,
                             created_at
                         FROM operational_user
                     ) users
                ORDER BY created_at DESC;


            `;

            const result = await db.query(query);
            return result.rows;
        } catch (error) {
            console.error('❌ AdminService.getAllUsers error:', error);
            throw new Error('Failed to fetch all users');
        }
    }

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
                     invoice_path,
                     registration_status,
                     verification_notes,
                     created_at
                 FROM client_user
                 ORDER BY created_at DESC`,
                []
            );

            return result.rows.map(user => ({
                ...user,
                has_invoice: !!user.invoice_path,
                invoice_file_name: user.invoice_path ? path.basename(user.invoice_path) : null
            }));
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
                     invoice_path,
                     registration_status,
                     verification_notes,
                     created_at,
                     updated_at
                 FROM client_user
                 WHERE client_user_id = $1`,
                [userId]
            );

            if (result.rows.length === 0) {
                throw new Error('Client user not found');
            }

            const user = result.rows[0];
            return {
                ...user,
                has_invoice: !!user.invoice_path,
                invoice_file_name: user.invoice_path ? path.basename(user.invoice_path) : null,
                profile_completed: user.registration_status === 'Profile_Completed' || user.registration_status === 'Verified'
            };
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
    // Add these methods to your existing AdminService class (before module.exports)

// Enhanced statistics method
    async getEnhancedStatistics() {
        try {
            // Basic user statistics
            const userStats = await this.getUserStatistics();

            // Get current date for calculations
            const lastMonth = new Date();
            lastMonth.setMonth(lastMonth.getMonth() - 1);

            // New registrations this month
            const newClientsThisMonth = await db.query(
                `SELECT COUNT(*) as count
                 FROM client_user
                 WHERE created_at >= $1`,
                [lastMonth]
            );

            const newOperationalThisMonth = await db.query(
                `SELECT COUNT(*) as count
                 FROM operational_user
                 WHERE created_at >= $1`,
                [lastMonth]
            );

            // Get last month's data for comparison
            const twoMonthsAgo = new Date();
            twoMonthsAgo.setMonth(twoMonthsAgo.getMonth() - 2);

            const lastMonthClients = await db.query(
                `SELECT COUNT(*) as count
                 FROM client_user
                 WHERE created_at >= $1 AND created_at < $2`,
                [twoMonthsAgo, lastMonth]
            );

            const lastMonthOperational = await db.query(
                `SELECT COUNT(*) as count
                 FROM operational_user
                 WHERE created_at >= $1 AND created_at < $2`,
                [twoMonthsAgo, lastMonth]
            );

            // Calculate growth percentage
            const currentClients = parseInt(newClientsThisMonth.rows[0]?.count || 0);
            const previousClients = parseInt(lastMonthClients.rows[0]?.count || 0);
            const clientGrowth = previousClients > 0 ?
                Math.round(((currentClients - previousClients) / previousClients) * 100) : 100;

            const currentOperational = parseInt(newOperationalThisMonth.rows[0]?.count || 0);
            const previousOperational = parseInt(lastMonthOperational.rows[0]?.count || 0);
            const operationalGrowth = previousOperational > 0 ?
                Math.round(((currentOperational - previousOperational) / previousOperational) * 100) : 100;

            // Region statistics
            const regionStats = await db.query(`
                SELECT
                    COALESCE(region, 'Not Specified') as region,
                    COUNT(*) as count
                FROM client_user
                GROUP BY region
                ORDER BY count DESC
            `);

            // Registration trends (last 6 months)
            const sixMonthsAgo = new Date();
            sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);

            const monthlyTrends = await db.query(`
                SELECT
                    TO_CHAR(DATE_TRUNC('month', created_at), 'Mon') as month,
                EXTRACT(MONTH FROM DATE_TRUNC('month', created_at)) as month_num,
                COUNT(*) as registrations,
                'client' as user_type
                FROM client_user
                WHERE created_at >= $1
                GROUP BY DATE_TRUNC('month', created_at)
                UNION ALL
                SELECT
                    TO_CHAR(DATE_TRUNC('month', created_at), 'Mon') as month,
                EXTRACT(MONTH FROM DATE_TRUNC('month', created_at)) as month_num,
                COUNT(*) as registrations,
                'operational' as user_type
                FROM operational_user
                WHERE created_at >= $1
                GROUP BY DATE_TRUNC('month', created_at)
                ORDER BY month_num
            `, [sixMonthsAgo]);

            // Group monthly trends by month
            const groupedTrends = monthlyTrends.rows.reduce((acc, row) => {
                if (!acc[row.month]) {
                    acc[row.month] = {
                        month: row.month,
                        clients: 0,
                        operational: 0,
                        total: 0
                    };
                }
                if (row.user_type === 'client') {
                    acc[row.month].clients += parseInt(row.registrations);
                } else {
                    acc[row.month].operational += parseInt(row.registrations);
                }
                acc[row.month].total = acc[row.month].clients + acc[row.month].operational;
                return acc;
            }, {});

            const monthlyTrendsArray = Object.values(groupedTrends);

            return {
                ...userStats,
                growth_metrics: {
                    new_clients_this_month: currentClients,
                    new_operational_this_month: currentOperational,
                    client_growth_percentage: clientGrowth,
                    operational_growth_percentage: operationalGrowth,
                    total_growth_percentage: Math.round(((currentClients + currentOperational) /
                        (previousClients + previousOperational + 1) - 1) * 100)
                },
                region_stats: regionStats.rows,
                monthly_trends: monthlyTrendsArray,
                summary: {
                    total_users: userStats.total_users,
                    total_clients: userStats.client_users.total,
                    total_operational: userStats.operational_users.total,
                    verification_rate: userStats.client_users.total > 0 ?
                        Math.round((userStats.client_users.stats.find(s => s.registration_status === 'Verified')?.count || 0) /
                            userStats.client_users.total * 100) : 0
                }
            };
        } catch (error) {
            throw new Error(`Error fetching enhanced statistics: ${error.message}`);
        }
    }

// Dashboard metrics method
    async getDashboardMetrics() {
        try {
            const today = new Date();
            today.setHours(0, 0, 0, 0);

            const yesterday = new Date(today);
            yesterday.setDate(yesterday.getDate() - 1);

            // Today's registrations
            const todaysRegistrations = await db.query(`
                        SELECT COUNT(*) as count
                        FROM client_user
                        WHERE created_at >= $1`,
                [today]
            );

            // Yesterday's registrations for comparison
            const yesterdaysRegistrations = await db.query(`
                        SELECT COUNT(*) as count
                        FROM client_user
                        WHERE created_at >= $1 AND created_at < $2`,
                [yesterday, today]
            );

            // Pending approvals
            const pendingApprovals = await db.query(`
                SELECT COUNT(*) as count
                FROM client_user
                WHERE registration_status = 'Pending'
            `);

            // Recently verified (last 7 days)
            const recentlyVerified = await db.query(`
                SELECT COUNT(*) as count
                FROM client_user
                WHERE registration_status = 'Verified'
                  AND updated_at >= NOW() - INTERVAL '7 days'
            `);

            // Average verification time
            const avgVerificationTime = await db.query(`
                SELECT AVG(EXTRACT(EPOCH FROM (updated_at - created_at))/86400) as avg_days
                FROM client_user
                WHERE registration_status = 'Verified'
                  AND updated_at IS NOT NULL
            `);

            // Most active region
            const mostActiveRegion = await db.query(`
                SELECT region, COUNT(*) as count
                FROM client_user
                WHERE region IS NOT NULL AND region != ''
                GROUP BY region
                ORDER BY count DESC
                    LIMIT 1
            `);

            const todaysCount = parseInt(todaysRegistrations.rows[0]?.count || 0);
            const yesterdaysCount = parseInt(yesterdaysRegistrations.rows[0]?.count || 0);
            const dailyGrowth = yesterdaysCount > 0 ?
                Math.round(((todaysCount - yesterdaysCount) / yesterdaysCount) * 100) :
                (todaysCount > 0 ? 100 : 0);

            return {
                todays_registrations: todaysCount,
                daily_growth: dailyGrowth,
                pending_approvals: parseInt(pendingApprovals.rows[0]?.count || 0),
                recently_verified: parseInt(recentlyVerified.rows[0]?.count || 0),
                avg_verification_days: parseFloat(avgVerificationTime.rows[0]?.avg_days || 0).toFixed(1),
                most_active_region: mostActiveRegion.rows[0]?.region || 'N/A',
                region_user_count: parseInt(mostActiveRegion.rows[0]?.count || 0),
                timestamp: new Date().toISOString()
            };
        } catch (error) {
            throw new Error(`Error fetching dashboard metrics: ${error.message}`);
        }
    }

// Performance statistics method
    async getPerformanceStats() {
        try {
            // Active sessions (if you have a sessions table)
            const activeSessions = await db.query(`
                SELECT COUNT(*) as count
                FROM sessions
                WHERE expires_at > NOW() OR true
            `).catch(() => ({ rows: [{ count: '0' }] }));

            // API performance (if you have api_logs table)
            const apiPerformance = await db.query(`
                SELECT
                    endpoint,
                    COUNT(*) as request_count,
                    AVG(response_time) as avg_response_time_ms,
                    MIN(response_time) as min_response_time_ms,
                    MAX(response_time) as max_response_time_ms
                FROM api_logs
                WHERE created_at >= NOW() - INTERVAL '24 hours'
                GROUP BY endpoint
                ORDER BY request_count DESC
                    LIMIT 10
            `).catch(() => ({ rows: [] }));

            // Error rates (last 7 days)
            const errorRates = await db.query(`
                SELECT
                    DATE(created_at) as date,
                    COUNT(*) as total_requests,
                    SUM(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END) as error_count
                FROM api_logs
                WHERE created_at >= NOW() - INTERVAL '7 days'
                GROUP BY DATE(created_at)
                ORDER BY date DESC
            `).catch(() => ({ rows: [] }));

            // Calculate average error rate
            const errorStats = errorRates.rows.reduce((acc, row) => {
                acc.totalRequests += parseInt(row.total_requests);
                acc.errorCount += parseInt(row.error_count);
                return acc;
            }, { totalRequests: 0, errorCount: 0 });

            const avgErrorRate = errorStats.totalRequests > 0 ?
                ((errorStats.errorCount / errorStats.totalRequests) * 100).toFixed(2) : 0;

            return {
                system_performance: {
                    active_sessions: parseInt(activeSessions.rows[0]?.count || 0),
                    uptime_percentage: 99.9, // Default value
                    avg_response_time: apiPerformance.rows.length > 0 ?
                        parseFloat(apiPerformance.rows[0].avg_response_time_ms).toFixed(0) : 'N/A'
                },
                api_performance: apiPerformance.rows.map(row => ({
                    endpoint: row.endpoint,
                    request_count: parseInt(row.request_count),
                    avg_response_time_ms: parseFloat(row.avg_response_time_ms).toFixed(0),
                    min_response_time_ms: parseInt(row.min_response_time_ms),
                    max_response_time_ms: parseInt(row.max_response_time_ms)
                })),
                error_rates: {
                    daily: errorRates.rows.map(row => ({
                        date: row.date,
                        total_requests: parseInt(row.total_requests),
                        error_count: parseInt(row.error_count),
                        error_rate: ((parseInt(row.error_count) / parseInt(row.total_requests || 1)) * 100).toFixed(2)
                    })),
                    overall_error_rate: avgErrorRate
                }
            };
        } catch (error) {
            throw new Error(`Error fetching performance stats: ${error.message}`);
        }
    }

    //DOCUMENTS
    // In AdminService.js - fix the UNION ALL ORDER BY issue
    async getAllUserDocuments(userId) {
        try {
            // Get regular documents from document table
            const documentsResult = await db.query(
                `SELECT
                     document_id,
                     document_type,
                     s3_path,
                     upload_date,
                     document_status,
                     application_id,
                     false as is_invoice,
                     -- Add sort_order for consistent ordering
                     CASE document_type
                         WHEN 'ID' THEN 1
                         WHEN 'Payslip' THEN 2
                         WHEN 'Proof_of_Residence' THEN 3
                         ELSE 4
                         END as sort_order
                 FROM document
                 WHERE client_user_id = $1

                 UNION ALL

                 -- Get invoice as a document
                 SELECT
                     -1 as document_id,
                     'Invoice' as document_type,
                     invoice_path as s3_path,
                     created_at as upload_date,
                     'Verified' as document_status,
                     NULL as application_id,
                     true as is_invoice,
                     0 as sort_order  -- Invoices come first
                 FROM client_user
                 WHERE client_user_id = $2 AND invoice_path IS NOT NULL

                 ORDER BY sort_order, upload_date DESC`,
                [userId, userId]
            );

            if (documentsResult.rows.length === 0) {
                return [];
            }

            const documents = documentsResult.rows.map(doc => ({
                document_id:     doc.document_id,
                document_type:   doc.document_type,
                is_invoice:      doc.is_invoice,
                file_name:       path.basename(doc.s3_path),
                file_exists:     !!doc.s3_path,
                file_size:       null,
                upload_date:     doc.upload_date,
                document_status: doc.document_status,
                application_id:  doc.application_id,
                mime_type:       storage.getMimeFromPath(doc.s3_path),
            }));

            return documents;
        } catch (error) {
            console.error('Error in getAllUserDocuments:', error);
            throw new Error(`Error fetching user documents: ${error.message}`);
        }
    }

// Download ANY document (works for invoice, ID, payslip, etc.)
    // Fix the downloadUserDocument method - the parameter order was wrong
    async downloadUserDocument(documentId) {
        try {
            let query;
            let params;

            // Check if this is an invoice (negative ID)
            if (documentId < 0) {
                // This is an invoice - get from client_user table
                query = `
                SELECT 
                    invoice_path as s3_path,
                    'Invoice' as document_type,
                    'Verified' as document_status,
                    first_name,
                    last_name
                FROM client_user 
                WHERE client_user_id = $1 AND invoice_path IS NOT NULL
            `;
                params = [Math.abs(documentId)]; // Convert back to positive user ID
            } else {
                // Regular document
                query = `
                SELECT 
                    d.s3_path,
                    d.document_type,
                    d.document_status,
                    cu.first_name,
                    cu.last_name
                FROM document d
                LEFT JOIN client_user cu ON d.client_user_id = cu.client_user_id
                WHERE d.document_id = $1
            `;
                params = [documentId];
            }

            const result = await db.query(query, params);

            if (result.rows.length === 0) {
                throw new Error('Document not found');
            }

            const doc = result.rows[0];

            if (!doc.s3_path) throw new Error('Document file path missing in database');

            const { buffer, contentType } = await storage.downloadFile(doc.s3_path);

            const safeFileName = `${doc.document_type}_${doc.first_name || 'user'}_${doc.last_name || 'user'}${path.extname(doc.s3_path)}`
                .replace(/[^a-zA-Z0-9._-]/g, '_');

            return {
                buffer,
                fileName:       safeFileName,
                mimeType:       contentType || storage.getMimeFromPath(doc.s3_path),
                documentType:   doc.document_type,
                documentStatus: doc.document_status,
            };
        } catch (error) {
            throw new Error(`Error downloading document: ${error.message}`);
        }
    }

// Update document status (verify/reject)
    async updateDocumentStatus(documentId, status, notes) {
        try {
            const result = await db.query(
                `UPDATE document 
             SET document_status = $1,
                 verification_notes = $2,
                 verification_date = CURRENT_TIMESTAMP
             WHERE document_id = $3
             RETURNING *`,
                [status, notes, documentId]
            );

            if (result.rows.length === 0) {
                throw new Error('Document not found');
            }

            return result.rows[0];
        } catch (error) {
            throw new Error(`Error updating document status: ${error.message}`);
        }
    }

// View ANY document
    async viewUserDocument(documentId) {
        return await this.downloadUserDocument(documentId); // Same logic as download
    }

    // Normalise a DB path to a Supabase storage key.
    // Old disk paths like /uploads/invoices/file.pdf → invoices/file.pdf
    // New Supabase paths like invoices/file.pdf → invoices/file.pdf (unchanged)
    _normaliseStoragePath(rawPath) {
        if (!rawPath) return null;
        // Strip leading slash
        let p = rawPath.startsWith('/') ? rawPath.slice(1) : rawPath;
        // Strip legacy 'uploads/' prefix
        if (p.startsWith('uploads/')) p = p.slice('uploads/'.length);
        return p;
    }

    // Returns true if a path looks like an old on-disk path that was never in Supabase
    _isLegacyDiskPath(rawPath) {
        if (!rawPath) return false;
        return rawPath.startsWith('/uploads') || rawPath.startsWith('uploads/');
    }

    // Returns a short-lived signed Supabase URL for direct browser viewing
    async getDocumentSignedUrl(documentId) {
        let query, params;
        if (documentId < 0) {
            query = `SELECT invoice_path AS s3_path FROM client_user WHERE client_user_id = $1 AND invoice_path IS NOT NULL`;
            params = [Math.abs(documentId)];
        } else {
            query = `SELECT s3_path FROM document WHERE document_id = $1`;
            params = [documentId];
        }
        const result = await db.query(query, params);
        if (result.rows.length === 0 || !result.rows[0].s3_path) {
            throw new Error('Document not found');
        }
        const rawPath = result.rows[0].s3_path;
        if (this._isLegacyDiskPath(rawPath)) {
            throw new Error('This document was uploaded before cloud storage was enabled and is no longer accessible. Please ask the user to re-upload.');
        }
        const storagePath = this._normaliseStoragePath(rawPath);
        return storage.getSignedUrl(storagePath, 300); // 5-min URL
    }

    async getInvoiceSignedUrl(userId) {
        const result = await db.query(
            `SELECT invoice_path FROM client_user WHERE client_user_id = $1 AND invoice_path IS NOT NULL`,
            [userId]
        );
        if (result.rows.length === 0 || !result.rows[0].invoice_path) {
            throw new Error('Invoice not found for this user');
        }
        const rawPath = result.rows[0].invoice_path;
        if (this._isLegacyDiskPath(rawPath)) {
            throw new Error('This invoice was uploaded before cloud storage was enabled and is no longer accessible. Please ask the user to re-upload.');
        }
        const storagePath = this._normaliseStoragePath(rawPath);
        return storage.getSignedUrl(storagePath, 300); // 5-min URL
    }

}

module.exports = new AdminService();