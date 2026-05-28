const notificationService = require('../services/notificationService');

const notificationController = {

    getUserNotifications: async (req, res) => {
        try {
            const { userId, userType } = req.user;
            const notifications = await notificationService.getUserNotifications(userId, userType);
            res.json({ success: true, data: notifications, count: notifications.length });
        } catch (error) {
            console.error('Get user notifications error:', error);
            res.status(500).json({ success: false, message: 'Failed to fetch notifications' });
        }
    },

    getAllNotifications: async (req, res) => {
        try {
            const notifications = await notificationService.getAllNotifications();
            res.json({ success: true, data: notifications, count: notifications.length });
        } catch (error) {
            console.error('Get all notifications error:', error);
            res.status(500).json({ success: false, message: 'Failed to fetch notifications' });
        }
    },

    markAsRead: async (req, res) => {
        try {
            const { userId, userType } = req.user;
            const { id } = req.params;

            const notification = await notificationService.markAsRead(id, userId, userType);
            if (!notification) {
                return res.status(404).json({ success: false, message: 'Notification not found' });
            }
            res.json({ success: true, message: 'Notification marked as read', data: notification });
        } catch (error) {
            console.error('Mark as read error:', error);
            res.status(500).json({ success: false, message: 'Failed to mark notification as read' });
        }
    },

    markAllAsRead: async (req, res) => {
        try {
            const { userId, userType } = req.user;
            const updatedCount = await notificationService.markAllAsRead(userId, userType);
            res.json({ success: true, message: `Marked ${updatedCount} notifications as read`, updatedCount });
        } catch (error) {
            console.error('Mark all as read error:', error);
            res.status(500).json({ success: false, message: 'Failed to mark notifications as read' });
        }
    },

    getUnreadCount: async (req, res) => {
        try {
            const { userId, userType } = req.user;
            const unreadCount = await notificationService.getUnreadCount(userId, userType);
            res.json({ success: true, unreadCount });
        } catch (error) {
            console.error('Get unread count error:', error);
            res.status(500).json({ success: false, message: 'Failed to get unread count' });
        }
    },

    deleteNotification: async (req, res) => {
        try {
            const { userId, userType } = req.user;
            const { id } = req.params;

            const deleted = await notificationService.deleteNotification(id, userId, userType);
            if (!deleted) {
                return res.status(404).json({ success: false, message: 'Notification not found' });
            }
            res.json({ success: true, message: 'Notification deleted successfully', data: deleted });
        } catch (error) {
            console.error('Delete notification error:', error);
            res.status(500).json({ success: false, message: 'Failed to delete notification' });
        }
    },
};

module.exports = notificationController;
