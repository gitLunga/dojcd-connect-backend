// controllers/applicationController.js
const applicationService = require('../../services/Application/applicationService.js');

// ─── Utility: success response ────────────────────────────────────────────────
function ok(res, message, data = null, statusCode = 200) {
    return res.status(statusCode).json({
        success: true,
        message,
        data,
        timestamp: new Date().toISOString()
    });
}

// ─── Utility: error response ──────────────────────────────────────────────────
function fail(res, message, statusCode = 400) {
    return res.status(statusCode).json({
        success: false,
        message,
        data: null,
        timestamp: new Date().toISOString()
    });
}

const applicationController = {

    // ─── GET AVAILABLE DEVICES ────────────────────────────────────────────────

    getAvailableDevices: async (req, res) => {
        try {
            const devices = await applicationService.getAvailableDevices();

            if (devices.length === 0) {
                return ok(res, 'No devices are currently available. Please check back later.', { devices, count: 0 });
            }

            return ok(res, `${devices.length} device(s) available.`, { devices, count: devices.length });
        } catch (error) {
            console.error('Get devices error:', error);
            return fail(res, error.message, 500);
        }
    },

    // ─── GET DEVICE DETAILS ───────────────────────────────────────────────────

    getDeviceDetails: async (req, res) => {
        try {
            const { deviceId } = req.params;
            const device = await applicationService.getDeviceById(parseInt(deviceId));
            return ok(res, 'Device details retrieved successfully.', { device });
        } catch (error) {
            console.error('Get device details error:', error);
            const status = error.message.includes('no longer available') ? 404 : 500;
            return fail(res, error.message, status);
        }
    },

    // ─── SUBMIT APPLICATION ───────────────────────────────────────────────────

    submitApplication: async (req, res) => {
        try {
            const { client_user_id, device_id } = req.body;

            if (!client_user_id || !device_id) {
                return fail(res, 'Please provide both your user ID and the selected device to apply.', 400);
            }

            const result = await applicationService.submitApplication(
                parseInt(client_user_id),
                parseInt(device_id)
            );

            if (result.success) {
                return ok(res, result.message, { application: result.application }, 201);
            }

            // Business-rule failures (eligibility, duplicate, etc.) → 422
            return fail(res, result.message, 422);

        } catch (error) {
            console.error('Submit application error:', error);
            return fail(res, 'Something went wrong while submitting your application. Please try again.', 500);
        }
    },

    // ─── GET USER APPLICATIONS ────────────────────────────────────────────────

    getUserApplications: async (req, res) => {
        try {
            const { clientUserId } = req.params;

            if (!clientUserId) {
                return fail(res, 'User ID is required.', 400);
            }

            const applications = await applicationService.getUserApplications(parseInt(clientUserId));

            if (applications.length === 0) {
                return ok(res, 'You have not submitted any applications yet.', { applications, count: 0 });
            }

            return ok(res, `You have ${applications.length} application(s).`, { applications, count: applications.length });
        } catch (error) {
            console.error('Get user applications error:', error);
            return fail(res, error.message, 500);
        }
    },

    // ─── GET APPLICATION DETAILS ──────────────────────────────────────────────

    getApplicationDetails: async (req, res) => {
        try {
            const { clientUserId, applicationId } = req.params;

            const application = await applicationService.getApplicationDetails(
                parseInt(applicationId),
                parseInt(clientUserId)
            );

            return ok(res, 'Application details retrieved successfully.', { application });
        } catch (error) {
            console.error('Get application details error:', error);
            const status = error.message.includes('not found') ? 404 : 500;
            return fail(res, error.message, status);
        }
    },

    // ─── CANCEL APPLICATION ───────────────────────────────────────────────────

    cancelApplication: async (req, res) => {
        try {
            const { clientUserId, applicationId } = req.params;

            const result = await applicationService.cancelApplication(
                parseInt(applicationId),
                parseInt(clientUserId)
            );

            if (result.success) {
                return ok(res, result.message, { application: result.application });
            }

            // Business-rule failures → 422
            return fail(res, result.message, 422);

        } catch (error) {
            console.error('Cancel application error:', error);
            return fail(res, 'Something went wrong while cancelling your application. Please try again.', 500);
        }
    },

    // ─── GET APPLICATION SUMMARY ──────────────────────────────────────────────

    getApplicationSummary: async (req, res) => {
        try {
            const { clientUserId } = req.params;
            const summary = await applicationService.getApplicationSummary(parseInt(clientUserId));
            return ok(res, 'Application summary retrieved successfully.', { summary });
        } catch (error) {
            console.error('Get application summary error:', error);
            return fail(res, error.message, 500);
        }
    },

    // ─── CHECK ELIGIBILITY ────────────────────────────────────────────────────

    checkEligibility: async (req, res) => {
        try {
            const { clientUserId } = req.params;
            const eligibility = await applicationService.checkUserEligibility(parseInt(clientUserId));

            const message = eligibility.eligible
                ? 'Your account is verified and you are eligible to apply.'
                : eligibility.reason;

            return ok(res, message, { eligibility });
        } catch (error) {
            console.error('Check eligibility error:', error);
            return fail(res, error.message, 500);
        }
    },

    // ─── ADMIN: GET ALL APPLICATIONS ──────────────────────────────────────────

    getAllApplications: async (req, res) => {
        try {
            const filters = {
                status: req.query.status,
                device_id: req.query.device_id,
                user_id: req.query.user_id,
                user_type: req.query.user_type,
                region: req.query.region,
                start_date: req.query.start_date,
                end_date: req.query.end_date,
                limit: req.query.limit || 50,
                offset: req.query.offset || 0
            };

            const result = await applicationService.getAllApplications(filters);

            const message = result.count === 0
                ? 'No applications found matching the selected filters.'
                : `${result.count} application(s) retrieved successfully.`;

            return ok(res, message, { applications: result.data, count: result.count });
        } catch (error) {
            console.error('Get all applications error:', error);
            return fail(res, error.message, 500);
        }
    },

    // ─── ADMIN: UPDATE APPLICATION STATUS ────────────────────────────────────

    updateApplicationStatus: async (req, res) => {
        try {
            const { applicationId } = req.params;
            const { status, rejection_reason, notes, approver_id, is_admin = false } = req.body;

            if (!status) {
                return fail(res, 'Please provide a status to update.', 400);
            }

            const validStatuses = ['Pending', 'Approved', 'Rejected', 'Cancelled'];
            if (!validStatuses.includes(status)) {
                return fail(res, `"${status}" is not a valid status. Please use one of: ${validStatuses.join(', ')}.`, 400);
            }

            if (status === 'Approved' && !approver_id) {
                return fail(res, 'An approver ID is required to approve an application.', 400);
            }

            if (status === 'Rejected' && !rejection_reason) {
                return fail(res, 'Please provide a reason for rejecting this application.', 400);
            }

            const result = await applicationService.updateApplicationStatus(
                parseInt(applicationId),
                { status, rejection_reason, notes, is_admin },
                approver_id ? parseInt(approver_id) : null
            );

            if (result.success) {
                return ok(res, result.message, { application: result.application });
            }

            // already-finalised or business rule → 409 Conflict or 422
            const statusCode = result.message.includes('already been') ? 409 : 422;
            return fail(res, result.message, statusCode);

        } catch (error) {
            console.error('Update application status error:', error);
            return fail(res, error.message || 'Something went wrong. Please try again.', 500);
        }
    },

    // ─── ADMIN: STATISTICS ────────────────────────────────────────────────────

    getApplicationStatistics: async (req, res) => {
        try {
            const filters = {
                start_date: req.query.start_date,
                end_date: req.query.end_date,
                region: req.query.region
            };

            const result = await applicationService.getApplicationStatistics(filters);
            return ok(res, 'Application statistics retrieved successfully.', result.data);
        } catch (error) {
            console.error('Get application statistics error:', error);
            return fail(res, error.message, 500);
        }
    },

    // ─── ADMIN: APPLICATION DETAILS ───────────────────────────────────────────

    getAdminApplicationDetails: async (req, res) => {
        try {
            const { applicationId } = req.params;
            const id = parseInt(applicationId);

            const application = await applicationService.getAdminApplicationDetails(id);
            return ok(res, 'Application details retrieved successfully.', { application });
        } catch (error) {
            console.error('Get admin application details error:', error);
            const status = error.message.includes('not found') ? 404 : 500;
            return fail(res, error.message, status);
        }
    },

    placeOrder: async (req, res) => {
        try {
            const { applicationId } = req.params;
            const { admin_op_user_id, notes } = req.body;
            if (!admin_op_user_id) return fail(res, 'Admin user ID is required to place an order.', 400);
            const result = await applicationService.placeOrder(
                parseInt(applicationId), parseInt(admin_op_user_id), notes || null
            );
            if (result.success) return ok(res, result.message, { order: result.order }, 201);
            return fail(res, result.message, result.message.includes('already') ? 409 : 422);
        } catch (error) {
            console.error('Place order error:', error);
            return fail(res, error.message || 'Something went wrong placing the order. Please try again.', 500);
        }
    },
};

module.exports = applicationController;