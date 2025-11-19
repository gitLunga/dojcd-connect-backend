class Approval {
    constructor(data = {}) {
        this.approval_id = data.approval_id || null;
        this.application_id = data.application_id || null;
        this.approver_op_user_id = data.approver_op_user_id || null;
        this.approval_status = data.approval_status || '';
        this.approval_date = data.approval_date || null;
        this.notes = data.notes || '';
    }
}

module.exports = Approval;