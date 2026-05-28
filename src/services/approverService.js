// src/services/approverService.js
const db = require('../config/db');
const notificationService = require('./notificationService');
const auditService        = require('./auditService');
const SLA                 = require('../config/slaConfig');

function friendlyError(error, context = 'operation') {
    const msg = error.message || '';
    if (msg.includes('not found')) return msg;
    if (msg.includes('already been')) return msg;
    if (msg.includes('not authorised')) return msg;
    if (msg.includes('cannot')) return msg;
    console.error(`❌ ApproverService [${context}]:`, error);
    return `We could not complete this ${context}. Please try again.`;
}

// Fetch full application detail — uses the provided client (for transactions)
async function getApplicationDetail(client, applicationId) {
    const result = await client.query(`
        SELECT a.application_id,
               a.application_status,
               a.submission_date,
               a.last_updated,
               a.rejection_reason,
               d.device_id,
               d.device_name,
               d.model,
               d.manufacturer,
               d.plan_name,
               d.plan_details,
               d.monthly_cost,
               d.contract_duration_months,
               cu.client_user_id,
               cu.title                                                      AS applicant_title,
               cu.first_name                                                 AS applicant_first_name,
               cu.last_name                                                  AS applicant_last_name,
               cu.email                                                      AS applicant_email,
               cu.phone_number                                               AS applicant_phone,
               cu.region                                                     AS applicant_region,
               cu.persal_id,
               cu.department_id,
               cu.user_type                                                  AS applicant_type,
               cu.registration_status,
               (SELECT json_agg(ap_inner ORDER BY ap_inner.approval_date ASC)
                FROM (SELECT ap2.approval_id,
                             ap2.approval_stage,
                             ap2.approval_status,
                             ap2.approval_date,
                             ap2.notes,
                             ou.first_name AS approver_first_name,
                             ou.last_name  AS approver_last_name,
                             ou.user_role  AS approver_role
                      FROM approval ap2
                               JOIN operational_user ou ON ap2.approver_op_user_id = ou.op_user_id
                      WHERE ap2.application_id = a.application_id) ap_inner) AS approval_history
        FROM application a
                 JOIN device_catalog d ON a.device_id = d.device_id
                 JOIN client_user cu ON a.client_user_id = cu.client_user_id
        WHERE a.application_id = $1
    `, [applicationId]);

    return result.rows[0] || null;
}

class ApproverService {

    // ── SHARED: Get a single application ───────────────────────────────────────
    async getApplicationById(applicationId) {
        const client = await db.connect();
        try {
            const app = await getApplicationDetail(client, applicationId);
            if (!app) throw new Error(`Application #${applicationId} not found.`);
            return app;
        } finally {
            client.release();
        }
    }

    // ── SHARED: Application stats ──────────────────────────────────────────────
// src/services/approverService.js - Completely rewritten getApproverStats

    async getApproverStats(approverId, approverRole) {
        const client = await db.connect();
        try {
            const ownedStatus = approverRole === 'Manager' ? 'Pending' : 'Pending_Finance';
            const ownedStage = approverRole === 'Manager' ? 'manager' : 'finance';

            // Single query using CTEs — uses exactly 1 connection instead of 4
            const result = await client.query(`
                WITH user_check AS (SELECT op_user_id, user_role
                                    FROM operational_user
                                    WHERE op_user_id = $1),
                     pending AS (SELECT COUNT(*) AS count
                FROM application
                WHERE application_status = $2
                    )
                    , decisions AS (
                SELECT
                    COUNT (*) FILTER (WHERE approval_status = 'Approved') AS approved, COUNT (*) FILTER (WHERE approval_status = 'Rejected') AS rejected, COALESCE (ROUND(AVG (
                    EXTRACT (EPOCH FROM (ap.approval_date - a.submission_date)) / 86400
                    ):: numeric, 1), 0) AS avg_days
                FROM approval ap
                    JOIN application a
                ON ap.application_id = a.application_id
                WHERE ap.approver_op_user_id = $1
                  AND ap.approval_stage = $3
                    )
                SELECT (SELECT op_user_id FROM user_check) AS verified_user_id,
                       (SELECT user_role FROM user_check)  AS user_role,
                       (SELECT count FROM pending)         AS pending_count,
                       (SELECT approved FROM decisions)    AS approved_count,
                       (SELECT rejected FROM decisions)    AS rejected_count,
                       (SELECT avg_days FROM decisions)    AS avg_days
            `, [approverId, ownedStatus, ownedStage]);

            const row = result.rows[0];

            if (!row.verified_user_id) {
                throw new Error(`User with ID ${approverId} not found in operational_user table`);
            }

           // console.log(`User found: ${row.user_role}, expected: ${approverRole}`);

            return {
                pending_in_queue: parseInt(row.pending_count || 0),
                total_approved: parseInt(row.approved_count || 0),
                total_rejected: parseInt(row.rejected_count || 0),
                avg_decision_days: parseFloat(row.avg_days || 0),
            };
        } catch (error) {
            console.error('Detailed error in getApproverStats:', error);
            throw new Error(`Database error: ${error.message}`);
        } finally {
            client.release();
        }
    }

