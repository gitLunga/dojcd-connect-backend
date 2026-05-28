// services/applicationService.js
const db = require('../../config/db');
const NotificationService = require('../notificationService');
const auditService        = require('../auditService');

// ─── Utility: map raw errors to friendly messages ─────────────────────────────
function friendlyError(error, context = 'operation') {
    const msg = error.message || '';

    if (msg.includes('duplicate key')) {
        return 'A duplicate record was detected. Please check and try again.';
    }
    if (msg.includes('connect') || msg.includes('ECONNREFUSED')) {
        return 'We are having trouble reaching the server. Please try again shortly.';
    }
    if (msg.includes('not found') || msg.includes('not found')) {
        return msg;
    }

    console.error(`❌ ApplicationService error [${context}]:`, error);
    return `We could not complete this ${context}. Please try again.`;
}

class ApplicationService {

    // ─── ELIGIBILITY ──────────────────────────────────────────────────────────

    async checkUserEligibility(clientUserId) {
        try {
            const result = await db.query(
                `SELECT registration_status FROM client_user WHERE client_user_id = $1`,
                [clientUserId]
            );

            if (result.rows.length === 0) {
                return { eligible: false, reason: 'Your account could not be found. Please log in again.' };
            }

            const { registration_status } = result.rows[0];

            if (registration_status !== 'Verified') {
                const statusMessages = {
                    Pending: 'Your account is still pending review. You will be able to apply once your account has been verified.',
                    Profile_Completed: 'Your profile is under review. You will be notified once verification is complete.',
                    Rejected: 'Unfortunately your account verification was not successful. Please contact support for assistance.'
                };
                return {
                    eligible: false,
                    reason: statusMessages[registration_status] ||
                        `Your account status is "${registration_status}". Only verified accounts can submit applications.`
                };
            }

            return { eligible: true };
        } catch (error) {
            console.error('Error checking eligibility:', error);
            throw new Error(friendlyError(error, 'eligibility check'));
        }
    }

    // ─── DEVICES ──────────────────────────────────────────────────────────────

    async getAvailableDevices() {
        try {
            const result = await db.query(`
                SELECT device_id, device_name, model, manufacturer,
                       plan_name, plan_details, monthly_cost,
                       contract_duration_months, status
                FROM device_catalog
                WHERE status = 'active'
                ORDER BY monthly_cost
            `);
            return result.rows;
        } catch (error) {
            throw new Error(friendlyError(error, 'fetching active devices'));
        }
    }

    async getDeviceById(deviceId) {
        try {
            const result = await db.query(
                `SELECT * FROM device_catalog WHERE device_id = $1 AND status = 'active'`,
                [deviceId]
            );

            if (result.rows.length === 0) {
                throw new Error('The selected device is no longer active. Please choose a different device.');
            }

            return result.rows[0];
        } catch (error) {
            if (error.message.includes('no longer active')) throw error;
            throw new Error(friendlyError(error, 'fetching device details'));
        }
    }

    // ─── SUBMIT APPLICATION ───────────────────────────────────────────────────

