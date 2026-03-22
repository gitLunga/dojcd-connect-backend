class DeviceCatalog {
    constructor(data = {}) {
        this.device_id = data.device_id || null;
        this.device_name = data.device_name || '';
        this.model = data.model || '';
        this.manufacturer = data.manufacturer || '';
        this.plan_name = data.plan_name || '';
        this.plan_details = data.plan_details || '';
        this.monthly_cost = data.monthly_cost || null;
        this.contract_duration_months = data.contract_duration_months || null;
        this.status = data.status || 'active';

        this.created_at = data.created_at || new Date().toISOString();
        this.updated_at = data.updated_at || new Date().toISOString();
    }
}

module.exports = DeviceCatalog;