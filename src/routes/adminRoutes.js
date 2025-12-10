const express = require('express');
const router = express.Router();
const adminController = require('../controllers/adminController');

// Client user routes
router.get('/client-users', (req, res) => adminController.getAllClientUsers(req, res));
router.get('/client-users/:id', (req, res) => adminController.getClientUserById(req, res));
router.patch('/client-users/:id/status', (req, res) => adminController.updateUserStatus(req, res));
// Operational user routes
router.get('/operational-users', (req, res) => adminController.getAllOperationalUsers(req, res));
router.get('/operational-users/:id', (req, res) => adminController.getOperationalUserById(req, res));

// Statistics & Analytics
router.get('/statistics', (req, res) => adminController.getStatistics(req, res));
router.get('/recent-registrations', (req, res) => adminController.getRecentRegistrations(req, res));
router.get('/activity-summary', (req, res) => adminController.getActivitySummary(req, res));
router.get('/dashboard', (req, res) => adminController.getDashboardData(req, res));

// Search
router.get('/search', (req, res) => adminController.searchUsers(req, res));

module.exports = router;