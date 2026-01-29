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
                SELECT 
                    COUNT(*) as total_applications,
                    SUM(CASE WHEN application_status = 'Pending' THEN 1 ELSE 0 END) as pending,
                    SUM(CASE WHEN application_status = 'Approved' THEN 1 ELSE 0 END) as approved,
                    SUM(CASE WHEN application_status = 'Rejected' THEN 1 ELSE 0 END) as rejected,
                    SUM(CASE WHEN application_status = 'Cancelled' THEN 1 ELSE 0 END) as cancelled
                FROM application 
                WHERE client_user_id = $1
            `, [clientUserId]);

            return result.rows[0];
        } catch (error) {
            console.error('Error getting application summary:', error);
            throw error;
        }
    }
}

module.exports = new ApplicationService();