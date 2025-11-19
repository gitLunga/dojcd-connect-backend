class Application {
    constructor(data = {}) {
        this.application_id = data.application_id || null;
        this.client_user_id = data.client_user_id || null;
        this.device_id = data.device_id || null;
        this.application_status = data.application_status || '';
        this.submission_date = data.submission_date || null;
        this.last_updated = data.last_updated || null;
        this.rejection_reason = data.rejection_reason || '';
    }
}

module.exports = Application;