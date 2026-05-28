const express          = require('express');
const router           = express.Router();
const reportController = require('../controllers/reportController');
const authenticate     = require('../middleware/authenticate');
const requireRoles     = require('../middleware/authorize');

router.use(authenticate);
router.use(requireRoles('Admin'));

router.get('/history',              (req, res) => reportController.getHistory(req, res));

// Applications report
router.get('/applications',         (req, res) => reportController.applicationsPreview(req, res));
router.get('/applications/export',  (req, res) => reportController.applicationsExport(req, res));

// Users report
router.get('/users',                (req, res) => reportController.usersPreview(req, res));
router.get('/users/export',         (req, res) => reportController.usersExport(req, res));

// Inventory report
router.get('/inventory',            (req, res) => reportController.inventoryPreview(req, res));
router.get('/inventory/export',     (req, res) => reportController.inventoryExport(req, res));

// SLA compliance report
router.get('/sla',                  (req, res) => reportController.slaPreview(req, res));
router.get('/sla/export',           (req, res) => reportController.slaExport(req, res));

module.exports = router;
