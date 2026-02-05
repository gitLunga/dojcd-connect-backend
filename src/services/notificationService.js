const db = require('../config/db');

class NotificationService {
    /**
     * Create a notification
     */
     async createNotification(userId, userType, title, message) {
        try {
            const query = `
                INSERT INTO notification (user_id, user_type, title, message)
                VALUES ($1, $2, $3, $4)
                    RETURNING notification_id, created_at
            `;

            const result = await db.query(query, [userId, userType, title, message]);
            return result.rows[0];
        } catch (error) {
            console.error('Error creating notification:', error);
            throw error;
        }
    }

    /**
     * Get notifications for a specific user
     */
    async getUserNotifications(userId, userType) {
        try {
            const query = `
                SELECT
                    notification_id,
                    title,
                    message,
                    is_read,
                    created_at
                FROM notification
                WHERE user_id = $1 AND user_type = $2
                ORDER BY created_at DESC
                    LIMIT 50
            `;

            const result = await db.query(query, [userId, userType]);
            return result.rows;
        } catch (error) {
            console.error('Error getting user notifications:', error);
            throw error;
        }
    }

    /**
     * Get all notifications (for admin)
     */
    async getAllNotifications() {
        try {
            const query = `
                SELECT
                    n.notification_id,
                    n.user_id,
                    n.user_type,
                    n.title,
                    n.message,
                    n.is_read,
                    n.created_at,
                    cu.first_name as user_first_name,
                    cu.last_name as user_last_name
                FROM notification n
                         LEFT JOIN client_user cu ON n.user_id = cu.client_user_id AND n.user_type = 'Client'
                         LEFT JOIN operational_user ou ON n.user_id = ou.op_user_id AND n.user_type = 'Operational'
                ORDER BY n.created_at DESC
                    LIMIT 100
            `;

            const result = await db.query(query);
            return result.rows;
        } catch (error) {
            console.error('Error getting all notifications:', error);
            throw error;
        }
    }

    /**
     * Mark notification as read
     */
    async markAsRead(notificationId, userId, userType) {
        try {
            const query = `
                UPDATE notification
                SET is_read = true
                  
                WHERE notification_id = $1
                  AND user_id = $2
                  AND user_type = $3
                    RETURNING *
            `;

            const result = await db.query(query, [notificationId, userId, userType]);
            return result.rows[0];
        } catch (error) {
            console.error('Error marking notification as read:', error);
            throw error;
        }
    }

    /**
     * Mark all notifications as read for a user
     */
    async markAllAsRead(userId, userType) {
        try {
            const query = `
                UPDATE notification
                SET is_read = true
                WHERE user_id = $1
                  AND user_type = $2
                  AND is_read = false
            `;

            const result = await db.query(query, [userId, userType]);
            return result.rowCount || 0;
        } catch (error) {
            console.error('Error marking all notifications as read:', error);
            throw error;
        }
    }

    /**
     * Get unread count for a user
     */
    async getUnreadCount(userId, userType) {
        try {
            const query = `
                SELECT COUNT(*) as unread_count
                FROM notification
                WHERE user_id = $1
                  AND user_type = $2
                  AND is_read = false
            `;

            const result = await db.query(query, [userId, userType]);
            return parseInt(result.rows[0].unread_count);
        } catch (error) {
            console.error('Error getting unread count:', error);
            throw error;
        }
    }

    /**
     * Delete a notification
     */
    async deleteNotification(notificationId, userId, userType) {
        try {
            const query = `
                DELETE FROM notification
                WHERE notification_id = $1
                  AND user_id = $2
                  AND user_type = $3
                    RETURNING *
            `;

            const result = await db.query(query, [notificationId, userId, userType]);
            return result.rows[0];
        } catch (error) {
            console.error('Error deleting notification:', error);
            throw error;
        }
    }
}

module.exports = new NotificationService();