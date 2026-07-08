const express      = require('express');
const router       = express.Router();
const adminController = require('../controllers/adminController');
const authenticate    = require('../middleware/authenticate');
const requireRoles    = require('../middleware/authorize');

// All admin routes require a valid token and the Admin role
router.use(authenticate);
router.use(requireRoles('Admin'));

// ── Users ─────────────────────────────────────────────────────────────────────
router.get('/all-users',     (req, res) => adminController.getAllUsers(req, res));
router.get('/client-users',  (req, res) => adminController.getAllClientUsers(req, res));

// ── Statistics & Analytics ────────────────────────────────────────────────────
router.get('/statistics',              (req, res) => adminController.getStatistics(req, res));
router.get('/statistics/enhanced',     (req, res) => adminController.getEnhancedStatistics(req, res));
router.get('/statistics/dashboard',    (req, res) => adminController.getDashboardMetrics(req, res));
router.get('/statistics/performance',  (req, res) => adminController.getPerformanceStats(req, res));
router.get('/recent-registrations',    (req, res) => adminController.getRecentRegistrations(req, res));
router.get('/activity-summary',        (req, res) => adminController.getActivitySummary(req, res));
router.get('/dashboard',               (req, res) => adminController.getDashboardData(req, res));
router.get('/search',                  (req, res) => adminController.searchUsers(req, res));

// ── Documents ─────────────────────────────────────────────────────────────────
router.get('/client-users/:id/documents',    (req, res) => adminController.getAllUserDocuments(req, res));
router.get('/client-users/:id/invoice',      (req, res) => adminController.downloadInvoice(req, res));
router.get('/client-users/:id/invoice/view', (req, res) => adminController.viewInvoice(req, res));
router.get('/client-users/:id/invoice/info', (req, res) => adminController.getInvoiceInfo(req, res));

router.get('/documents/:id/download',    (req, res) => adminController.downloadDocument(req, res));
router.get('/documents/:id/view',        (req, res) => adminController.viewDocument(req, res));
router.patch('/documents/:id/status',    (req, res) => adminController.updateDocumentStatus(req, res));

// ── Client user management ────────────────────────────────────────────────────
router.get('/client-users/:id',          (req, res) => adminController.getClientUserById(req, res));
router.put('/client-users/:id',          (req, res) => adminController.updateClientUser(req, res));
router.delete('/client-users/:id',       (req, res) => adminController.deleteClientUser(req, res));
router.patch('/client-users/:id/status', (req, res) => adminController.updateUserStatus(req, res));

// ── Operational user management ───────────────────────────────────────────────
router.get('/operational-users',         (req, res) => adminController.getAllOperationalUsers(req, res));
router.get('/operational-users/:id',     (req, res) => adminController.getOperationalUserById(req, res));

router.post('/operational-users',        (req, res) => adminController.createOperationalUser(req, res));
router.put('/operational-users/:id',     (req, res) => adminController.updateOperationalUser(req, res));
router.delete('/operational-users/:id',  (req, res) => adminController.deleteOperationalUser(req, res));

router.patch('/operational-users/:id/change-password', (req, res) => adminController.changeOperationalUserPassword(req, res));
router.patch('/operational-users/:id/promote',         (req, res) => adminController.promoteToSuperAdmin(req, res));
router.patch('/operational-users/:id/demote',          (req, res) => adminController.demoteSuperAdmin(req, res));
router.patch('/operational-users/:id/global-access',   (req, res) => adminController.setGlobalAccess(req, res));

// ── Departments ───────────────────────────────────────────────────────────────
router.get('/departments',         (req, res) => adminController.getDepartments(req, res));
router.post('/departments',        (req, res) => adminController.createDepartment(req, res));
router.delete('/departments/:id',  (req, res) => adminController.deleteDepartment(req, res));

// ── System overview ───────────────────────────────────────────────────────────
router.get('/system-overview', (req, res) => adminController.getSystemOverview(req, res));

module.exports = router;
