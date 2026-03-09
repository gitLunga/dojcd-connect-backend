const db = require('../config/db');
const path = require('path');
const fs = require('fs');

// ─── Utility: strip leading slash so path.join works correctly ───────────────
function resolvePath(relativePath) {
    const clean = relativePath.startsWith('/') ? relativePath.slice(1) : relativePath;
    return path.join(__dirname, '..', clean);
}

// ─── Utility: map raw DB/system errors to friendly messages ──────────────────
function friendlyError(error, context = 'operation') {
    const msg = error.message || '';

    if (msg.includes('duplicate key') || msg.includes('unique constraint')) {
        return 'This record already exists.';
    }
    if (msg.includes('violates foreign key')) {
        return 'The referenced record does not exist.';
    }
    if (msg.includes('connect') || msg.includes('ECONNREFUSED')) {
        return 'We are having trouble reaching the database. Please try again shortly.';
    }
    if (msg.includes('not found') || msg.includes('no rows')) {
        return msg; // these are already friendly
    }

    console.error(`❌ AdminService error [${context}]:`, error);
    return `We could not complete this ${context}. Please try again.`;
}

class AdminService {

    // ─── INVOICES ────────────────────────────────────────────────────────────

    async getClientInvoice(userId) {
        try {
            const result = await db.query(
                `SELECT invoice_path FROM client_user WHERE client_user_id = $1`,
                [userId]
            );

            if (result.rows.length === 0 || !result.rows[0].invoice_path) {
                throw new Error('No invoice has been uploaded for this user.');
            }

            const invoicePath = result.rows[0].invoice_path;
            const fullPath = resolvePath(invoicePath); // ✅ FIXED path resolution

            if (!fs.existsSync(fullPath)) {
                throw new Error('The invoice file could not be found on the server.');
            }

            return {
                filePath: fullPath,
                fileName: path.basename(invoicePath),
                mimeType: this.getMimeType(fullPath)
            };
        } catch (error) {
            if (error.message.includes('invoice') || error.message.includes('found')) {
                throw error;
            }
            throw new Error(friendlyError(error, 'invoice retrieval'));
        }
    }

    async downloadInvoice(userId, res) {
        try {
            const invoiceInfo = await this.getClientInvoice(userId);
            res.setHeader('Content-Disposition', `attachment; filename="${invoiceInfo.fileName}"`);
            res.setHeader('Content-Type', invoiceInfo.mimeType);
            const fileStream = fs.createReadStream(invoiceInfo.filePath);
            fileStream.pipe(res);
            return invoiceInfo;
        } catch (error) {
            throw error;
        }
    }

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

    // ─── USERS ───────────────────────────────────────────────────────────────

    async getAllUsers() {
        try {
            const query = `
                SELECT * FROM (
                    SELECT
                        client_user_id AS id,
                        'client' AS user_category,
                        user_type AS role,
                        title, first_name, last_name, email,
                        phone_number, region, created_at
                    FROM client_user

                    UNION ALL

                    SELECT
                        op_user_id AS id,
                        'operational' AS user_category,
                        user_role AS role,
                        title, first_name, last_name, email,
                        NULL AS phone_number, NULL AS region, created_at
                    FROM operational_user
                ) users
                ORDER BY created_at DESC;
            `;
            const result = await db.query(query);
            return result.rows;
        } catch (error) {
            throw new Error(friendlyError(error, 'fetching users'));
        }
    }

