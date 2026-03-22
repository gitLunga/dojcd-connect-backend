const notificationService = require('../services/notificationService');

const notificationController = {
    // Get notifications for a specific user
    getUserNotifications: async (req, res) => {
        try {
            // Get from query params only (not from body for GET requests)
            const userId = req.query.user_id;
            const userType = req.query.user_type;

            if (!userId || !userType) {
                return res.status(400).json({
                    success: false,
                    message: 'user_id and user_type are required as query parameters'
                });
            }

            const notifications = await notificationService.getUserNotifications(userId, userType);

            res.json({
                success: true,
                data: notifications,
                count: notifications.length
            });
        } catch (error) {
            console.error('Get user notifications error:', error);
            res.status(500).json({
                success: false,
                message: 'Failed to fetch notifications'
            });
        }
    },

    // Get all notifications (Admin)
    getAllNotifications: async (req, res) => {
        try {
            const notifications = await notificationService.getAllNotifications();

            res.json({
                success: true,
                data: notifications,
                count: notifications.length
            });
        } catch (error) {
            console.error('Get all notifications error:', error);
            res.status(500).json({
                success: false,
                message: 'Failed to fetch notifications'
            });
        }
    },

    // Mark notification as read
    markAsRead: async (req, res) => {
        try {
            const { id } = req.params;
            const { user_id, user_type } = req.body;

            if (!id || !user_id || !user_type) {
                return res.status(400).json({
                    success: false,
                    message: 'Notification ID, user_id, and user_type are required in request body'
                });
            }

            const notification = await notificationService.markAsRead(id, user_id, user_type);

            if (!notification) {
                return res.status(404).json({
                    success: false,
                    message: 'Notification not found'
                });
            }

            res.json({
                success: true,
                message: 'Notification marked as read',
                data: notification
            });
        } catch (error) {
            console.error('Mark as read error:', error);
            res.status(500).json({
                success: false,
                message: 'Failed to mark notification as read'
            });
        }
    },

    // Mark all as read for a user
    markAllAsRead: async (req, res) => {
        try {
            const { user_id, user_type } = req.body;

            if (!user_id || !user_type) {
                return res.status(400).json({
                    success: false,
                    message: 'user_id and user_type are required in request body'
                });
            }

            const updatedCount = await notificationService.markAllAsRead(user_id, user_type);

            res.json({
                success: true,
                message: `Marked ${updatedCount} notifications as read`,
                updatedCount: updatedCount
            });
        } catch (error) {
            console.error('Mark all as read error:', error);
            res.status(500).json({
                success: false,
                message: 'Failed to mark notifications as read'
            });
        }
    },

    // Get unread count - FIXED: Only use query params for GET requests
    getUnreadCount: async (req, res) => {
        try {
            const userId = req.query.user_id;
            const userType = req.query.user_type;

            if (!userId || !userType) {
                return res.status(400).json({
                    success: false,
                    message: 'user_id and user_type are required as query parameters'
                });
            }

            const unreadCount = await notificationService.getUnreadCount(userId, userType);

            res.json({
                success: true,
                unreadCount: unreadCount
            });
        } catch (error) {
            console.error('Get unread count error:', error);
            res.status(500).json({
                success: false,
                message: 'Failed to get unread count'
            });
        }
    },

    // Delete notification
    deleteNotification: async (req, res) => {
        try {
            const { id } = req.params;
            const { user_id, user_type } = req.body;

            if (!id || !user_id || !user_type) {
                return res.status(400).json({
                    success: false,
                    message: 'Notification ID, user_id, and user_type are required in request body'
                });
            }

            const deletedNotification = await notificationService.deleteNotification(id, user_id, user_type);

            if (!deletedNotification) {
                return res.status(404).json({
                    success: false,
                    message: 'Notification not found'
                });
            }

            res.json({
                success: true,
                message: 'Notification deleted successfully',
                data: deletedNotification
            });
        } catch (error) {
            console.error('Delete notification error:', error);
            res.status(500).json({
                success: false,
                message: 'Failed to delete notification'
            });
        }
    }
};

module.exports = notificationController;