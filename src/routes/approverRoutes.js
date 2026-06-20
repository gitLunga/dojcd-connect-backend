const express            = require('express');
const router             = express.Router();
const approverController = require('../controllers/approverController');
const adminController    = require('../controllers/adminController');
const authenticate       = require('../middleware/authenticate');
const requireRoles       = require('../middleware/authorize');

// All approver routes require a valid token
router.use(authenticate);

// ── Document read access for Manager / Finance / Admin ────────────────────────
// Admin routes lock down /api/admin/* to Admin only, so expose read-only
// document endpoints here so approvers can fetch client docs for review.
const canViewDocs = requireRoles('Manager', 'Approver', 'Finance', 'Admin');
router.get('/client-users/:id/documents', canViewDocs, (req, res) => adminController.getAllUserDocuments(req, res));
router.get('/documents/:id/view',         canViewDocs, (req, res) => adminController.viewDocument(req, res));
router.get('/documents/:id/download',     canViewDocs, (req, res) => adminController.downloadDocument(req, res));

// ── My department's clients ───────────────────────────────────────────────────
router.get(
    '/my-clients',
    requireRoles('Manager', 'Approver', 'Finance', 'Admin'),
    (req, res) => approverController.getMyClients(req, res)
);

// ── Shared (Manager + Approver + Finance + Admin) ─────────────────────────────
router.get(
    '/applications/:id',
    requireRoles('Manager', 'Approver', 'Finance', 'Admin'),
    (req, res) => approverController.getApplicationDetail(req, res)
);

router.get(
    '/applications/:id/history',
    requireRoles('Manager', 'Approver', 'Finance', 'Admin'),
    (req, res) => approverController.getApplicationHistory(req, res)
);

// ── Manager (Approver 1) ──────────────────────────────────────────────────────
router.get(
    '/manager/queue',
    requireRoles('Manager', 'Approver', 'Admin'),
    (req, res) => approverController.getManagerQueue(req, res)
);

router.get(
    '/manager/stats',
    requireRoles('Manager', 'Approver', 'Admin'),
    (req, res) => approverController.getManagerStats(req, res)
);

router.post(
    '/manager/applications/:id/approve',
    requireRoles('Manager', 'Approver'),
    (req, res) => approverController.managerApprove(req, res)
);

router.post(
    '/manager/applications/:id/reject',
    requireRoles('Manager', 'Approver'),
    (req, res) => approverController.managerReject(req, res)
);

// ── Manager bulk actions ──────────────────────────────────────────────────────
router.post('/manager/bulk-approve', requireRoles('Manager', 'Approver'), (req, res) => approverController.bulkManagerApprove(req, res));
router.post('/manager/bulk-reject',  requireRoles('Manager', 'Approver'), (req, res) => approverController.bulkManagerReject(req, res));

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
