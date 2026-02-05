const express = require('express');
const router = express.Router();
const notificationController = require('../controllers/notificationController');

// Add this with your other routes

// Get notifications for a specific user
router.get('/user', notificationController.getUserNotifications); // GET /api/notifications/user?user_id=1&user_type=Client

// Get all notifications (Admin)
router.get('/all', notificationController.getAllNotifications); // GET /api/notifications/all

// Get unread count
router.get('/unread-count', notificationController.getUnreadCount); // GET /api/notifications/unread-count?user_id=1&user_type=Client

// Mark notification as read
router.patch('/:id/read', notificationController.markAsRead); // PATCH /api/notifications/1/read

// Mark all as read for a user
router.patch('/mark-all-read', notificationController.markAllAsRead); // PATCH /api/notifications/mark-all-read

// Delete notification
router.delete('/:id', notificationController.deleteNotification); // DELETE /api/notifications/1
module.exports = router;