    // ── MANAGER QUEUE ──────────────────────────────────────────────────────────
    async getManagerQueue(filters = {}) {
        const client = await db.connect();
        try {
            const params = ['Pending'];
            const clauses = [`a.application_status = $1`];
            let idx = 2;

            if (filters.region) {
                clauses.push(`cu.region = $${idx++}`);
                params.push(filters.region);
            }
            if (filters.department_id) {
                clauses.push(`cu.department_id = $${idx++}`);
                params.push(filters.department_id);
            }
            if (filters.date_from) {
                clauses.push(`a.submission_date >= $${idx++}`);
                params.push(filters.date_from);
            }
            if (filters.date_to) {
                clauses.push(`a.submission_date <= $${idx++}`);
                params.push(filters.date_to);
            }

            const limit = Math.min(parseInt(filters.limit || 50), 200);
            const offset = parseInt(filters.offset || 0);

            const result = await client.query(`
                SELECT a.application_id,
                       a.application_status,
                       a.submission_date,
                       a.last_updated,
                       cu.title      AS applicant_title,
                       cu.first_name AS applicant_first_name,
                       cu.last_name  AS applicant_last_name,
                       cu.region     AS applicant_region,
                       cu.department_id,
                       cu.user_type  AS applicant_type,
                       cu.persal_id,
                       d.device_name,
                       d.model,
                       d.manufacturer,
                       d.plan_name,
                       d.monthly_cost,
                       d.contract_duration_months,
                       ROUND(
                               EXTRACT(EPOCH FROM (NOW() - a.submission_date)) / 86400
                       )::int                                                    AS days_waiting,
                       $${idx}::int                                              AS sla_days,
                       CASE
                           WHEN EXTRACT(EPOCH FROM (NOW() - a.submission_date)) / 86400 > $${idx}
                               THEN 'breached'
                           WHEN EXTRACT(EPOCH FROM (NOW() - a.submission_date)) / 86400 > $${idx} * 0.8
                               THEN 'approaching'
                           ELSE 'within'
                       END                                                       AS sla_status,
                       LEAST(
                           ROUND(
                               EXTRACT(EPOCH FROM (NOW() - a.submission_date)) / 86400
                               / NULLIF($${idx}, 0) * 100
                           )::int,
                           999
                       )                                                         AS sla_percent_used
                FROM application a
                         JOIN client_user cu ON a.client_user_id = cu.client_user_id
                         JOIN device_catalog d ON a.device_id = d.device_id
                WHERE ${clauses.join(' AND ')}
                ORDER BY a.submission_date ASC LIMIT $${idx + 1}
                OFFSET $${idx + 2}
            `, [...params, SLA.Pending.sla_days, limit, offset]);
            idx += 3;

            const countResult = await client.query(`
                SELECT COUNT(*) AS total
                FROM application a
                         JOIN client_user cu ON a.client_user_id = cu.client_user_id
                WHERE ${clauses.join(' AND ')}
            `, params);

            return {
                applications: result.rows,
                total: parseInt(countResult.rows[0].total),
                limit,
                offset,
            };
        } catch (error) {
            throw new Error(friendlyError(error, 'fetching manager queue'));
        } finally {
            client.release();
        }
    }

