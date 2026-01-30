// services/applicationService.js
const db = require('../../config/db');

class ApplicationService {
    /**
     * Check if user can apply
     * Why: Users must be verified before applying
     */
    async checkUserEligibility(clientUserId) {
        try {
            const result = await db.query(`
                SELECT registration_status 
                FROM client_user 
                WHERE client_user_id = $1
            `, [clientUserId]);

            if (result.rows.length === 0) {
                return { eligible: false, reason: 'User not found' };
            }

            const user = result.rows[0];

            if (user.registration_status !== 'Verified') {
                return {
                    eligible: false,
                    reason: `Account status: ${user.registration_status}. Must be 'Verified' to apply.`
                };
            }

            return { eligible: true };
        } catch (error) {
            console.error('Error checking eligibility:', error);
            throw error;
        }
    }

    /**
     * Get available devices
     * Why: Users need to see available devices with their bundled plans
     */
    async getAvailableDevices() {
        try {
            const result = await db.query(`
                SELECT 
                    device_id,
                    device_name,
                    model,
                    manufacturer,
                    plan_name,
                    plan_details,
                    monthly_cost,
                    contract_duration_months,
                    status
                FROM device_catalog
                WHERE status = 'Available'
                ORDER BY monthly_cost
            `);

            return result.rows;
        } catch (error) {
            console.error('Error getting devices:', error);
            throw error;
        }
    }

    /**
     * Get device details by ID
     * Why: User needs to see full details before applying
     */
    async getDeviceById(deviceId) {
        try {
            const result = await db.query(`
                SELECT * FROM device_catalog
                WHERE device_id = $1 AND status = 'Available'
            `, [deviceId]);

            if (result.rows.length === 0) {
                throw new Error('Device not found or unavailable');
            }

            return result.rows[0];
        } catch (error) {
            console.error('Error getting device:', error);
            throw error;
        }
    }