    async getAllClientUsers() {
        try {
            const result = await db.query(
                `SELECT
                     client_user_id, title, first_name, last_name, email,
                     phone_number, region, persal_id, department_id, user_type,
                     network_provider, contract_duration_months, contract_end_date,
                     invoice_path, registration_status, verification_notes, created_at
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
            throw new Error(friendlyError(error, 'fetching client users'));
        }
    }

    async getClientUserById(userId) {
        try {
            const result = await db.query(
                `SELECT
                     client_user_id, title, first_name, last_name, email,
                     phone_number, region, persal_id, department_id, user_type,
                     network_provider, contract_duration_months, contract_end_date,
                     invoice_path, registration_status, verification_notes,
                     created_at, updated_at
                 FROM client_user
                 WHERE client_user_id = $1`,
                [userId]
            );

            if (result.rows.length === 0) {
                throw new Error('User not found.');
            }

            const user = result.rows[0];
            return {
                ...user,
                has_invoice: !!user.invoice_path,
                invoice_file_name: user.invoice_path ? path.basename(user.invoice_path) : null,
                profile_completed: user.registration_status === 'Profile_Completed' || user.registration_status === 'Verified'
            };
        } catch (error) {
            if (error.message === 'User not found.') throw error;
            throw new Error(friendlyError(error, 'fetching user'));
        }
    }

    async getAllOperationalUsers() {
        try {
            const result = await db.query(
                `SELECT op_user_id, first_name, last_name, email, user_role
                 FROM operational_user
                 ORDER BY created_at DESC`,
                []
            );
            return result.rows;
        } catch (error) {
            throw new Error(friendlyError(error, 'fetching operational users'));
        }
    }

    async getOperationalUserById(userId) {
        try {
            const result = await db.query(
                `SELECT op_user_id, first_name, last_name, email, user_role
                 FROM operational_user
                 WHERE op_user_id = $1`,
                [userId]
            );

            if (result.rows.length === 0) {
                throw new Error('Operational user not found.');
            }
            return result.rows[0];
        } catch (error) {
            if (error.message.includes('not found')) throw error;
            throw new Error(friendlyError(error, 'fetching operational user'));
        }
    }

    // ─── STATUS UPDATE (with Verified lock) ──────────────────────────────────

    async updateUserRegistrationStatus(userId, status, notes) {
        try {
            // Fetch the current status first
            const current = await db.query(
                `SELECT registration_status, first_name, last_name
                 FROM client_user WHERE client_user_id = $1`,
                [userId]
            );

            if (current.rows.length === 0) {
                throw new Error('User not found.');
            }

            const { registration_status, first_name, last_name } = current.rows[0];
            const fullName = `${first_name} ${last_name}`;

            // ✅ Lock: once Verified, no further changes allowed
            if (registration_status === 'Verified') {
                throw new Error(`${fullName}'s account is already verified and cannot be changed.`);
            }

            const result = await db.query(
                `UPDATE client_user
                 SET registration_status = $1,
                     verification_notes = $2,
                     updated_at = CURRENT_TIMESTAMP
                 WHERE client_user_id = $3
                 RETURNING client_user_id, first_name, last_name, email,
                           registration_status, verification_notes`,
                [status, notes, userId]
            );

            return result.rows[0];
        } catch (error) {
            if (error.message.includes('not found') || error.message.includes('already verified')) {
                throw error;
            }
            throw new Error(friendlyError(error, 'updating user status'));
        }
    }

    // ─── STATISTICS ──────────────────────────────────────────────────────────

    async getUserStatistics() {
        try {
            const [clientStats, operationalStats, totalClients, totalOperational] = await Promise.all([
                db.query(`SELECT registration_status, COUNT(*) as count FROM client_user GROUP BY registration_status`),
                db.query(`SELECT user_role, COUNT(*) as count FROM operational_user GROUP BY user_role`),
                db.query(`SELECT COUNT(*) as total FROM client_user`),
                db.query(`SELECT COUNT(*) as total FROM operational_user`)
            ]);

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
            throw new Error(friendlyError(error, 'fetching statistics'));
        }
    }

    async getRecentRegistrations() {
        try {
            const result = await db.query(
                `SELECT 'client' as user_type, client_user_id as id,
                    first_name, last_name, email, registration_status, created_at
                 FROM client_user
                 WHERE created_at >= NOW() - INTERVAL '7 days'

                 UNION ALL

                 SELECT 'operational' as user_type, op_user_id as id,
                    first_name, last_name, email,
                    'Verified' as registration_status, created_at
                 FROM operational_user
                 WHERE created_at >= NOW() - INTERVAL '7 days'

                 ORDER BY created_at DESC
                 LIMIT 20`
            );
            return result.rows;
        } catch (error) {
            throw new Error(friendlyError(error, 'fetching recent registrations'));
        }
    }

