// src/controllers/approverController.js
// ─────────────────────────────────────────────────────────────────────────────
// Handles all approver-facing HTTP requests.
// Routes are protected by authenticate middleware.
// Role guards ensure Managers only touch Pending apps,
// Finance users only touch Pending_Finance apps.
// ─────────────────────────────────────────────────────────────────────────────

const approverService = require('../services/approverService');

function ok(res, message, data = null, status = 200) {
    return res.status(status).json({
        success: true,
        message,
        data,
        timestamp: new Date().toISOString(),
    });
}

function fail(res, message, status = 400) {
    return res.status(status).json({
        success: false,
        message,
        data: null,
        timestamp: new Date().toISOString(),
    });
}

class ApproverController {

    // ── MANAGER (Approver 1) ──────────────────────────────────────────────────

    /**
     * GET /api/approver/manager/queue
     * Returns all Pending applications waiting for manager review.
     * Query params: region, department_id, date_from, date_to, limit, offset
     */
    async getManagerQueue(req, res) {
        try {
            const filters = {
                region:        req.query.region,
                department_id: req.query.department_id,
                date_from:     req.query.date_from,
                date_to:       req.query.date_to,
                limit:         req.query.limit,
                offset:        req.query.offset,
            };

            // Scope to the Manager's own department unless they have global access
            if (req.user.role === 'Manager' && req.user.departmentId && !req.user.hasGlobalAccess) {
                filters.department_id = req.user.departmentId;
            }

            const result = await approverService.getManagerQueue(filters);

            const message = result.total === 0
                ? 'No applications are currently waiting for your review.'
                : `${result.total} application(s) waiting for manager review.`;

            return ok(res, message, result);
        } catch (error) {
            console.error('getManagerQueue error:', error);
            return fail(res, error.message, 500);
        }
    }

    /**
     * GET /api/approver/manager/stats
     * Dashboard stats for the Manager: queue count, approved/rejected totals, avg days.
     */
    async getManagerStats(req, res) {
        try {
            // req.user is set by authenticate middleware.
            // If auth is disabled/stashed, fall back to a query param for testing.
            const userId = req.user?.userId || parseInt(req.query.user_id);
            if (!userId) return fail(res, 'User ID could not be determined. Ensure you are logged in.', 401);
            const stats = await approverService.getApproverStats(userId, 'Manager');
            return ok(res, 'Manager statistics retrieved.', {stats});
        } catch (error) {
            return fail(res, error.message, 500);
        }
    }

    /**
     * GET /api/approver/applications/:id
     * Full application detail — used by both Manager and Finance.
     */
    async getApplicationDetail(req, res) {
        try {
            const app = await approverService.getApplicationById(parseInt(req.params.id));
            return ok(res, 'Application details retrieved.', {application: app});
        } catch (error) {
            return fail(res, error.message, error.message.includes('not found') ? 404 : 500);
        }
    }

    /**
     * GET /api/approver/applications/:id/history
     * Approval trail for a specific application.
     */
    async getApplicationHistory(req, res) {
        try {
            const history = await approverService.getApplicationHistory(parseInt(req.params.id));
            return ok(res, `${history.length} approval event(s) found.`, {history});
        } catch (error) {
            return fail(res, error.message, 500);
        }
    }

    /**
     * POST /api/approver/manager/applications/:id/approve
     * Manager approves → Pending_Finance
     * Body: { notes: "optional notes" }
     */
    async managerApprove(req, res) {
        try {
            const applicationId = parseInt(req.params.id);
            const managerId = req.user?.userId || parseInt(req.query.user_id);
            const {notes} = req.body;

            if (!applicationId) return fail(res, 'Application ID is required.');

            const result = await approverService.managerApprove(applicationId, managerId, notes);

            if (result.success) return ok(res, result.message, {
                application_id: result.application_id,
                new_status: result.new_status,
            });

            // Business rule failure
            const isConflict = result.message.includes('cannot be approved') || result.message.includes('status is');
            return fail(res, result.message, isConflict ? 409 : 422);

        } catch (error) {
            console.error('managerApprove controller error:', error);
            return fail(res, 'Something went wrong. Please try again.', 500);
        }
    }

