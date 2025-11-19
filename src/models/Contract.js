class Contract {
    constructor(data = {}) {
        this.contract_id = data.contract_id || null;
        this.order_id = data.order_id || null;
        this.device_id = data.device_id || null;
        this.imei = data.imei || '';
        this.sim_number = data.sim_number || '';
        this.billing_plan_ref = data.billing_plan_ref || '';
        this.activation_date = data.activation_date || null;
        this.mtn_contract_ref = data.mtn_contract_ref || '';
    }
}

module.exports = Contract;