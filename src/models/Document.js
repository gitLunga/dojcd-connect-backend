class Document {
    constructor(data = {}) {
        this.document_id = data.document_id || null;
        this.application_id = data.application_id || null;
        this.client_user_id = data.client_user_id || null;
        this.document_type = data.document_type || '';
        this.s3_path = data.s3_path || '';
        this.upload_date = data.upload_date || null;
    }
}

module.exports = Document;