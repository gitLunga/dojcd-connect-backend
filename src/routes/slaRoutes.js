const express              = require('express');
const router               = express.Router();
const slaController        = require('../controllers/slaController');
const authenticate         = require('../middleware/authenticate');
const requireRoles         = require('../middleware/authorize');
const { runSlaAlerts }     = require('../services/slaAlertService');

router.use(authenticate);

// Full SLA dashboard and cross-stage views — Admin only
router.get('/dashboard',        requireRoles('Admin'), (req, res) => slaController.getDashboard(req, res));
router.get('/applications',     requireRoles('Admin'), (req, res) => slaController.getApplications(req, res));
router.get('/breached',         requireRoles('Admin', 'Manager', 'Finance'), (req, res) => slaController.getBreached(req, res));
router.get('/approaching',      requireRoles('Admin', 'Manager', 'Finance'), (req, res) => slaController.getApproaching(req, res));

// Per-application SLA detail — Admin, Manager, Finance
router.get('/applications/:id', requireRoles('Admin', 'Manager', 'Finance'), (req, res) => slaController.getApplicationDetail(req, res));

// Manual trigger — Admin only (useful for immediate escalation or testing)
router.post('/alerts/run', requireRoles('Admin'), async (req, res) => {
    const result = await runSlaAlerts();
    res.json({ success: true, data: result });
});

module.exports = router;