    /**
     * POST /api/approver/manager/applications/:id/reject
     * Manager rejects → Rejected
     * Body: { rejection_reason: "reason" }  ← REQUIRED
     */
    async managerReject(req, res) {
        try {
            const applicationId = parseInt(req.params.id);
            const managerId = req.user?.userId || parseInt(req.query.user_id);
            const {rejection_reason} = req.body;

            if (!applicationId) return fail(res, 'Application ID is required.');
            if (!rejection_reason?.trim()) return fail(res, 'A rejection reason is required.');

            const result = await approverService.managerReject(applicationId, managerId, rejection_reason);

            if (result.success) return ok(res, result.message, {
                application_id: result.application_id,
                new_status: result.new_status,
            });

            const isConflict = result.message.includes('cannot be rejected') || result.message.includes('status is');
            return fail(res, result.message, isConflict ? 409 : 422);

        } catch (error) {
            console.error('managerReject controller error:', error);
            return fail(res, 'Something went wrong. Please try again.', 500);
        }
    }

    // ── FINANCE (Approver 2) ──────────────────────────────────────────────────

    /**
     * GET /api/approver/finance/queue
     * Returns all Pending_Finance applications waiting for finance review.
     */
    async getFinanceQueue(req, res) {
        try {
            const filters = {
                region:        req.query.region,
                department_id: req.query.department_id,
                date_from:     req.query.date_from,
                date_to:       req.query.date_to,
                limit:         req.query.limit,
                offset:        req.query.offset,
            };

            // Scope to the Finance user's own department unless they have global access
            if (req.user.role === 'Finance' && req.user.departmentId && !req.user.hasGlobalAccess) {
                filters.department_id = req.user.departmentId;
            }

            const result = await approverService.getFinanceQueue(filters);

            const message = result.total === 0
                ? 'No applications are currently awaiting financial review.'
                : `${result.total} application(s) awaiting financial review.`;

            return ok(res, message, result);
        } catch (error) {
            console.error('getFinanceQueue error:', error);
            return fail(res, error.message, 500);
        }
    }

    /**
     * GET /api/approver/finance/stats
     * Dashboard stats for Finance approver.
     */
    async getFinanceStats(req, res) {
        try {
            const userId = req.user?.userId || parseInt(req.query.user_id);
            if (!userId) return fail(res, 'User ID could not be determined. Ensure you are logged in.', 401);
            const stats = await approverService.getApproverStats(userId, 'Finance');
            return ok(res, 'Finance statistics retrieved.', {stats});
        } catch (error) {
            return fail(res, error.message, 500);
        }
    }

    /**
     * POST /api/approver/finance/applications/:id/approve
     * Finance approves → Approved (fully approved, Admin notified)
     * Body: { notes: "budget code XYZ, Q2 approved" }
     */
    async financeApprove(req, res) {
        try {
            const applicationId = parseInt(req.params.id);
            const financeUserId = req.user?.userId || parseInt(req.query.user_id);
            const {notes} = req.body;

            if (!applicationId) return fail(res, 'Application ID is required.');

            const result = await approverService.financeApprove(applicationId, financeUserId, notes);

            if (result.success) return ok(res, result.message, {
                application_id: result.application_id,
                new_status: result.new_status,
            });

            const isConflict = result.message.includes('cannot be approved') || result.message.includes('status is');
            return fail(res, result.message, isConflict ? 409 : 422);

        } catch (error) {
            console.error('financeApprove controller error:', error);
            return fail(res, 'Something went wrong. Please try again.', 500);
        }
    }

