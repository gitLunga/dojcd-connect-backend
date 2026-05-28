const express                  = require('express');
const router                   = express.Router();
const notificationController   = require('../controllers/notificationController');
const authenticate             = require('../middleware/authenticate');
const requireRoles             = require('../middleware/authorize');

router.use(authenticate);

// Any authenticated user can manage their own notifications
router.get('/user',           notificationController.getUserNotifications);
router.get('/unread-count',   notificationController.getUnreadCount);
router.patch('/:id/read',     notificationController.markAsRead);
router.patch('/mark-all-read', notificationController.markAllAsRead);
router.delete('/:id',         notificationController.deleteNotification);

// Admin only — see all notifications across all users
router.get('/all', requireRoles('Admin'), notificationController.getAllNotifications);

module.exports = router;
