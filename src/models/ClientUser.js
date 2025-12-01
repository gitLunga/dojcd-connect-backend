class ClientUser {
    constructor(data = {}) {
        this.client_user_id = data.client_user_id || null;
        this.title = data.title || null;
        this.first_name = data.first_name || '';
        this.last_name = data.last_name || '';
        this.email = data.email || '';
        this.phone_number = data.phone_number || '';
        this.region = data.region || '';
        this.persal_id = data.persal_id || '';
        this.department_id = data.department_id || '';
        this.user_type = data.user_type || '';
        this.password_hash = data.password_hash || '';
        this.cognito_id = data.cognito_id || '';
    }
}

module.exports = ClientUser;