    async submitApplication(clientUserId, deviceId) {
        const client = await db.connect();

        try {
            await client.query('BEGIN');

            // 1. Check user eligibility
            const eligibility = await this.checkUserEligibility(clientUserId);
            if (!eligibility.eligible) {
                throw new Error(eligibility.reason);
            }

            // 2. Check device availability
            const device = await this.getDeviceById(deviceId);

            // 3. Check for existing pending application for same device
            const existingApp = await client.query(`
                SELECT application_id FROM application
                WHERE client_user_id = $1 AND device_id = $2 AND application_status = 'Pending'
            `, [clientUserId, deviceId]);

            if (existingApp.rows.length > 0) {
                throw new Error(`You already have a pending application for the ${device.device_name}. Please wait for it to be reviewed before applying again.`);
            }

            // 4. Insert application
            const result = await client.query(`
                INSERT INTO application (
                    client_user_id, device_id, application_status,
                    submission_date, last_updated
                ) VALUES ($1, $2, 'Pending', NOW(), NOW())
                    RETURNING *
            `, [clientUserId, deviceId]);

            const application = result.rows[0];
            const applicationId = application.application_id;

            // 5. Audit
            await auditService.log(client, {
                actorId:    clientUserId,
                actorType:  'Client',
                action:     'APPLICATION_SUBMITTED',
                entityType: 'application',
                entityId:   applicationId,
                newValue:   { device_id: deviceId, status: 'Pending' },
            });

            // 6. Notify the client
            await NotificationService.createNotification(
                clientUserId,
                'Client',
                'Application Submitted',
                `Your application for the ${device.device_name} (${device.plan_name}) has been submitted successfully. We will review it and get back to you soon.`
            );

            // 7. Notify Managers (Approver 1) — they review first
            const managersResult = await client.query(`
                SELECT op_user_id FROM operational_user
                WHERE user_role IN ('Manager', 'Admin')
            `);

            for (const mgr of managersResult.rows) {
                await NotificationService.createNotification(
                    mgr.op_user_id,
                    'Operational',
                    'New Application Awaiting Manager Review',
                    `Application #${applicationId} for ${device.device_name} (${device.plan_name}) has been submitted and is awaiting manager review.`
                );
            }

            await client.query('COMMIT');

            return {
                success: true,
                application,
                message: `Your application for the ${device.device_name} has been submitted successfully! We will review it and notify you of the outcome.`
            };

        } catch (error) {
            await client.query('ROLLBACK');
            console.error('Error submitting application:', error);
            return {
                success: false,
                message: error.message.includes('Please') || error.message.includes('already have') || error.message.includes('no longer')
                    ? error.message
                    : friendlyError(error, 'submitting your application')
            };
        } finally {
            client.release();
        }
    }

    // ─── GET USER APPLICATIONS ────────────────────────────────────────────────

    async getUserApplications(clientUserId) {
        try {
            const result = await db.query(`
                SELECT
                    a.application_id, a.application_status,
                    a.submission_date, a.last_updated, a.rejection_reason,
                    d.device_name, d.model, d.manufacturer,
                    d.plan_name, d.plan_details, d.monthly_cost,
                    d.contract_duration_months
                FROM application a
                         JOIN device_catalog d ON a.device_id = d.device_id
                WHERE a.client_user_id = $1
                ORDER BY a.submission_date DESC
            `, [clientUserId]);

            return result.rows;
        } catch (error) {
            throw new Error(friendlyError(error, 'fetching your applications'));
        }
    }

    // ─── CANCEL APPLICATION ───────────────────────────────────────────────────

    async cancelApplication(applicationId, clientUserId) {
        const client = await db.connect();

        try {
            await client.query('BEGIN');

            const checkResult = await client.query(`
                SELECT application_status FROM application
                WHERE application_id = $1 AND client_user_id = $2
            `, [applicationId, clientUserId]);

            if (checkResult.rows.length === 0) {
                throw new Error('Application not found or you do not have permission to cancel it.');
            }

            const currentStatus = checkResult.rows[0].application_status;

            if (currentStatus !== 'Pending') {
                const statusMessages = {
                    Approved: 'This application has already been approved and cannot be cancelled.',
                    Rejected: 'This application has already been rejected.',
                    Cancelled: 'This application has already been cancelled.'
                };
                throw new Error(statusMessages[currentStatus] || `Applications with status "${currentStatus}" cannot be cancelled.`);
            }

            const updateResult = await client.query(`
                UPDATE application
                SET application_status = 'Cancelled', last_updated = NOW()
                WHERE application_id = $1
                    RETURNING *
            `, [applicationId]);

            await auditService.log(client, {
                actorId:    clientUserId,
                actorType:  'Client',
                action:     'APPLICATION_CANCELLED',
                entityType: 'application',
                entityId:   applicationId,
                oldValue:   { status: 'Pending' },
                newValue:   { status: 'Cancelled' },
            });

            await NotificationService.createNotification(
                clientUserId,
                'Client',
                'Application Cancelled',
                `Your application #${applicationId} has been cancelled successfully.`
            );

            const staffResult = await client.query(`
                SELECT op_user_id FROM operational_user
                WHERE user_role IN ('Manager', 'Admin')
            `);

            for (const staff of staffResult.rows) {
                await NotificationService.createNotification(
                    staff.op_user_id,
                    'Operational',
                    'Application Cancelled by User',
                    `Application #${applicationId} has been cancelled by the applicant.`
                );
            }

            await client.query('COMMIT');

            return {
                success: true,
                application: updateResult.rows[0],
                message: 'Your application has been cancelled successfully.'
            };

        } catch (error) {
            await client.query('ROLLBACK');
            console.error('Error cancelling application:', error);
            return {
                success: false,
                message: error.message.includes('already') || error.message.includes('permission') || error.message.includes('cannot')
                    ? error.message
                    : friendlyError(error, 'cancelling your application')
            };
        } finally {
            client.release();
        }
    }

