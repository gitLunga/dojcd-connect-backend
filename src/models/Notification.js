class Notification {
    constructor(data = {}) {
        this.notification_id = data.notification_id || null;
        this.user_id = data.user_id || null;
        this.user_type = data.user_type || ''; // 'Client' or 'Operational'
        this.title = data.title || '';
        this.message = data.message || '';
        this.is_read = data.is_read || false;
        this.created_at = data.created_at || null;
      //  this.read_at = data.read_at || null;
    }
}

module.exports = Notification;