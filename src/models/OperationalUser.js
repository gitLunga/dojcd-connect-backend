class OperationalUser {
    constructor(data = {}) {
        this.op_user_id          = data.op_user_id          || null;
        this.title               = data.title               || null;
        this.first_name          = data.first_name          || '';
        this.last_name           = data.last_name           || '';
        this.email               = data.email               || '';
        this.user_role           = data.user_role           || '';
        this.department_id       = data.department_id       || null;
        this.password_hash       = data.password_hash       || '';
        this.cognito_id          = data.cognito_id          || null;
        this.must_change_password = data.must_change_password !== undefined
            ? data.must_change_password : true;
        this.is_super_admin      = data.is_super_admin      || false;
        this.is_deleted          = data.is_deleted          || false;
        this.deleted_at          = data.deleted_at          || null;
        this.created_at          = data.created_at          || null;
        this.updated_at          = data.updated_at          || null;
    }
}

module.exports = OperationalUser;