    // ─── GET APPLICATION DETAILS ──────────────────────────────────────────────

    async getApplicationDetails(applicationId, clientUserId) {
        try {
            const result = await db.query(`
                SELECT
                    a.*, d.device_name, d.model, d.manufacturer,
                    d.plan_name, d.plan_details, d.monthly_cost,
                    d.contract_duration_months, cu.first_name, cu.last_name,
                    cu.email, cu.phone_number, cu.region, cu.persal_id
                FROM application a
                         JOIN device_catalog d ON a.device_id = d.device_id
                         JOIN client_user cu ON a.client_user_id = cu.client_user_id
                WHERE a.application_id = $1 AND a.client_user_id = $2
            `, [applicationId, clientUserId]);

            if (result.rows.length === 0) {
                throw new Error('Application not found.');
            }

            return result.rows[0];
        } catch (error) {
            if (error.message.includes('not found')) throw error;
            throw new Error(friendlyError(error, 'fetching application details'));
        }
    }

    // ─── APPLICATION SUMMARY ──────────────────────────────────────────────────

    async getApplicationSummary(clientUserId) {
        try {
            const result = await db.query(`
                SELECT
                    COALESCE(COUNT(*), 0) as total_applications,
                    COALESCE(SUM(CASE WHEN application_status = 'Pending' THEN 1 ELSE 0 END), 0) as pending,
                    COALESCE(SUM(CASE WHEN application_status = 'Approved' THEN 1 ELSE 0 END), 0) as approved,
                    COALESCE(SUM(CASE WHEN application_status = 'Rejected' THEN 1 ELSE 0 END), 0) as rejected,
                    COALESCE(SUM(CASE WHEN application_status = 'Cancelled' THEN 1 ELSE 0 END), 0) as cancelled
                FROM application
                WHERE client_user_id = $1
            `, [clientUserId]);

            return result.rows[0] || {
                total_applications: 0, pending: 0,
                approved: 0, rejected: 0, cancelled: 0
            };
        } catch (error) {
            throw new Error(friendlyError(error, 'fetching your application summary'));
        }
    }

    // ─── ADMIN: GET ALL APPLICATIONS ──────────────────────────────────────────

