class Delivery {
    constructor(data = {}) {
        this.delivery_id = data.delivery_id || null;
        this.order_id = data.order_id || null;
        this.warehouse_op_user_id = data.warehouse_op_user_id || null;
        this.courier_name = data.courier_name || '';
        this.tracking_number = data.tracking_number || '';
        this.delivery_address = data.delivery_address || '';
        this.delivery_status = data.delivery_status || '';
        this.dispatch_date = data.dispatch_date || null;
        this.estimated_delivery_date = data.estimated_delivery_date || null;
        this.actual_delivery_date = data.actual_delivery_date || null;
    }
}

module.exports = Delivery;