    /**
     * POST /api/approver/finance/applications/:id/reject
     * Finance rejects → Rejected
     * Body: { rejection_reason: "reason" }  ← REQUIRED
     */
    async financeReject(req, res) {
        try {
            const applicationId = parseInt(req.params.id);
            const financeUserId = req.user?.userId || parseInt(req.query.user_id);
            const {rejection_reason} = req.body;

            if (!applicationId) return fail(res, 'Application ID is required.');
            if (!rejection_reason?.trim()) return fail(res, 'A rejection reason is required.');

            const result = await approverService.financeReject(applicationId, financeUserId, rejection_reason);

            if (result.success) return ok(res, result.message, {
                application_id: result.application_id,
                new_status: result.new_status,
            });

            const isConflict = result.message.includes('cannot be rejected') || result.message.includes('status is');
            return fail(res, result.message, isConflict ? 409 : 422);

        } catch (error) {
            console.error('financeReject controller error:', error);
            return fail(res, 'Something went wrong. Please try again.', 500);
        }
    }
    // ── BULK ACTIONS ──────────────────────────────────────────────────────────

    async bulkManagerApprove(req, res) {
        try {
            const managerId      = req.user?.userId;
            const { application_ids, notes } = req.body;
            if (!Array.isArray(application_ids) || application_ids.length === 0)
                return fail(res, 'application_ids must be a non-empty array.');
            if (application_ids.length > 100)
                return fail(res, 'Maximum 100 applications per bulk action.');
            const result = await approverService.bulkManagerApprove(application_ids.map(Number), managerId, notes);
            return ok(res, `Bulk approve complete: ${result.succeeded}/${result.total} succeeded.`, result);
        } catch (err) { return fail(res, err.message, 500); }
    }

    async bulkManagerReject(req, res) {
        try {
            const managerId      = req.user?.userId;
            const { application_ids, rejection_reason } = req.body;
            if (!Array.isArray(application_ids) || application_ids.length === 0)
                return fail(res, 'application_ids must be a non-empty array.');
            if (!rejection_reason?.trim()) return fail(res, 'rejection_reason is required.');
            if (application_ids.length > 100)
                return fail(res, 'Maximum 100 applications per bulk action.');
            const result = await approverService.bulkManagerReject(application_ids.map(Number), managerId, rejection_reason);
            return ok(res, `Bulk reject complete: ${result.succeeded}/${result.total} succeeded.`, result);
        } catch (err) { return fail(res, err.message, 500); }
    }

    async bulkFinanceApprove(req, res) {
        try {
            const financeUserId  = req.user?.userId;
            const { application_ids, notes } = req.body;
            if (!Array.isArray(application_ids) || application_ids.length === 0)
                return fail(res, 'application_ids must be a non-empty array.');
            if (application_ids.length > 100)
                return fail(res, 'Maximum 100 applications per bulk action.');
            const result = await approverService.bulkFinanceApprove(application_ids.map(Number), financeUserId, notes);
            return ok(res, `Bulk approve complete: ${result.succeeded}/${result.total} succeeded.`, result);
        } catch (err) { return fail(res, err.message, 500); }
    }

    async bulkFinanceReject(req, res) {
        try {
            const financeUserId  = req.user?.userId;
            const { application_ids, rejection_reason } = req.body;
            if (!Array.isArray(application_ids) || application_ids.length === 0)
                return fail(res, 'application_ids must be a non-empty array.');
            if (!rejection_reason?.trim()) return fail(res, 'rejection_reason is required.');
            if (application_ids.length > 100)
                return fail(res, 'Maximum 100 applications per bulk action.');
            const result = await approverService.bulkFinanceReject(application_ids.map(Number), financeUserId, rejection_reason);
            return ok(res, `Bulk reject complete: ${result.succeeded}/${result.total} succeeded.`, result);
        } catch (err) { return fail(res, err.message, 500); }
    }

    /**
     * GET /api/approver/my-clients
     * All client users in the caller's department.
     * Used by Manager and Finance to see who they are responsible for.
     */
    async getMyClients(req, res) {
        try {
            const { departmentId } = req.user;
            if (!departmentId) {
                return fail(res, 'Your account has no department assigned. Contact an Admin.', 403);
            }
            const result = await approverService.getClientsByDepartment(departmentId, {
                registration_status: req.query.registration_status,
                limit:  req.query.limit,
                offset: req.query.offset,
            });
            return ok(res, `${result.total} client(s) found in your department.`, result);
        } catch (error) {
            return fail(res, error.message, 500);
        }
    }
}

module.exports = new ApproverController();