    async getAllApplications(filters = {}) {
        try {
            let query = `
                SELECT
                    a.application_id, a.client_user_id, a.device_id,
                    a.application_status, a.submission_date, a.last_updated,
                    a.rejection_reason, d.device_name, d.model, d.manufacturer,
                    d.plan_name, d.monthly_cost, d.contract_duration_months,
                    cu.first_name, cu.last_name, cu.email, cu.phone_number,
                    cu.region, cu.persal_id, cu.registration_status,
                    cu.user_type, cu.department_id,
                    ap.approval_status, ap.approver_op_user_id, ap.approval_date,
                    o.order_status, o.order_date
                FROM application a
                         JOIN device_catalog d ON a.device_id = d.device_id
                         JOIN client_user cu ON a.client_user_id = cu.client_user_id
                         LEFT JOIN approval ap ON a.application_id = ap.application_id
                         LEFT JOIN "order" o ON a.application_id = o.application_id
                WHERE 1=1
            `;

            const params = [];
            let paramCount = 0;

            if (filters.status) {
                paramCount++;
                query += ` AND a.application_status = $${paramCount}`;
                params.push(filters.status);
            }
            if (filters.device_id) {
                paramCount++;
                query += ` AND a.device_id = $${paramCount}`;
                params.push(parseInt(filters.device_id));
            }
            if (filters.user_id) {
                paramCount++;
                query += ` AND a.client_user_id = $${paramCount}`;
                params.push(parseInt(filters.user_id));
            }
            if (filters.user_type) {
                paramCount++;
                query += ` AND cu.user_type = $${paramCount}`;
                params.push(filters.user_type);
            }
            if (filters.region) {
                paramCount++;
                query += ` AND cu.region = $${paramCount}`;
                params.push(filters.region);
            }
            if (filters.start_date) {
                paramCount++;
                query += ` AND a.submission_date >= $${paramCount}`;
                params.push(filters.start_date);
            }
            if (filters.end_date) {
                paramCount++;
                query += ` AND a.submission_date <= $${paramCount}`;
                params.push(filters.end_date);
            }

            query += ` ORDER BY a.submission_date DESC`;

            if (filters.limit) {
                paramCount++;
                query += ` LIMIT $${paramCount}`;
                params.push(parseInt(filters.limit));
            }
            if (filters.offset) {
                paramCount++;
                query += ` OFFSET $${paramCount}`;
                params.push(parseInt(filters.offset));
            }

            const result = await db.query(query, params);
            return { success: true, data: result.rows, count: result.rows.length };
        } catch (error) {
            throw new Error(friendlyError(error, 'fetching applications'));
        }
    }

    // ─── ADMIN: UPDATE APPLICATION STATUS ────────────────────────────────────

