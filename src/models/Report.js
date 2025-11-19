class Report {
    constructor(data = {}) {
        this.report_id = data.report_id || null;
        this.report_name = data.report_name || '';
        this.generated_date = data.generated_date || null;
        this.s3_path = data.s3_path || '';
        this.admin_op_user_id = data.admin_op_user_id || null;
    }
}

module.exports = Report;