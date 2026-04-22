const express             = require('express');
const router              = express.Router();
const approverController  = require('../controllers/approverController');

// Every approver route requires a valid JWT
//router.use(authenticate);

// ─────────────────────────────────────────────────────────────────────────────
// SHARED — accessible to both Manager and Finance (and Admin for oversight)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /api/approver/applications/:id
 * Full application detail — both approver types need this.
 */
router.get(
    '/applications/:id',
    //requireRoles('Manager', 'Finance', 'Admin'),
    (req, res) => approverController.getApplicationDetail(req, res)
);

/**
 * GET /api/approver/applications/:id/history
 * Approval trail — who approved at which stage and when.
 */
router.get(
    '/applications/:id/history',
   // requireRoles('Manager', 'Finance', 'Admin'),
    (req, res) => approverController.getApplicationHistory(req, res)
);

// ─────────────────────────────────────────────────────────────────────────────
// MANAGER (Approver 1) — role: 'Manager'
// Sees Pending applications, can approve (→ Pending_Finance) or reject
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /api/approver/manager/queue
 * List of Pending applications waiting for manager review.
 * Query: ?region=Gauteng&department_id=DOJ001&date_from=2026-01-01&limit=20&offset=0
 */
router.get(
    '/manager/queue',
    //requireRoles('Manager', 'Admin'),
    (req, res) => approverController.getManagerQueue(req, res)
);

/**
 * GET /api/approver/manager/stats
 * Manager dashboard stats: queue size, approved count, rejected count, avg days.
 */
router.get(
    '/manager/stats',
   // requireRoles('Manager'),
    (req, res) => approverController.getManagerStats(req, res)
);

/**
 * POST /api/approver/manager/applications/:id/approve
 * Approve at manager stage → moves to Pending_Finance.
 * Body: { "notes": "optional notes" }
 */
router.post(
    '/manager/applications/:id/approve',
  //  requireRoles('Manager'),
    (req, res) => approverController.managerApprove(req, res)
);

/**
 * POST /api/approver/manager/applications/:id/reject
 * Reject at manager stage → moves to Rejected.
 * Body: { "rejection_reason": "reason text" }  ← required
 */
router.post(
    '/manager/applications/:id/reject',
  //  requireRoles('Manager'),
    (req, res) => approverController.managerReject(req, res)
);

// ─────────────────────────────────────────────────────────────────────────────
// FINANCE (Approver 2) — role: 'Finance'
// Sees Pending_Finance applications, can approve (→ Approved) or reject
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /api/approver/finance/queue
 * List of Pending_Finance applications waiting for finance review.
 * Query: ?region=Gauteng&department_id=DOJ001&date_from=2026-01-01&limit=20&offset=0
 */
router.get(
    '/finance/queue',
   // requireRoles('Finance', 'Admin'),
    (req, res) => approverController.getFinanceQueue(req, res)
);

/**
 * GET /api/approver/finance/stats
 * Finance dashboard stats.
 */
router.get(
    '/finance/stats',
  //  requireRoles('Finance'),
    (req, res) => approverController.getFinanceStats(req, res)
);

/**
 * POST /api/approver/finance/applications/:id/approve
 * Final approval → moves to Approved. Admin notified to place MTN order.
 * Body: { "notes": "Budget code XYZ approved" }
 */
router.post(
    '/finance/applications/:id/approve',
  // requireRoles('Finance'),
    (req, res) => approverController.financeApprove(req, res)
);

/**
 * POST /api/approver/finance/applications/:id/reject
 * Finance rejection → moves to Rejected.
 * Body: { "rejection_reason": "reason text" }  ← required
 */
router.post(
    '/finance/applications/:id/reject',
   // requireRoles('Finance'),
    (req, res) => approverController.financeReject(req, res)
);

module.exports = router;