    async updateApplicationStatus(applicationId, statusData, approverId = null) {
        const client = await db.connect();

        try {
            await client.query('BEGIN');

            const checkResult = await client.query(`
                SELECT application_status, client_user_id, device_id
                FROM application WHERE application_id = $1
            `, [applicationId]);

            if (checkResult.rows.length === 0) {
                throw new Error('Application not found.');
            }

            const application = checkResult.rows[0];
            const currentStatus = application.application_status;
            const clientUserId = application.client_user_id;

            // ✅ Lock: already-finalised applications cannot be re-processed
            if ((currentStatus === 'Approved' || currentStatus === 'Rejected' || currentStatus === 'Cancelled') &&
                statusData.status !== currentStatus) {
                const label = currentStatus.toLowerCase();
                throw new Error(`This application has already been ${label} and cannot be changed again.`);
            }

            const validStatuses = ['Pending', 'Pending_Finance', 'Approved', 'Rejected', 'Cancelled'];
            if (!validStatuses.includes(statusData.status)) {
                throw new Error(`"${statusData.status}" is not a valid status.`);
            }

            // Get device info for notification messages
            const deviceResult = await client.query(
                `SELECT device_name, plan_name FROM device_catalog WHERE device_id = $1`,
                [application.device_id]
            );
            const device = deviceResult.rows[0] || { device_name: 'device', plan_name: '' };

            if (statusData.status === 'Approved') {
                // ── Admin cannot directly approve ────────────────────────────
                // Final approval must go through: Manager → Finance → Approved.
                // Admin role here is oversight only. Use the approver dashboards.
                throw new Error(
                    'Applications must be approved through the approval workflow: ' +
                    'Manager review first, then Finance approval. ' +
                    'Direct admin approval is not permitted.'
                );

            } else if (statusData.status === 'Pending_Finance') {
                // ── Admin can manually forward to Finance if needed ───────────
                await client.query(`
                    UPDATE application
                    SET application_status = 'Pending_Finance', last_updated = NOW()
                    WHERE application_id = $1
                `, [applicationId]);

                const financeUsers = await client.query(`
                    SELECT op_user_id FROM operational_user WHERE user_role = 'Finance'
                `);
                for (const fu of financeUsers.rows) {
                    await NotificationService.createNotification(
                        fu.op_user_id, 'Operational', 'Application Forwarded to Finance',
                        `Application #${applicationId} for ${device.device_name} has been forwarded for financial review by an administrator.`
                    );
                }

            } else if (statusData.status === 'Rejected') {
                if (!statusData.rejection_reason) {
                    throw new Error('Please provide a reason for rejecting this application.');
                }

                await client.query(`
                    UPDATE application
                    SET application_status = 'Rejected', rejection_reason = $2, last_updated = NOW()
                    WHERE application_id = $1
                `, [applicationId, statusData.rejection_reason]);

                if (approverId) {
                    await client.query(`
                        INSERT INTO approval (application_id, approver_op_user_id, approval_status, approval_date, notes)
                        VALUES ($1, $2, 'Rejected', NOW(), $3)
                    `, [applicationId, approverId, statusData.rejection_reason]);
                }

                await NotificationService.createNotification(
                    clientUserId, 'Client', 'Application Update',
                    `We regret to inform you that your application for the ${device.device_name} was not successful. Reason: ${statusData.rejection_reason}. Please contact support if you have questions.`
                );

            } else if (statusData.status === 'Cancelled') {
                if (currentStatus !== 'Pending' && !statusData.is_admin) {
                    throw new Error('Only an admin can cancel an application that is not pending.');
                }

                await client.query(`
                    UPDATE application
                    SET application_status = 'Cancelled', last_updated = NOW()
                    WHERE application_id = $1
                `, [applicationId]);

            } else {
                await client.query(`
                    UPDATE application
                    SET application_status = $2, last_updated = NOW()
                    WHERE application_id = $1
                `, [applicationId, statusData.status]);
            }

            const updatedAppResult = await client.query(`
                SELECT a.*, d.device_name, d.model, d.manufacturer, d.plan_name,
                       cu.first_name, cu.last_name, cu.email
                FROM application a
                         JOIN device_catalog d ON a.device_id = d.device_id
                         JOIN client_user cu ON a.client_user_id = cu.client_user_id
                WHERE a.application_id = $1
            `, [applicationId]);

            await auditService.log(client, {
                actorId:    approverId || 0,
                actorType:  'Operational',
                action:     'APPLICATION_STATUS_UPDATED',
                entityType: 'application',
                entityId:   applicationId,
                oldValue:   { status: currentStatus },
                newValue:   { status: statusData.status, rejection_reason: statusData.rejection_reason || null },
            });

            await client.query('COMMIT');

            const successMessages = {
                Approved: `Application #${applicationId} has been approved successfully.`,
                Rejected: `Application #${applicationId} has been rejected.`,
                Cancelled: `Application #${applicationId} has been cancelled.`,
            };

            return {
                success: true,
                application: updatedAppResult.rows[0],
                message: successMessages[statusData.status] || `Application status updated to ${statusData.status}.`
            };

        } catch (error) {
            await client.query('ROLLBACK');
            console.error('Error updating application status:', error);
            return {
                success: false,
                message: error.message.includes('already been') || error.message.includes('Please') || error.message.includes('not found')
                    ? error.message
                    : friendlyError(error, 'updating application status')
            };
        } finally {
            client.release();
        }
    }

    // ─── ADMIN: STATISTICS ────────────────────────────────────────────────────