    // ── MANAGER APPROVE ────────────────────────────────────────────────────────
    async managerApprove(applicationId, managerId, notes = null) {
        let client = null;
        try {
            client = await db.connect();
            await client.query('BEGIN');

            const app = await getApplicationDetail(client, applicationId);
            if (!app) throw new Error(`Application #${applicationId} not found.`);

            if (app.application_status !== 'Pending') {
                throw new Error(
                    `This application cannot be approved at the manager stage — ` +
                    `current status is "${app.application_status}".`
                );
            }

            await client.query(`
                UPDATE application
                SET application_status = 'Pending_Finance',
                    last_updated       = NOW()
                WHERE application_id = $1
            `, [applicationId]);

            await client.query(`
                INSERT INTO approval
                (application_id, approver_op_user_id, approval_status, approval_stage, approval_date, notes)
                VALUES ($1, $2, 'Approved', 'manager', NOW(), $3)
            `, [applicationId, managerId, notes]);

            await auditService.log(client, {
                actorId:    managerId,
                actorType:  'Operational',
                action:     'APPLICATION_APPROVED_MANAGER',
                entityType: 'application',
                entityId:   applicationId,
                oldValue:   { status: 'Pending' },
                newValue:   { status: 'Pending_Finance', notes },
            });

            await notificationService.createNotification(
                app.client_user_id,
                'Client',
                'Application Approved by Manager',
                `Your application for the ${app.device_name} (${app.plan_name}) has been approved by your manager and has been forwarded to Finance for budget approval.`
            );

            const financeUsers = await client.query(`
                SELECT op_user_id
                FROM operational_user
                WHERE user_role = 'Finance'
            `);

            for (const fu of financeUsers.rows) {
                await notificationService.createNotification(
                    fu.op_user_id,
                    'Operational',
                    'New Application Awaiting Finance Approval',
                    `Application #${applicationId} for ${app.applicant_first_name} ${app.applicant_last_name} — ${app.device_name} (R${app.monthly_cost}/month) has been approved by the manager and requires your financial review.`
                );
            }

            await client.query('COMMIT');

            return {
                success: true,
                message: `Application #${applicationId} has been approved and forwarded to Finance.`,
                application_id: applicationId,
                new_status: 'Pending_Finance',
            };

        } catch (error) {
            if (client) {
                await client.query('ROLLBACK');
            }
            console.error('managerApprove error:', error);
            return {success: false, message: friendlyError(error, 'approving application')};
        } finally {
            if (client) {
                client.release();
            }
        }
    }

    // ── MANAGER REJECT ─────────────────────────────────────────────────────────
    async managerReject(applicationId, managerId, rejectionReason) {
        let client = null;
        try {
            client = await db.connect();
            await client.query('BEGIN');

            const app = await getApplicationDetail(client, applicationId);
            if (!app) throw new Error(`Application #${applicationId} not found.`);

            if (app.application_status !== 'Pending') {
                throw new Error(
                    `This application cannot be rejected at the manager stage — ` +
                    `current status is "${app.application_status}".`
                );
            }

            if (!rejectionReason?.trim()) {
                throw new Error('A rejection reason is required.');
            }

            await client.query(`
                UPDATE application
                SET application_status = 'Rejected',
                    rejection_reason   = $2,
                    last_updated       = NOW()
                WHERE application_id = $1
            `, [applicationId, rejectionReason.trim()]);

            await client.query(`
                INSERT INTO approval
                (application_id, approver_op_user_id, approval_status, approval_stage, approval_date, notes)
                VALUES ($1, $2, 'Rejected', 'manager', NOW(), $3)
            `, [applicationId, managerId, rejectionReason.trim()]);

            await auditService.log(client, {
                actorId:    managerId,
                actorType:  'Operational',
                action:     'APPLICATION_REJECTED_MANAGER',
                entityType: 'application',
                entityId:   applicationId,
                oldValue:   { status: 'Pending' },
                newValue:   { status: 'Rejected', rejection_reason: rejectionReason.trim() },
            });

            await notificationService.createNotification(
                app.client_user_id,
                'Client',
                'Application Rejected by Manager',
                `Your application for the ${app.device_name} has not been approved by your manager. Reason: ${rejectionReason}. Please contact your manager if you have questions.`
            );

            await client.query('COMMIT');

            return {
                success: true,
                message: `Application #${applicationId} has been rejected.`,
                application_id: applicationId,
                new_status: 'Rejected',
            };

        } catch (error) {
            if (client) {
                await client.query('ROLLBACK');
            }
            console.error('managerReject error:', error);
            return {success: false, message: friendlyError(error, 'rejecting application')};
        } finally {
            if (client) {
                client.release();
            }
        }
    }

