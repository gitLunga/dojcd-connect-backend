const express               = require('express');
const router                = express.Router();
const applicationController = require('../../controllers/Application/applicationController');
const authenticate          = require('../../middleware/authenticate');
const requireRoles          = require('../../middleware/authorize');

// All application routes require a valid token
router.use(authenticate);

// Middleware to prevent clients accessing another user's resources (IDOR guard)
function ownClientOnly(req, res, next) {
    const paramId = parseInt(req.params.clientUserId);
    if (req.user.userType !== 'Client' || req.user.userId !== paramId) {
        return res.status(403).json({
            success: false,
            message: 'You can only access your own resources.',
            data: null,
        });
    }
    next();
}

// ── Device catalog (clients browse, admins manage) ────────────────────────────
router.get('/devices',        applicationController.getAvailableDevices);
router.get('/devices/:deviceId', applicationController.getDeviceDetails);

// ── Client routes ─────────────────────────────────────────────────────────────
router.get(
    '/users/:clientUserId/applications/summary',
    requireRoles('Client'),
    ownClientOnly,
    applicationController.getApplicationSummary
);

router.post(
    '/applications',
    requireRoles('Client'),
    applicationController.submitApplication
);

router.get(
    '/users/:clientUserId/applications',
    requireRoles('Client'),
    ownClientOnly,
    applicationController.getUserApplications
);

router.get(
    '/users/:clientUserId/applications/:applicationId',
    requireRoles('Client'),
    ownClientOnly,
    applicationController.getApplicationDetails
);

router.put(
    '/users/:clientUserId/applications/:applicationId/cancel',
    requireRoles('Client'),
    ownClientOnly,
    applicationController.cancelApplication
);

router.post(
    '/users/:clientUserId/applications/:applicationId/resubmit',
    requireRoles('Client'),
    ownClientOnly,
    applicationController.resubmitApplication
);

router.get(
    '/users/:clientUserId/eligibility',
    requireRoles('Client'),
    ownClientOnly,
    applicationController.checkEligibility
);

// ── Admin / operational routes ────────────────────────────────────────────────
router.get(
    '/admin/applications/stats',
    requireRoles('Admin', 'Manager', 'Finance'),
    applicationController.getApplicationStatistics
);

router.get(
    '/admin/applications',
    requireRoles('Admin', 'Manager', 'Finance'),
    applicationController.getAllApplications
);

router.get(
    '/admin/applications/:applicationId',
    requireRoles('Admin', 'Manager', 'Finance'),
    applicationController.getAdminApplicationDetails
);

router.put(
    '/admin/applications/:applicationId/status',
    requireRoles('Admin'),
    applicationController.updateApplicationStatus
);

router.post(
    '/admin/applications/:applicationId/place-order',
    requireRoles('Admin'),
    applicationController.placeOrder
);

router.post(
    '/admin/orders/:orderId/dispatch',
    requireRoles('Admin', 'MTN_Staff'),
    applicationController.dispatchOrder
);

router.post(
    '/admin/orders/:orderId/deliver',
    requireRoles('Admin', 'MTN_Staff'),
    applicationController.deliverOrder
);

module.exports = router;
