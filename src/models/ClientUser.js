class ClientUser {
    constructor(data = {}) {
        this.title = data.title || null;
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

        // New fields for registration
        this.network_provider = data.network_provider || null;
        this.contract_duration_months = data.contract_duration_months || null;
        this.contract_end_date = data.contract_end_date || null;
        this.invoice_path = data.invoice_path || null;
        this.registration_status = data.registration_status || 'Pending';
        this.verification_notes = data.verification_notes || null;

        this.created_at = data.created_at || null;
        this.updated_at = data.updated_at || null;
    }

    get invoiceInfo() {
        if (!this.invoice_path) return null;

        const path = require('path');
        return {
            has_invoice: true,
            file_path: this.invoice_path,
            file_name: path.basename(this.invoice_path)
        };
    }

    // Add method to check if profile is complete
    get isProfileComplete() {
        return this.registration_status === 'Profile_Completed' ||
            this.registration_status === 'Verified';
    }
}

module.exports = ClientUser;