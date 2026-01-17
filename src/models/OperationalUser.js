class OperationalUser {
    constructor(data = {}) {
        this.op_user_id = data.op_user_id || null;
        this.title = data.title || null;
        this.first_name = data.first_name || '';
        this.last_name = data.last_name || '';
        this.email = data.email || '';
        this.user_role = data.user_role || '';
        this.password_hash = data.password_hash || '';
        this.cognito_id = data.cognito_id || '';

        this.created_at = data.created_at || null;
        this.updated_at = data.updated_at || null;

    }
}

module.exports = OperationalUser;