    // ── FINANCE QUEUE ──────────────────────────────────────────────────────────
    async getFinanceQueue(filters = {}) {
        const client = await db.connect();
        try {
            const params = ['Pending_Finance'];
            const clauses = [`a.application_status = $1`];
            let idx = 2;

            if (filters.region) {
                clauses.push(`cu.region = $${idx++}`);
                params.push(filters.region);
            }
            if (filters.department_id) {
                clauses.push(`cu.department_id = $${idx++}`);
                params.push(filters.department_id);
            }
            if (filters.date_from) {
                clauses.push(`a.submission_date >= $${idx++}`);
                params.push(filters.date_from);
            }
            if (filters.date_to) {
                clauses.push(`a.submission_date <= $${idx++}`);
                params.push(filters.date_to);
            }

            const limit = Math.min(parseInt(filters.limit || 50), 200);
            const offset = parseInt(filters.offset || 0);

            const result = await client.query(`
                SELECT a.application_id,
                       a.application_status,
                       a.submission_date,
                       a.last_updated,
                       cu.title                                                          AS applicant_title,
                       cu.first_name                                                     AS applicant_first_name,
                       cu.last_name                                                      AS applicant_last_name,
                       cu.region                                                         AS applicant_region,
                       cu.department_id,
                       cu.user_type                                                      AS applicant_type,
                       cu.persal_id,
                       d.device_name,
                       d.model,
                       d.monthly_cost,
                       d.contract_duration_months,
                       ROUND((d.monthly_cost * d.contract_duration_months):: numeric, 2) AS total_contract_value,
                       ap_mgr.notes                                                      AS manager_notes,
                       mgr.first_name                                                     AS manager_first_name,
                       mgr.last_name                                                      AS manager_last_name,
                       ap_mgr.approval_date                                               AS manager_approval_date,
                       -- Finance SLA measured from when manager approved, not submission date
                       ROUND(
                           EXTRACT(EPOCH FROM (NOW() - COALESCE(ap_mgr.approval_date, a.submission_date))) / 86400
                       )::int                                                             AS days_waiting,
                       $${idx}::int                                                       AS sla_days,
                       CASE
                           WHEN EXTRACT(EPOCH FROM (NOW() - COALESCE(ap_mgr.approval_date, a.submission_date))) / 86400 > $${idx}
                               THEN 'breached'
                           WHEN EXTRACT(EPOCH FROM (NOW() - COALESCE(ap_mgr.approval_date, a.submission_date))) / 86400 > $${idx} * 0.8
                               THEN 'approaching'
                           ELSE 'within'
                       END                                                                AS sla_status,
                       LEAST(
                           ROUND(
                               EXTRACT(EPOCH FROM (NOW() - COALESCE(ap_mgr.approval_date, a.submission_date))) / 86400
                               / NULLIF($${idx}, 0) * 100
                           )::int,
                           999
                       )                                                                  AS sla_percent_used
                FROM application a
                         JOIN client_user cu ON a.client_user_id = cu.client_user_id
                         JOIN device_catalog d ON a.device_id = d.device_id
                         LEFT JOIN approval ap_mgr ON ap_mgr.application_id = a.application_id
                    AND ap_mgr.approval_stage = 'manager'
                         LEFT JOIN operational_user mgr ON ap_mgr.approver_op_user_id = mgr.op_user_id
                WHERE ${clauses.join(' AND ')}
                ORDER BY a.submission_date ASC LIMIT $${idx + 1}
                OFFSET $${idx + 2}
            `, [...params, SLA.Pending_Finance.sla_days, limit, offset]);
            idx += 3;

            const countResult = await client.query(`
                SELECT COUNT(*) AS total
                FROM application a
                         JOIN client_user cu ON a.client_user_id = cu.client_user_id
                WHERE ${clauses.join(' AND ')}
            `, params);

            return {
                applications: result.rows,
                total: parseInt(countResult.rows[0].total),
                limit,
                offset,
            };
        } catch (error) {
            throw new Error(friendlyError(error, 'fetching finance queue'));
        } finally {
            client.release();
        }
    }

