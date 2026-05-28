const express            = require('express');
const router             = express.Router();
const contractController = require('../controllers/contractController');
const authenticate       = require('../middleware/authenticate');
const requireRoles       = require('../middleware/authorize');

router.use(authenticate);

router.get('/summary',          requireRoles('Admin'), (req, res) => contractController.summary(req, res));
router.get('/expiring',         requireRoles('Admin', 'Manager', 'Finance'), (req, res) => contractController.expiring(req, res));
router.get('/',                 requireRoles('Admin'), (req, res) => contractController.list(req, res));
router.post('/send-reminders',  requireRoles('Admin'), (req, res) => contractController.sendReminders(req, res));

module.exports = router;