    /**
     * Submit new application
     * Why: This is the core function - creates application record
     * Note: Follows your exact database schema
     */
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
                WHERE client_user_id = $1 
                AND device_id = $2 
                AND application_status = 'Pending'
            `, [clientUserId, deviceId]);

            if (existingApp.rows.length > 0) {
                throw new Error('You already have a pending application for this device');
            }

            // 4. Insert into application table (following your schema exactly)
            const result = await client.query(`
                INSERT INTO application (
                    client_user_id,
                    device_id,
                    application_status,
                    submission_date,
                    last_updated
                ) VALUES ($1, $2, 'Pending', NOW(), NOW())
                RETURNING *
            `, [clientUserId, deviceId]);

            const application = result.rows[0];

            await client.query('COMMIT');

            return {
                success: true,
                application: application,
                message: 'Application submitted successfully. Status: Pending'
            };

        } catch (error) {
            await client.query('ROLLBACK');
            console.error('Error submitting application:', error);
            return {
                success: false,
                message: error.message
            };
        } finally {
            client.release();
        }
    }

    /**
     * Get user's applications
     * Why: Users need to track their applications
     */
    async getUserApplications(clientUserId) {
        try {
            const result = await db.query(`
                SELECT 
                    a.application_id,
                    a.application_status,
                    a.submission_date,
                    a.last_updated,
                    a.rejection_reason,
                    d.device_name,
                    d.model,
                    d.manufacturer,
                    d.plan_name,
                    d.plan_details,
                    d.monthly_cost,
                    d.contract_duration_months
                FROM application a
                JOIN device_catalog d ON a.device_id = d.device_id
                WHERE a.client_user_id = $1
                ORDER BY a.submission_date DESC
            `, [clientUserId]);

            return result.rows;
        } catch (error) {
            console.error('Error getting user applications:', error);
            throw error;
        }
    }

    /**
     * Cancel application
     * Why: Users should be able to cancel pending applications
     */
    async cancelApplication(applicationId, clientUserId) {
        const client = await db.connect();

        try {
            await client.query('BEGIN');

            // Check if application exists and belongs to user
            const checkResult = await client.query(`
                SELECT application_status 
                FROM application 
                WHERE application_id = $1 AND client_user_id = $2
            `, [applicationId, clientUserId]);

            if (checkResult.rows.length === 0) {
                throw new Error('Application not found or unauthorized');
            }

            const currentStatus = checkResult.rows[0].application_status;

            // Only allow cancellation if pending
            if (currentStatus !== 'Pending') {
                throw new Error(`Cannot cancel application with status: ${currentStatus}`);
            }

            // Update application status (following your schema)
            const updateResult = await client.query(`
                UPDATE application 
                SET application_status = 'Cancelled',
                    last_updated = NOW()
                WHERE application_id = $1
                RETURNING *
            `, [applicationId]);

            await client.query('COMMIT');

            return {
                success: true,
                application: updateResult.rows[0],
                message: 'Application cancelled successfully'
            };

        } catch (error) {
            await client.query('ROLLBACK');
            console.error('Error cancelling application:', error);
            return {
                success: false,
                message: error.message
            };
        } finally {
            client.release();
        }
    }

    /**
     * Get application details
     * Why: User needs to see detailed application information
     */
    async getApplicationDetails(applicationId, clientUserId) {
        try {
            const result = await db.query(`
                SELECT 
                    a.*,
                    d.device_name,
                    d.model,
                    d.manufacturer,
                    d.plan_name,
                    d.plan_details,
                    d.monthly_cost,
                    d.contract_duration_months,
                    cu.first_name,
                    cu.last_name,
                    cu.email,
                    cu.phone_number,
                    cu.region,
                    cu.persal_id
                FROM application a
                JOIN device_catalog d ON a.device_id = d.device_id
                JOIN client_user cu ON a.client_user_id = cu.client_user_id
                WHERE a.application_id = $1 AND a.client_user_id = $2
            `, [applicationId, clientUserId]);

            if (result.rows.length === 0) {
                throw new Error('Application not found');
            }

            return result.rows[0];
        } catch (error) {
            console.error('Error getting application details:', error);
            throw error;
        }
    }

    /**
     * Check user's application status summary
     * Why: For dashboard display
     */
    async getApplicationSummary(clientUserId) {
        try {
            const result = await db.query(`
                SELECT COALESCE(COUNT(*), 0)                                                          as total_applications,
                       COALESCE(SUM(CASE WHEN application_status = 'Pending' THEN 1 ELSE 0 END), 0)   as pending,
                       COALESCE(SUM(CASE WHEN application_status = 'Approved' THEN 1 ELSE 0 END), 0)  as approved,
                       COALESCE(SUM(CASE WHEN application_status = 'Rejected' THEN 1 ELSE 0 END), 0)  as rejected,
                       COALESCE(SUM(CASE WHEN application_status = 'Cancelled' THEN 1 ELSE 0 END), 0) as cancelled
                FROM application
                WHERE client_user_id = $1
            `, [clientUserId]);

            // If no applications exist, return default values
            const summary = result.rows[0] || {
                total_applications: 0,
                pending: 0,
                approved: 0,
                rejected: 0,
                cancelled: 0
            };

            return summary;
        } catch (error) {
            console.error('Error getting application summary:', error);
            throw error;
        }
    }

    //// services/applicationService.js - Add these corrected methods to the ApplicationService class

    /**
     * Get all applications (Admin function)
     * Why: Admin needs to see all applications for management
     * Updated: Match your actual database schema
     */
    async getAllApplications(filters = {}) {
        try {
            let query = `
                SELECT 
                    a.application_id,
                    a.client_user_id,
                    a.device_id,
                    a.application_status,
                    a.submission_date,
                    a.last_updated,
                    a.rejection_reason,
                    d.device_name,
                    d.model,
                    d.manufacturer,
                    d.plan_name,
                    d.monthly_cost,
                    d.contract_duration_months,
                    cu.first_name,
                    cu.last_name,
                    cu.email,
                    cu.phone_number,
                    cu.region,
                    cu.persal_id,
                    cu.registration_status,
                    cu.user_type,
                    cu.department_id,
                    -- Check if there's an approval for this application
                    ap.approval_status,
                    ap.approver_op_user_id,
                    ap.approval_date,
                    -- Check if there's an order for this application
                    o.order_status,
                    o.order_date
                FROM application a
                JOIN device_catalog d ON a.device_id = d.device_id
                JOIN client_user cu ON a.client_user_id = cu.client_user_id
                LEFT JOIN approval ap ON a.application_id = ap.application_id
                LEFT JOIN "order" o ON a.application_id = o.application_id
                WHERE 1=1
            `;

            const params = [];
            let paramCount = 0;

            // Apply filters
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

            // Add ordering
            query += ` ORDER BY a.submission_date DESC`;

            // Add pagination if requested
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

            return {
                success: true,
                data: result.rows,
                count: result.rows.length
            };
        } catch (error) {
            console.error('Error getting all applications:', error);
            throw error;
        }
    }

    /**
     * Update application status (Admin function)
     * Why: Admin needs to approve/reject applications
     * Updated: Match your actual database schema with proper workflow
     */
    async updateApplicationStatus(applicationId, statusData, approverId = null) {
        const client = await db.connect();

        try {
            await client.query('BEGIN');

            // 1. Check if application exists
            const checkResult = await client.query(`
                SELECT application_status, client_user_id, device_id
                FROM application 
                WHERE application_id = $1
            `, [applicationId]);

            if (checkResult.rows.length === 0) {
                throw new Error('Application not found');
            }

            const application = checkResult.rows[0];
            const currentStatus = application.application_status;

            // 2. Validate status transition based on your schema
            // Only 'Pending' applications can be moved to 'Approved' or 'Rejected'
            if (currentStatus !== 'Pending' &&
                (statusData.status === 'Approved' || statusData.status === 'Rejected')) {
                throw new Error(`Application is already ${currentStatus}. Cannot change to ${statusData.status}`);
            }

            // 3. Validate new status matches your schema constraints
            const validStatuses = ['Pending', 'Approved', 'Rejected', 'Cancelled'];
            if (!validStatuses.includes(statusData.status)) {
                throw new Error(`Invalid status: ${statusData.status}. Must be one of: ${validStatuses.join(', ')}`);
            }

            // 4. Handle different status changes
            if (statusData.status === 'Approved') {
                // When approving, create an approval record
                if (!approverId) {
                    throw new Error('Approver ID is required for approval');
                }

                // Update application status
                const updateResult = await client.query(`
                    UPDATE application 
                    SET application_status = $2,
                        last_updated = NOW()
                    WHERE application_id = $1
                    RETURNING *
                `, [applicationId, 'Approved']);

                // Create approval record
                await client.query(`
                    INSERT INTO approval (
                        application_id,
                        approver_op_user_id,
                        approval_status,
                        approval_date,
                        notes
                    ) VALUES ($1, $2, $3, NOW(), $4)
                `, [applicationId, approverId, 'Approved', statusData.notes || null]);

                // Create order record (auto-create when approved)
                await client.query(`
                    INSERT INTO "order" (
                        application_id,
                        mtn_staff_op_user_id,
                        order_status,
                        order_date
                    ) VALUES ($1, $2, 'Processing', NOW())
                `, [applicationId, approverId]);

            } else if (statusData.status === 'Rejected') {
                // When rejecting, require a reason
                if (!statusData.rejection_reason) {
                    throw new Error('Rejection reason is required for rejected applications');
                }

                // Update application status with rejection reason
                const updateResult = await client.query(`
                    UPDATE application 
                    SET application_status = $2,
                        rejection_reason = $3,
                        last_updated = NOW()
                    WHERE application_id = $1
                    RETURNING *
                `, [applicationId, 'Rejected', statusData.rejection_reason]);

                // If approver provided, create approval record for rejection
                if (approverId) {
                    await client.query(`
                        INSERT INTO approval (
                            application_id,
                            approver_op_user_id,
                            approval_status,
                            approval_date,
                            notes
                        ) VALUES ($1, $2, $3, NOW(), $4)
                    `, [applicationId, approverId, 'Rejected', statusData.rejection_reason]);
                }

            } else if (statusData.status === 'Cancelled') {
                // Only allow admin to cancel non-pending applications
                if (currentStatus !== 'Pending') {
                    // Only admin can cancel non-pending apps
                    if (!statusData.is_admin) {
                        throw new Error('Only admin can cancel non-pending applications');
                    }
                }

                // Update application status
                const updateResult = await client.query(`
                    UPDATE application 
                    SET application_status = $2,
                        last_updated = NOW()
                    WHERE application_id = $1
                    RETURNING *
                `, [applicationId, 'Cancelled']);

            } else {
                // For other status updates (though your schema only has the 4 statuses)
                const updateResult = await client.query(`
                    UPDATE application 
                    SET application_status = $2,
                        last_updated = NOW()
                    WHERE application_id = $1
                    RETURNING *
                `, [applicationId, statusData.status]);
            }

            // 5. Get updated application with details
            const updatedAppResult = await client.query(`
                SELECT 
                    a.*,
                    d.device_name,
                    d.model,
                    d.manufacturer,
                    d.plan_name,
                    cu.first_name,
                    cu.last_name,
                    cu.email
                FROM application a
                JOIN device_catalog d ON a.device_id = d.device_id
                JOIN client_user cu ON a.client_user_id = cu.client_user_id
                WHERE a.application_id = $1
            `, [applicationId]);

            await client.query('COMMIT');

            return {
                success: true,
                application: updatedAppResult.rows[0],
                message: `Application status updated to ${statusData.status} successfully`
            };

        } catch (error) {
            await client.query('ROLLBACK');
            console.error('Error updating application status:', error);
            return {
                success: false,
                message: error.message
            };
        } finally {
            client.release();
        }
    }

    /**
     * Get application statistics (Admin function)
     * Updated: Match your actual database schema
     */
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
                    -- Calculate average processing time for approved applications
                    COALESCE(AVG(
                        CASE 
                            WHEN application_status = 'Approved' 
                            THEN EXTRACT(EPOCH FROM (last_updated - submission_date))/86400 
                            ELSE NULL 
                        END
                    ), 0) as avg_processing_days
                FROM application
                WHERE 1=1
            `;