    // ── FINANCE APPROVE ────────────────────────────────────────────────────────
    async financeApprove(applicationId, financeUserId, notes = null) {
        let client = null;
        try {
            client = await db.connect();
            await client.query('BEGIN');

            const app = await getApplicationDetail(client, applicationId);
            if (!app) throw new Error(`Application #${applicationId} not found.`);

            if (app.application_status !== 'Pending_Finance') {
                throw new Error(
                    `This application cannot be approved at the finance stage — ` +
                    `current status is "${app.application_status}".`
                );
            }

            await client.query(`
                UPDATE application
                SET application_status = 'Approved',
                    last_updated       = NOW()
                WHERE application_id = $1
            `, [applicationId]);

            await client.query(`
                INSERT INTO approval
                (application_id, approver_op_user_id, approval_status, approval_stage, approval_date, notes)
                VALUES ($1, $2, 'Approved', 'finance', NOW(), $3)
            `, [applicationId, financeUserId, notes]);

            await auditService.log(client, {
                actorId:    financeUserId,
                actorType:  'Operational',
                action:     'APPLICATION_APPROVED_FINANCE',
                entityType: 'application',
                entityId:   applicationId,
                oldValue:   { status: 'Pending_Finance' },
                newValue:   { status: 'Approved', notes },
            });

            await notificationService.createNotification(
                app.client_user_id,
                'Client',
                'Application Fully Approved',
                `Great news! Your application for the ${app.device_name} (${app.plan_name}) has been fully approved. The administrator will now place the order with MTN and you will be notified when your device is on its way.`
            );

            const admins = await client.query(`
                SELECT op_user_id
                FROM operational_user
                WHERE user_role = 'Admin'
            `);

            for (const admin of admins.rows) {
                await notificationService.createNotification(
                    admin.op_user_id,
                    'Operational',
                    'New Order Ready to Place',
                    `Application #${applicationId} for ${app.applicant_first_name} ${app.applicant_last_name} — ${app.device_name} has been fully approved. Please place the MTN order.`
                );
            }

            await client.query('COMMIT');

            return {
                success: true,
                message: `Application #${applicationId} has been fully approved. Admin has been notified to place the MTN order.`,
                application_id: applicationId,
                new_status: 'Approved',
            };

        } catch (error) {
            if (client) {
                await client.query('ROLLBACK');
            }
            console.error('financeApprove error:', error);
            return {success: false, message: friendlyError(error, 'approving application')};
        } finally {
            if (client) {
                client.release();
            }
        }
    }

    // ── FINANCE REJECT ─────────────────────────────────────────────────────────
    async financeReject(applicationId, financeUserId, rejectionReason) {
        let client = null;
        try {
            client = await db.connect();
            await client.query('BEGIN');

            const app = await getApplicationDetail(client, applicationId);
            if (!app) throw new Error(`Application #${applicationId} not found.`);

            if (app.application_status !== 'Pending_Finance') {
                throw new Error(
                    `This application cannot be rejected at the finance stage — ` +
                    `current status is "${app.application_status}".`
                );
            }

            if (!rejectionReason?.trim()) {
                throw new Error('A rejection reason is required.');
            }

            await client.query(`
                UPDATE application
                SET application_status = 'Rejected',
                    rejection_reason   = $2,
                    last_updated       = NOW()
                WHERE application_id = $1
            `, [applicationId, rejectionReason.trim()]);

            await client.query(`
                INSERT INTO approval
                (application_id, approver_op_user_id, approval_status, approval_stage, approval_date, notes)
                VALUES ($1, $2, 'Rejected', 'finance', NOW(), $3)
            `, [applicationId, financeUserId, rejectionReason.trim()]);

            await auditService.log(client, {
                actorId:    financeUserId,
                actorType:  'Operational',
                action:     'APPLICATION_REJECTED_FINANCE',
                entityType: 'application',
                entityId:   applicationId,
                oldValue:   { status: 'Pending_Finance' },
                newValue:   { status: 'Rejected', rejection_reason: rejectionReason.trim() },
            });

            await notificationService.createNotification(
                app.client_user_id,
                'Client',
                'Application Rejected by Finance',
                `Unfortunately your application for the ${app.device_name} has been rejected at the finance stage. Reason: ${rejectionReason}. Please contact your regional finance office if you have questions.`
            );

            if (app.approval_history?.length) {
                const managerApproval = app.approval_history.find(h => h.approval_stage === 'manager');
                if (managerApproval) {
                    const managerRow = await client.query(
                        `SELECT op_user_id
                         FROM approval
                         WHERE application_id = $1
                           AND approval_stage = 'manager' LIMIT 1`,
                        [applicationId]
                    );
                    if (managerRow.rows.length) {
                        await notificationService.createNotification(
                            managerRow.rows[0].op_user_id,
                            'Operational',
                            'Application Rejected at Finance Stage',
                            `Application #${applicationId} that you approved has been rejected by Finance. Reason: ${rejectionReason}.`
                        );
                    }
                }
            }

            await client.query('COMMIT');

            return {
                success: true,
                message: `Application #${applicationId} has been rejected at the finance stage.`,
                application_id: applicationId,
                new_status: 'Rejected',
            };

        } catch (error) {
            if (client) {
                await client.query('ROLLBACK');
            }
            console.error('financeReject error:', error);
            return {success: false, message: friendlyError(error, 'rejecting application')};
        } finally {
            if (client) {
                client.release();
            }
        }
    }

