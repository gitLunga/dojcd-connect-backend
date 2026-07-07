const express              = require('express');
const router               = express.Router();
const delegationController = require('../controllers/delegationController');
const authenticate         = require('../middleware/authenticate');
const requireRoles         = require('../middleware/authorize');

router.use(authenticate);

const canDelegate = requireRoles('Manager', 'Approver', 'Admin');

router.get ('/eligible',  canDelegate, (req, res) => delegationController.eligibleDelegates(req, res));
router.get ('/mine',      canDelegate, (req, res) => delegationController.myDelegation(req, res));
router.get ('/',          canDelegate, (req, res) => delegationController.list(req, res));
router.post('/',          canDelegate, (req, res) => delegationController.create(req, res));
router.delete('/:id',     canDelegate, (req, res) => delegationController.revoke(req, res));

module.exports = router;
