const express           = require('express');
const router            = express.Router();
const authenticate      = require('../middleware/authenticate');
const requireRoles      = require('../middleware/authorize');
const profileController = require('../controllers/profileController');

// Any authenticated operational user can manage their own profile
router.use(authenticate);
router.use(requireRoles('Admin', 'Manager', 'Finance', 'Approver', 'MTN_Staff'));

router.get('/me',   (req, res) => profileController.getMyProfile(req, res));
router.patch('/me', (req, res) => profileController.updateMyProfile(req, res));

module.exports = router;