    // ── APPLICATION HISTORY ────────────────────────────────────────────────────
    async getApplicationHistory(applicationId) {
        try {
            const result = await db.query(`
                SELECT ap.approval_id,
                       ap.approval_stage,
                       ap.approval_status,
                       ap.approval_date,
                       ap.notes,
                       ou.first_name AS approver_first_name,
                       ou.last_name  AS approver_last_name,
                       ou.user_role  AS approver_role,
                       ou.email      AS approver_email
                FROM approval ap
                         JOIN operational_user ou ON ap.approver_op_user_id = ou.op_user_id
                WHERE ap.application_id = $1
                ORDER BY ap.approval_date ASC
            `, [applicationId]);

            return result.rows;
        } catch (error) {
            throw new Error(friendlyError(error, 'fetching application history'));
        }
    }
    // ── MY CLIENTS — clients in the same department as the caller ─────────────
    async getClientsByDepartment(departmentId, filters = {}) {
        const client = await db.connect();
        try {
            const params  = [departmentId];
            const clauses = [`cu.department_id = $1`];
            let idx = 2;

            if (filters.registration_status) {
                clauses.push(`cu.registration_status = $${idx++}`);
                params.push(filters.registration_status);
            }

            const limit  = Math.min(parseInt(filters.limit  || 50), 200);
            const offset = parseInt(filters.offset || 0);

            const result = await client.query(`
                SELECT
                    cu.client_user_id,
                    cu.title,
                    cu.first_name,
                    cu.last_name,
                    cu.email,
                    cu.phone_number,
                    cu.region,
                    cu.persal_id,
                    cu.department_id,
                    cu.user_type,
                    cu.registration_status,
                    cu.created_at,
                    COUNT(a.application_id)                                            AS total_applications,
                    COUNT(a.application_id) FILTER (WHERE a.application_status = 'Pending')          AS pending,
                    COUNT(a.application_id) FILTER (WHERE a.application_status = 'Pending_Finance')  AS pending_finance,
                    COUNT(a.application_id) FILTER (WHERE a.application_status = 'Approved')         AS approved,
                    COUNT(a.application_id) FILTER (WHERE a.application_status = 'Rejected')         AS rejected
                FROM client_user cu
                LEFT JOIN application a ON a.client_user_id = cu.client_user_id
                WHERE ${clauses.join(' AND ')}
                GROUP BY cu.client_user_id
                ORDER BY cu.last_name ASC
                LIMIT $${idx} OFFSET $${idx + 1}
            `, [...params, limit, offset]);

            const countResult = await client.query(`
                SELECT COUNT(*) AS total
                FROM client_user cu
                WHERE ${clauses.join(' AND ')}
            `, params);

            return {
                clients:     result.rows,
                total:       parseInt(countResult.rows[0].total),
                department:  departmentId,
                limit,
                offset,
            };
        } catch (error) {
            throw new Error(friendlyError(error, 'fetching department clients'));
        } finally {
            client.release();
        }
    }
}

module.exports = new ApproverService();