    async getApplicationStatistics(filters = {}) {
        try {
            let query = `
                SELECT
                    COUNT(*) as total_applications,
                    COALESCE(SUM(CASE WHEN application_status = 'Pending' THEN 1 ELSE 0 END), 0) as pending,
                    COALESCE(SUM(CASE WHEN application_status = 'Approved' THEN 1 ELSE 0 END), 0) as approved,
                    COALESCE(SUM(CASE WHEN application_status = 'Rejected' THEN 1 ELSE 0 END), 0) as rejected,
                    COALESCE(SUM(CASE WHEN application_status = 'Cancelled' THEN 1 ELSE 0 END), 0) as cancelled,
                    COUNT(DISTINCT client_user_id) as unique_users,
                    COALESCE(AVG(
                                     CASE WHEN application_status = 'Approved'
                                              THEN EXTRACT(EPOCH FROM (last_updated - submission_date))/86400
                                          ELSE NULL END
                             ), 0) as avg_processing_days
                FROM application WHERE 1=1
            `;

            const params = [];
            let paramCount = 0;

            if (filters.start_date) {
                paramCount++;
                query += ` AND submission_date >= $${paramCount}`;
                params.push(filters.start_date);
            }
            if (filters.end_date) {
                paramCount++;
                query += ` AND submission_date <= $${paramCount}`;
                params.push(filters.end_date);
            }
            if (filters.region) {
                paramCount++;
                query += ` AND client_user_id IN (SELECT client_user_id FROM client_user WHERE region = $${paramCount})`;
                params.push(filters.region);
            }

            const [result, deviceStats, userTypeStats, trendStats] = await Promise.all([
                db.query(query, params),
                db.query(`
                    SELECT d.device_name, d.manufacturer, d.plan_name,
                           COUNT(a.application_id) as total_applications,
                           COALESCE(SUM(CASE WHEN a.application_status = 'Approved' THEN 1 ELSE 0 END), 0) as approved_count,
                           COALESCE(SUM(CASE WHEN a.application_status = 'Rejected' THEN 1 ELSE 0 END), 0) as rejected_count,
                           COALESCE(SUM(CASE WHEN a.application_status = 'Pending' THEN 1 ELSE 0 END), 0) as pending_count
                    FROM device_catalog d
                             LEFT JOIN application a ON d.device_id = a.device_id
                    GROUP BY d.device_id, d.device_name, d.manufacturer, d.plan_name
                    ORDER BY total_applications DESC
                `),
                db.query(`
                    SELECT cu.user_type,
                           COUNT(a.application_id) as total_applications,
                           COALESCE(SUM(CASE WHEN a.application_status = 'Approved' THEN 1 ELSE 0 END), 0) as approved_count,
                           COALESCE(SUM(CASE WHEN a.application_status = 'Rejected' THEN 1 ELSE 0 END), 0) as rejected_count
                    FROM client_user cu
                             LEFT JOIN application a ON cu.client_user_id = a.client_user_id
                    GROUP BY cu.user_type ORDER BY total_applications DESC
                `),
                db.query(`
                    SELECT DATE(submission_date) as date, COUNT(*) as applications,
                        COALESCE(SUM(CASE WHEN application_status = 'Approved' THEN 1 ELSE 0 END), 0) as approved,
                        COALESCE(SUM(CASE WHEN application_status = 'Rejected' THEN 1 ELSE 0 END), 0) as rejected
                    FROM application
                    WHERE submission_date >= CURRENT_DATE - INTERVAL '30 days'
                    GROUP BY DATE(submission_date) ORDER BY date
                `)
            ]);

            return {
                success: true,
                data: {
                    summary: result.rows[0],
                    device_stats: deviceStats.rows,
                    user_type_stats: userTypeStats.rows,
                    trend: trendStats.rows
                }
            };
        } catch (error) {
            throw new Error(friendlyError(error, 'fetching application statistics'));
        }
    }

    // ─── ADMIN: APPLICATION DETAILS ───────────────────────────────────────────

    async getAdminApplicationDetails(applicationId) {
        try {
            const result = await db.query(`
                SELECT
                    a.application_id, a.application_status, a.submission_date,
                    a.last_updated, a.rejection_reason,
                    d.device_id, d.device_name, d.model, d.manufacturer,
                    d.plan_name, d.plan_details, d.monthly_cost, d.contract_duration_months,
                    cu.client_user_id, cu.title as user_title, cu.first_name, cu.last_name,
                    cu.email, cu.phone_number, cu.region, cu.persal_id,
                    cu.department_id, cu.user_type, cu.registration_status,
                    ap.approval_id, ap.approval_status, ap.approval_date,
                    ap.notes as approval_notes,
                    approver.first_name as approver_first_name,
                    approver.last_name as approver_last_name,
                    approver.email as approver_email,
                    o.order_id, o.order_status, o.order_date,
                    mtn_staff.first_name as mtn_staff_first_name,
                    mtn_staff.last_name as mtn_staff_last_name,
                    (SELECT COUNT(*) FROM document doc WHERE doc.application_id = a.application_id) as document_count,
                    del.delivery_status, del.tracking_number, del.estimated_delivery_date
                FROM application a
                         JOIN device_catalog d ON a.device_id = d.device_id
                         JOIN client_user cu ON a.client_user_id = cu.client_user_id
                         LEFT JOIN approval ap ON a.application_id = ap.application_id
                         LEFT JOIN operational_user approver ON ap.approver_op_user_id = approver.op_user_id
                         LEFT JOIN "order" o ON a.application_id = o.application_id
                         LEFT JOIN operational_user mtn_staff ON o.mtn_staff_op_user_id = mtn_staff.op_user_id
                         LEFT JOIN delivery del ON o.order_id = del.order_id
                WHERE a.application_id = $1
            `, [applicationId]);

            if (result.rows.length === 0) {
                throw new Error('Application not found.');
            }

            const documents = await db.query(`
                SELECT document_id, document_type, upload_date
                FROM document WHERE application_id = $1
                ORDER BY upload_date DESC
            `, [applicationId]);

            const application = result.rows[0];
            application.documents = documents.rows;

            return application;
        } catch (error) {
            if (error.message.includes('not found')) throw error;
            throw new Error(friendlyError(error, 'fetching application details'));
        }
    }

