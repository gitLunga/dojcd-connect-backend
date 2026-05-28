const express         = require('express');
const router          = express.Router();
const auditController = require('../controllers/auditController');
const authenticate    = require('../middleware/authenticate');
const requireRoles    = require('../middleware/authorize');

router.use(authenticate);
router.use(requireRoles('Admin'));

// GET /api/audit/logs?actor_id=&actor_type=&action=&entity_type=&entity_id=&date_from=&date_to=&limit=&offset=
router.get('/logs',   (req, res) => auditController.getAuditLogs(req, res));

// GET /api/audit/logins?email=&success=true|false&date_from=&date_to=&limit=&offset=
router.get('/logins', (req, res) => auditController.getLoginAttempts(req, res));

module.exports = router;