    async searchUsers(searchTerm) {
        try {
            const result = await db.query(
                `SELECT 'client' as user_type, client_user_id as id,
                    first_name, last_name, email, phone_number, persal_id,
                    registration_status, user_type as client_user_type
                 FROM client_user
                 WHERE first_name ILIKE $1 OR last_name ILIKE $1
                    OR email ILIKE $1 OR persal_id ILIKE $1

                 UNION ALL

                 SELECT 'operational' as user_type, op_user_id as id,
                    first_name, last_name, email,
                    NULL as phone_number, NULL as persal_id,
                    'Verified' as registration_status, user_role as client_user_type
                 FROM operational_user
                 WHERE first_name ILIKE $1 OR last_name ILIKE $1 OR email ILIKE $1

                 ORDER BY last_name, first_name
                 LIMIT 50`,
                [`%${searchTerm}%`]
            );
            return result.rows;
        } catch (error) {
            throw new Error(friendlyError(error, 'searching users'));
        }
    }

    async getUserActivitySummary() {
        try {
            const [applicationsByUser, ordersByUser, activeContracts] = await Promise.all([
                db.query(`
                    SELECT cu.client_user_id, cu.first_name, cu.last_name,
                        COUNT(a.application_id) as application_count
                    FROM client_user cu
                    LEFT JOIN application a ON cu.client_user_id = a.client_user_id
                    GROUP BY cu.client_user_id
                    ORDER BY application_count DESC LIMIT 10
                `),
                db.query(`
                    SELECT cu.client_user_id, cu.first_name, cu.last_name,
                        COUNT(o.order_id) as order_count
                    FROM client_user cu
                    LEFT JOIN application a ON cu.client_user_id = a.client_user_id
                    LEFT JOIN "order" o ON a.application_id = o.application_id
                    WHERE o.order_status = 'Delivered'
                    GROUP BY cu.client_user_id
                    ORDER BY order_count DESC LIMIT 10
                `),
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
            throw new Error(friendlyError(error, 'fetching activity summary'));
        }
    }

    async getEnhancedStatistics() {
        try {
            const userStats = await this.getUserStatistics();
            const lastMonth = new Date();
            lastMonth.setMonth(lastMonth.getMonth() - 1);
            const twoMonthsAgo = new Date();
            twoMonthsAgo.setMonth(twoMonthsAgo.getMonth() - 2);

            const [newClientsThisMonth, newOperationalThisMonth, lastMonthClients,
                lastMonthOperational, regionStats, monthlyTrends] = await Promise.all([
                db.query(`SELECT COUNT(*) as count FROM client_user WHERE created_at >= $1`, [lastMonth]),
                db.query(`SELECT COUNT(*) as count FROM operational_user WHERE created_at >= $1`, [lastMonth]),
                db.query(`SELECT COUNT(*) as count FROM client_user WHERE created_at >= $1 AND created_at < $2`, [twoMonthsAgo, lastMonth]),
                db.query(`SELECT COUNT(*) as count FROM operational_user WHERE created_at >= $1 AND created_at < $2`, [twoMonthsAgo, lastMonth]),
                db.query(`SELECT COALESCE(region, 'Not Specified') as region, COUNT(*) as count FROM client_user GROUP BY region ORDER BY count DESC`),
                db.query(`
                    SELECT TO_CHAR(DATE_TRUNC('month', created_at), 'Mon') as month,
                        EXTRACT(MONTH FROM DATE_TRUNC('month', created_at)) as month_num,
                        COUNT(*) as registrations, 'client' as user_type
                    FROM client_user WHERE created_at >= $1
                    GROUP BY DATE_TRUNC('month', created_at)
                    UNION ALL
                    SELECT TO_CHAR(DATE_TRUNC('month', created_at), 'Mon') as month,
                        EXTRACT(MONTH FROM DATE_TRUNC('month', created_at)) as month_num,
                        COUNT(*) as registrations, 'operational' as user_type
                    FROM operational_user WHERE created_at >= $1
                    GROUP BY DATE_TRUNC('month', created_at)
                    ORDER BY month_num
                `, [new Date(new Date().setMonth(new Date().getMonth() - 6))])
            ]);

            const currentClients = parseInt(newClientsThisMonth.rows[0]?.count || 0);
            const previousClients = parseInt(lastMonthClients.rows[0]?.count || 0);
            const clientGrowth = previousClients > 0 ?
                Math.round(((currentClients - previousClients) / previousClients) * 100) : 100;

            const currentOperational = parseInt(newOperationalThisMonth.rows[0]?.count || 0);
            const previousOperational = parseInt(lastMonthOperational.rows[0]?.count || 0);
            const operationalGrowth = previousOperational > 0 ?
                Math.round(((currentOperational - previousOperational) / previousOperational) * 100) : 100;

            const groupedTrends = monthlyTrends.rows.reduce((acc, row) => {
                if (!acc[row.month]) {
                    acc[row.month] = { month: row.month, clients: 0, operational: 0, total: 0 };
                }
                if (row.user_type === 'client') acc[row.month].clients += parseInt(row.registrations);
                else acc[row.month].operational += parseInt(row.registrations);
                acc[row.month].total = acc[row.month].clients + acc[row.month].operational;
                return acc;
            }, {});

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
                monthly_trends: Object.values(groupedTrends),
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
            throw new Error(friendlyError(error, 'fetching enhanced statistics'));
        }
    }

    async getDashboardMetrics() {
        try {
            const today = new Date();
            today.setHours(0, 0, 0, 0);
            const yesterday = new Date(today);
            yesterday.setDate(yesterday.getDate() - 1);

            const [todaysReg, yesterdaysReg, pendingApprovals, recentlyVerified,
                avgVerificationTime, mostActiveRegion] = await Promise.all([
                db.query(`SELECT COUNT(*) as count FROM client_user WHERE created_at >= $1`, [today]),
                db.query(`SELECT COUNT(*) as count FROM client_user WHERE created_at >= $1 AND created_at < $2`, [yesterday, today]),
                db.query(`SELECT COUNT(*) as count FROM client_user WHERE registration_status = 'Pending'`),
                db.query(`SELECT COUNT(*) as count FROM client_user WHERE registration_status = 'Verified' AND updated_at >= NOW() - INTERVAL '7 days'`),
                db.query(`SELECT AVG(EXTRACT(EPOCH FROM (updated_at - created_at))/86400) as avg_days FROM client_user WHERE registration_status = 'Verified' AND updated_at IS NOT NULL`),
                db.query(`SELECT region, COUNT(*) as count FROM client_user WHERE region IS NOT NULL AND region != '' GROUP BY region ORDER BY count DESC LIMIT 1`)
            ]);

            const todaysCount = parseInt(todaysReg.rows[0]?.count || 0);
            const yesterdaysCount = parseInt(yesterdaysReg.rows[0]?.count || 0);
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
            throw new Error(friendlyError(error, 'fetching dashboard metrics'));
        }
    }

    async getPerformanceStats() {
        try {
            const activeSessions = await db.query(
                `SELECT COUNT(*) as count FROM sessions WHERE expires_at > NOW() OR true`
            ).catch(() => ({ rows: [{ count: '0' }] }));

            const apiPerformance = await db.query(`
                SELECT endpoint, COUNT(*) as request_count,
                    AVG(response_time) as avg_response_time_ms,
                    MIN(response_time) as min_response_time_ms,
                    MAX(response_time) as max_response_time_ms
                FROM api_logs
                WHERE created_at >= NOW() - INTERVAL '24 hours'
                GROUP BY endpoint ORDER BY request_count DESC LIMIT 10
            `).catch(() => ({ rows: [] }));

            const errorRates = await db.query(`
                SELECT DATE(created_at) as date, COUNT(*) as total_requests,
                    SUM(CASE WHEN status_code >= 400 THEN 1 ELSE 0 END) as error_count
                FROM api_logs
                WHERE created_at >= NOW() - INTERVAL '7 days'
                GROUP BY DATE(created_at) ORDER BY date DESC
            `).catch(() => ({ rows: [] }));

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
                    uptime_percentage: 99.9,
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
            throw new Error(friendlyError(error, 'fetching performance stats'));
        }
    }

    // ─── DOCUMENTS ───────────────────────────────────────────────────────────

    async getAllUserDocuments(userId) {
        try {
            const documentsResult = await db.query(
                `SELECT
                     document_id, document_type, s3_path, upload_date,
                     document_status, application_id, false as is_invoice,
                     CASE document_type
                         WHEN 'ID' THEN 1
                         WHEN 'Payslip' THEN 2
                         WHEN 'Proof_of_Residence' THEN 3
                         ELSE 4
                     END as sort_order
                 FROM document
                 WHERE client_user_id = $1

                 UNION ALL

                 SELECT
                     -1 as document_id, 'Invoice' as document_type,
                     invoice_path as s3_path, created_at as upload_date,
                     'Verified' as document_status, NULL as application_id,
                     true as is_invoice, 0 as sort_order
                 FROM client_user
                 WHERE client_user_id = $2 AND invoice_path IS NOT NULL

                 ORDER BY sort_order, upload_date DESC`,
                [userId, userId]
            );

            if (documentsResult.rows.length === 0) {
                return [];
            }

            const documents = [];
            for (const doc of documentsResult.rows) {
                const fullPath = resolvePath(doc.s3_path); // ✅ FIXED path resolution
                const fileExists = fs.existsSync(fullPath);

                let fileSize = null;
                if (fileExists) {
                    try {
                        const stats = fs.statSync(fullPath);
                        fileSize = stats.size;
                    } catch (err) {
                        console.error(`Could not read file stats for ${doc.s3_path}:`, err);
                    }
                }

                documents.push({
                    document_id: doc.document_id,
                    document_type: doc.document_type,
                    is_invoice: doc.is_invoice,
                    file_path: doc.s3_path,
                    file_name: path.basename(doc.s3_path),
                    file_exists: fileExists,
                    file_size: fileSize,
                    upload_date: doc.upload_date,
                    document_status: doc.document_status,
                    application_id: doc.application_id,
                    mime_type: fileExists ? this.getMimeType(fullPath) : null
                });
            }

            return documents;
        } catch (error) {
            console.error('Error in getAllUserDocuments:', error);
            throw new Error(friendlyError(error, 'fetching documents'));
        }
    }

    async downloadUserDocument(documentId) {
        try {
            let query, params;

            if (documentId < 0) {
                query = `
                    SELECT invoice_path as s3_path, 'Invoice' as document_type,
                        'Verified' as document_status, first_name, last_name
                    FROM client_user
                    WHERE client_user_id = $1 AND invoice_path IS NOT NULL
                `;
                params = [Math.abs(documentId)];
            } else {
                query = `
                    SELECT d.s3_path, d.document_type, d.document_status,
                        cu.first_name, cu.last_name
                    FROM document d
                    LEFT JOIN client_user cu ON d.client_user_id = cu.client_user_id
                    WHERE d.document_id = $1
                `;
                params = [documentId];
            }

            const result = await db.query(query, params);

            if (result.rows.length === 0) {
                throw new Error('Document not found.');
            }

            const doc = result.rows[0];
            const fullPath = resolvePath(doc.s3_path); // ✅ FIXED path resolution

            if (!fs.existsSync(fullPath)) {
                throw new Error('The document file could not be found on the server.');
            }

            const safeFileName = `${doc.document_type}_${doc.first_name || 'user'}_${doc.last_name || 'user'}_${path.basename(doc.s3_path)}`
                .replace(/[^a-zA-Z0-9._-]/g, '_');

            return {
                filePath: fullPath,
                fileName: safeFileName,
                mimeType: this.getMimeType(fullPath),
                documentType: doc.document_type,
                documentStatus: doc.document_status
            };
        } catch (error) {
            if (error.message.includes('not found') || error.message.includes('could not be found')) {
                throw error;
            }
            throw new Error(friendlyError(error, 'downloading document'));
        }
    }

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
                throw new Error('Document not found.');
            }

            return result.rows[0];
        } catch (error) {
            if (error.message.includes('not found')) throw error;
            throw new Error(friendlyError(error, 'updating document status'));
        }
    }

    async viewUserDocument(documentId) {
        return await this.downloadUserDocument(documentId);
    }
}

module.exports = new AdminService();