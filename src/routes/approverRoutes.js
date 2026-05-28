const express            = require('express');
const router             = express.Router();
const approverController = require('../controllers/approverController');
const authenticate       = require('../middleware/authenticate');
const requireRoles       = require('../middleware/authorize');

// All approver routes require a valid token
router.use(authenticate);

// ── My department's clients ───────────────────────────────────────────────────
router.get(
    '/my-clients',
    requireRoles('Manager', 'Finance', 'Admin'),
    (req, res) => approverController.getMyClients(req, res)
);

// ── Shared (Manager + Finance + Admin) ────────────────────────────────────────
router.get(
    '/applications/:id',
    requireRoles('Manager', 'Finance', 'Admin'),
    (req, res) => approverController.getApplicationDetail(req, res)
);

router.get(
    '/applications/:id/history',
    requireRoles('Manager', 'Finance', 'Admin'),
    (req, res) => approverController.getApplicationHistory(req, res)
);

// ── Manager (Approver 1) ──────────────────────────────────────────────────────
router.get(
    '/manager/queue',
    requireRoles('Manager', 'Admin'),
    (req, res) => approverController.getManagerQueue(req, res)
);

router.get(
    '/manager/stats',
    requireRoles('Manager', 'Admin'),
    (req, res) => approverController.getManagerStats(req, res)
);

router.post(
    '/manager/applications/:id/approve',
    requireRoles('Manager'),
    (req, res) => approverController.managerApprove(req, res)
);

router.post(
    '/manager/applications/:id/reject',
    requireRoles('Manager'),
    (req, res) => approverController.managerReject(req, res)
);

// ── Manager bulk actions ──────────────────────────────────────────────────────
router.post('/manager/bulk-approve', requireRoles('Manager'), (req, res) => approverController.bulkManagerApprove(req, res));
router.post('/manager/bulk-reject',  requireRoles('Manager'), (req, res) => approverController.bulkManagerReject(req, res));

// ── Finance (Approver 2) ──────────────────────────────────────────────────────
router.get(
    '/finance/queue',
    requireRoles('Finance', 'Admin'),
    (req, res) => approverController.getFinanceQueue(req, res)
);

router.get(
    '/finance/stats',
    requireRoles('Finance', 'Admin'),
    (req, res) => approverController.getFinanceStats(req, res)
);

router.post(
    '/finance/applications/:id/approve',
    requireRoles('Finance'),
    (req, res) => approverController.financeApprove(req, res)
);

router.post(
    '/finance/applications/:id/reject',
    requireRoles('Finance'),
    (req, res) => approverController.financeReject(req, res)
);

// ── Finance bulk actions ──────────────────────────────────────────────────────
router.post('/finance/bulk-approve', requireRoles('Finance'), (req, res) => approverController.bulkFinanceApprove(req, res));
router.post('/finance/bulk-reject',  requireRoles('Finance'), (req, res) => approverController.bulkFinanceReject(req, res));

module.exports = router;