    async placeOrder(applicationId, adminOpUserId, notes = null) {
        const client = await db.connect();
        try {
            await client.query('BEGIN');

            // 1. Fetch application + device + client details
            const appResult = await client.query(`
                SELECT
                    a.application_id,
                    a.application_status,
                    a.client_user_id,
                    d.device_name,
                    d.plan_name,
                    cu.first_name AS client_first_name,
                    cu.last_name  AS client_last_name
                FROM application a
                JOIN device_catalog d ON a.device_id = d.device_id
                JOIN client_user cu   ON a.client_user_id = cu.client_user_id
                WHERE a.application_id = $1
            `, [applicationId]);

            if (appResult.rows.length === 0) {
                throw new Error(`Application #${applicationId} not found.`);
            }

            const app = appResult.rows[0];

            // 2. Guard: must be Approved
            if (app.application_status !== 'Approved') {
                return {
                    success: false,
                    message: `This application cannot be ordered — current status is "${app.application_status}". Only fully approved applications can have an order placed.`
                };
            }

            // 3. Guard: prevent duplicate order
            const existingOrder = await client.query(`
                SELECT order_id FROM "order" WHERE application_id = $1 LIMIT 1
            `, [applicationId]);

            if (existingOrder.rows.length > 0) {
                return {
                    success: false,
                    message: `An order has already been placed for Application #${applicationId} (Order #${existingOrder.rows[0].order_id}).`
                };
            }

            // 4. Insert the order row
            const orderResult = await client.query(`
                INSERT INTO "order" (application_id, mtn_staff_op_user_id, order_status, order_date, notes)
                VALUES ($1, $2, 'Processing', NOW(), $3)
                RETURNING order_id, order_status, order_date
            `, [applicationId, adminOpUserId, notes]);

            const order = orderResult.rows[0];

            // 5. Audit
            await auditService.log(client, {
                actorId:    adminOpUserId,
                actorType:  'Operational',
                action:     'ORDER_PLACED',
                entityType: 'order',
                entityId:   order.order_id,
                newValue:   { application_id: applicationId, order_status: 'Processing' },
            });

            // 6. Notify client
            await NotificationService.createNotification(
                app.client_user_id,
                'Client',
                'Your Order Has Been Placed with MTN',
                `Great news, ${app.client_first_name}! Your order for the ${app.device_name} (${app.plan_name}) has been ` +
                `placed with MTN. You will receive another notification once your device is on its way. ` +
                `Order reference: #${order.order_id}.`
            );

            await client.query('COMMIT');

            return {
                success: true,
                message: `Order #${order.order_id} has been successfully placed with MTN for Application #${applicationId} and is now being processed.`,
                order: {
                    order_id:       order.order_id,
                    order_status:   order.order_status,
                    order_date:     order.order_date,
                    application_id: applicationId,
                }
            };

        } catch (error) {
            await client.query('ROLLBACK');
            console.error('placeOrder error:', error);
            if (error.message.includes('not found')) return { success: false, message: error.message };
            return { success: false, message: friendlyError(error, 'placing order') };
        } finally {
            client.release();
        }
    }

}

module.exports = new ApplicationService();