class Order {
    constructor(data = {}) {
        this.order_id = data.order_id || null;
        this.application_id = data.application_id || null;
        this.mtn_staff_op_user_id = data.mtn_staff_op_user_id || null;
        this.order_status = data.order_status || '';
        this.order_date = data.order_date || null;
        this.warehouse_ref = data.warehouse_ref || '';
    }
}

module.exports = Order;