            const params = [];
            let paramCount = 0;

            // Apply date filters
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
                query += ` AND client_user_id IN (
                    SELECT client_user_id FROM client_user WHERE region = $${paramCount}
                )`;
                params.push(filters.region);
            }

            const result = await db.query(query, params);

            // Get device-wise statistics
            const deviceStats = await db.query(`
                SELECT 
                    d.device_name,
                    d.manufacturer,
                    d.plan_name,
                    COUNT(a.application_id) as total_applications,
                    COALESCE(SUM(CASE WHEN a.application_status = 'Approved' THEN 1 ELSE 0 END), 0) as approved_count,
                    COALESCE(SUM(CASE WHEN a.application_status = 'Rejected' THEN 1 ELSE 0 END), 0) as rejected_count,
                    COALESCE(SUM(CASE WHEN a.application_status = 'Pending' THEN 1 ELSE 0 END), 0) as pending_count
                FROM device_catalog d
                LEFT JOIN application a ON d.device_id = a.device_id
                GROUP BY d.device_id, d.device_name, d.manufacturer, d.plan_name
                ORDER BY total_applications DESC
            `);

            // Get user type statistics
            const userTypeStats = await db.query(`
                SELECT 
                    cu.user_type,
                    COUNT(a.application_id) as total_applications,
                    COALESCE(SUM(CASE WHEN a.application_status = 'Approved' THEN 1 ELSE 0 END), 0) as approved_count,
                    COALESCE(SUM(CASE WHEN a.application_status = 'Rejected' THEN 1 ELSE 0 END), 0) as rejected_count
                FROM client_user cu
                LEFT JOIN application a ON cu.client_user_id = a.client_user_id
                GROUP BY cu.user_type
                ORDER BY total_applications DESC
            `);

            // Get daily application trend (last 30 days)
            const trendStats = await db.query(`
                SELECT 
                    DATE(submission_date) as date,
                    COUNT(*) as applications,
                    COALESCE(SUM(CASE WHEN application_status = 'Approved' THEN 1 ELSE 0 END), 0) as approved,
                    COALESCE(SUM(CASE WHEN application_status = 'Rejected' THEN 1 ELSE 0 END), 0) as rejected
                FROM application
                WHERE submission_date >= CURRENT_DATE - INTERVAL '30 days'
                GROUP BY DATE(submission_date)
                ORDER BY date
            `);

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
            console.error('Error getting application statistics:', error);
            throw error;
        }
    }

    /**
     * Get application details with all related information
     * Why: Admin needs complete view of application
     */
    async getAdminApplicationDetails(applicationId) {
        try {
            // Get application with all related data
            const result = await db.query(`
                SELECT 
                    -- Application details
                    a.application_id,
                    a.application_status,
                    a.submission_date,
                    a.last_updated,
                    a.rejection_reason,
                    
                    -- Device details
                    d.device_id,
                    d.device_name,
                    d.model,
                    d.manufacturer,
                    d.plan_name,
                    d.plan_details,
                    d.monthly_cost,
                    d.contract_duration_months,
                    
                    -- User details
                    cu.client_user_id,
                    cu.title as user_title,
                    cu.first_name,
                    cu.last_name,
                    cu.email,
                    cu.phone_number,
                    cu.region,
                    cu.persal_id,
                    cu.department_id,
                    cu.user_type,
                    cu.registration_status,
                    
                    -- Approval details (if exists)
                    ap.approval_id,
                    ap.approval_status,
                    ap.approval_date,
                    ap.notes as approval_notes,
                    approver.first_name as approver_first_name,
                    approver.last_name as approver_last_name,
                    approver.email as approver_email,
                    
                    -- Order details (if exists)
                    o.order_id,
                    o.order_status,
                    o.order_date,
                    mtn_staff.first_name as mtn_staff_first_name,
                    mtn_staff.last_name as mtn_staff_last_name,
                    
                    -- Document count
                    (SELECT COUNT(*) FROM document doc WHERE doc.application_id = a.application_id) as document_count,
                    
                    -- Delivery details (if exists)
                    del.delivery_status,
                    del.tracking_number,
                    del.estimated_delivery_date
                    
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
                throw new Error('Application not found');
            }

            // Get documents if they exist
            const documents = await db.query(`
                SELECT document_id, document_type, upload_date
                FROM document
                WHERE application_id = $1
                ORDER BY upload_date DESC
            `, [applicationId]);

            const application = result.rows[0];
            application.documents = documents.rows;

            return application;
        } catch (error) {
            console.error('Error getting admin application details:', error);
            throw error;
        }
    }


}

module.exports = new ApplicationService();