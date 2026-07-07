const express          = require('express');
const router           = express.Router();
const returnController = require('../controllers/returnController');
const authenticate     = require('../middleware/authenticate');
const requireRoles     = require('../middleware/authorize');

router.use(authenticate);

const canManage = requireRoles('Admin', 'Manager', 'Finance');
const canView   = requireRoles('Admin', 'Manager', 'Finance', 'Approver');

router.get ('/',            canView,   (req, res) => returnController.list(req, res));
router.get ('/summary',     canView,   (req, res) => returnController.summary(req, res));
router.get ('/:id',         canView,   (req, res) => returnController.getOne(req, res));
router.post('/',            canManage, (req, res) => returnController.initiate(req, res));
router.patch('/:id/status', canManage, (req, res) => returnController.updateStatus(req, res));

module.exports = router;
