const express = require('express');
const router = express.Router();
const adminController = require('../controllers/adminController');

// ── Users ─────────────────────────────────────────────────────────────────────
router.get('/all-users', (req, res) => adminController.getAllUsers(req, res));
router.get('/client-users', (req, res) => adminController.getAllClientUsers(req, res));

// ── Statistics & Analytics (must come before /:id param routes) ───────────────
router.get('/statistics', (req, res) => adminController.getStatistics(req, res));
router.get('/statistics/enhanced', (req, res) => adminController.getEnhancedStatistics(req, res));
router.get('/statistics/dashboard', (req, res) => adminController.getDashboardMetrics(req, res));
router.get('/statistics/performance', (req, res) => adminController.getPerformanceStats(req, res));
router.get('/recent-registrations', (req, res) => adminController.getRecentRegistrations(req, res));
router.get('/activity-summary', (req, res) => adminController.getActivitySummary(req, res));
router.get('/dashboard', (req, res) => adminController.getDashboardData(req, res));
router.get('/search', (req, res) => adminController.searchUsers(req, res));

// ── Documents (must come BEFORE /client-users/:id to avoid param conflicts) ───
router.get('/client-users/:id/documents', (req, res) => adminController.getAllUserDocuments(req, res));
router.get('/client-users/:id/invoice', (req, res) => adminController.downloadInvoice(req, res));
router.get('/client-users/:id/invoice/view', (req, res) => adminController.viewInvoice(req, res));
router.get('/client-users/:id/invoice/info', (req, res) => adminController.getInvoiceInfo(req, res));

router.get('/documents/:id/download', (req, res) => adminController.downloadDocument(req, res));
router.get('/documents/:id/view', (req, res) => adminController.viewDocument(req, res));
router.patch('/documents/:id/status', (req, res) => adminController.updateDocumentStatus(req, res));

// ── Client user routes (generic /:id LAST to avoid swallowing sub-routes) ─────
router.get('/client-users/:id', (req, res) => adminController.getClientUserById(req, res));
router.patch('/client-users/:id/status', (req, res) => adminController.updateUserStatus(req, res));

// ── Operational user routes ───────────────────────────────────────────────────
router.get('/operational-users', (req, res) => adminController.getAllOperationalUsers(req, res));
router.get('/operational-users/:id', (req, res) => adminController.getOperationalUserById(req, res));

module.exports = router;