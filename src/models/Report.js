class Report {
    constructor(data = {}) {
        this.report_id = data.report_id || null;
        this.report_name = data.report_name || '';
        this.generated_date = data.generated_date || null;
        this.file_path = data.file_path || '';
        this.admin_op_user_id = data.admin_op_user_id || null;
    }
}

module.exports = Report;