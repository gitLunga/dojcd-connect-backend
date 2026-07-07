const express            = require('express');
const router             = express.Router();
const budgetController   = require('../controllers/budgetController');
const authenticate       = require('../middleware/authenticate');
const requireRoles       = require('../middleware/authorize');

router.use(authenticate);

// Spend view — Finance and Admin can see; Manager read-only
router.get ('/spend',  requireRoles('Admin', 'Finance', 'Manager'), (req, res) => budgetController.spend(req, res));

// Budget management — Admin and Finance only
router.get ('/',       requireRoles('Admin', 'Finance'),            (req, res) => budgetController.list(req, res));
router.post('/',       requireRoles('Admin', 'Finance'),            (req, res) => budgetController.upsert(req, res));
router.delete('/:id',  requireRoles('Admin', 'Finance'),            (req, res) => budgetController.remove(req, res));

module.exports = router;
