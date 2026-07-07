const db  = require('../config/db');
const pdf = require('../utils/pdfGenerator');

function fail(res, msg, status = 500) {
    return res.status(status).json({ success: false, message: msg });
}

function sendPDF(res, filename, buffer) {
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Length', buffer.length);
    res.send(buffer);
}

class PdfController {

    // GET /api/pdf/allocation-letter/:applicationId
    async allocationLetter(req, res) {
        try {
            const appId = parseInt(req.params.applicationId);

            const appResult = await db.query(
                `SELECT
                     a.application_id, a.submission_date,
                     cu.title, cu.first_name, cu.last_name, cu.email,
                     cu.phone_number, cu.persal_id, cu.department_id,
                     cu.region, cu.user_type,
                     cu.contract_duration_months,
                     d.device_name, d.model, d.manufacturer,
                     d.plan_name, d.plan_details, d.monthly_cost,
                     d.contract_duration_months
                 FROM application a
                 JOIN client_user    cu ON a.client_user_id = cu.client_user_id
                 JOIN device_catalog d  ON a.device_id      = d.device_id
                 WHERE a.application_id = $1 AND a.application_status = 'Approved'`,
                [appId]
            );

            if (!appResult.rows.length) {
                return fail(res, 'Approved application not found.', 404);
            }

            const approvalResult = await db.query(
                `SELECT
                     ap.approval_stage, ap.approval_date, ap.notes,
                     ou.first_name, ou.last_name, ou.user_role
                 FROM approval ap
                 JOIN operational_user ou ON ap.approver_op_user_id = ou.op_user_id
                 WHERE ap.application_id = $1 AND ap.approval_status = 'Approved'
                 ORDER BY ap.approval_date ASC`,
                [appId]
            );

            const approvals      = approvalResult.rows;
            const managerApproval = approvals.find(a => a.approval_stage === 'manager');
            const financeApproval = approvals.find(a => a.approval_stage === 'finance');

            const row = appResult.rows[0];
            const buffer = await pdf.generateAllocationLetter({
                application:     { application_id: row.application_id, submission_date: row.submission_date },
                client:          { title: row.title, first_name: row.first_name, last_name: row.last_name, email: row.email, phone_number: row.phone_number, persal_id: row.persal_id, department_id: row.department_id, region: row.region, user_type: row.user_type },
                device:          { device_name: row.device_name, model: row.model, manufacturer: row.manufacturer, plan_name: row.plan_name, plan_details: row.plan_details, monthly_cost: row.monthly_cost, contract_duration_months: row.contract_duration_months },
                managerApproval,
                financeApproval,
            });

            sendPDF(res, `allocation_letter_${appId}.pdf`, buffer);
        } catch (err) {
            console.error('allocationLetter error:', err);
            return fail(res, err.message);
        }
    }

    // GET /api/pdf/contract/:contractId
    async contractSummary(req, res) {
        try {
            const contractId = parseInt(req.params.contractId);

            const result = await db.query(
                `SELECT
                     c.contract_id, c.imei, c.sim_number,
                     c.billing_plan_ref, c.activation_date, c.mtn_contract_ref,
                     cu.first_name, cu.last_name, cu.email, cu.phone_number,
                     cu.persal_id, cu.department_id, cu.region, cu.user_type,
                     cu.contract_duration_months, cu.contract_end_date,
                     cu.network_provider,
                     d.device_name, d.model, d.manufacturer, d.plan_name, d.monthly_cost,
                     o.order_id, o.order_date, o.order_status
                 FROM contract c
                 JOIN "order"        o  ON c.order_id       = o.order_id
                 JOIN application    a  ON o.application_id = a.application_id
                 JOIN client_user    cu ON a.client_user_id = cu.client_user_id
                 JOIN device_catalog d  ON c.device_id      = d.device_id
                 WHERE c.contract_id = $1`,
                [contractId]
            );

            if (!result.rows.length) return fail(res, 'Contract not found.', 404);

            const row = result.rows[0];
            const buffer = await pdf.generateContractSummary({
                contract: { contract_id: row.contract_id, imei: row.imei, sim_number: row.sim_number, billing_plan_ref: row.billing_plan_ref, activation_date: row.activation_date, mtn_contract_ref: row.mtn_contract_ref },
                client:   { first_name: row.first_name, last_name: row.last_name, email: row.email, phone_number: row.phone_number, persal_id: row.persal_id, department_id: row.department_id, region: row.region, user_type: row.user_type, contract_duration_months: row.contract_duration_months, contract_end_date: row.contract_end_date, network_provider: row.network_provider },
                device:   { device_name: row.device_name, model: row.model, manufacturer: row.manufacturer, plan_name: row.plan_name, monthly_cost: row.monthly_cost },
                order:    { order_id: row.order_id, order_date: row.order_date, order_status: row.order_status },
            });

            sendPDF(res, `contract_summary_${contractId}.pdf`, buffer);
        } catch (err) {
            console.error('contractSummary error:', err);
            return fail(res, err.message);
        }
    }

    // GET /api/pdf/order/:orderId
    async orderConfirmation(req, res) {
        try {
            const orderId = parseInt(req.params.orderId);

            const result = await db.query(
                `SELECT
                     o.order_id, o.order_date, o.order_status,
                     a.application_id, a.submission_date,
                     cu.first_name, cu.last_name, cu.email, cu.phone_number,
                     cu.persal_id, cu.department_id, cu.region,
                     d.device_name, d.model, d.manufacturer, d.plan_name,
                     d.monthly_cost, d.contract_duration_months
                 FROM "order" o
                 JOIN application    a  ON o.application_id = a.application_id
                 JOIN client_user    cu ON a.client_user_id = cu.client_user_id
                 JOIN device_catalog d  ON a.device_id      = d.device_id
                 WHERE o.order_id = $1`,
                [orderId]
            );

            if (!result.rows.length) return fail(res, 'Order not found.', 404);

            const delivResult = await db.query(
                `SELECT courier_name, tracking_number, delivery_address,
                        delivery_status, estimated_delivery_date
                 FROM delivery WHERE order_id = $1 LIMIT 1`,
                [orderId]
            );

            const row = result.rows[0];
            const buffer = await pdf.generateOrderConfirmation({
                order:       { order_id: row.order_id, order_date: row.order_date, order_status: row.order_status },
                application: { application_id: row.application_id, submission_date: row.submission_date },
                client:      { first_name: row.first_name, last_name: row.last_name, email: row.email, phone_number: row.phone_number, persal_id: row.persal_id, department_id: row.department_id, region: row.region },
                device:      { device_name: row.device_name, model: row.model, manufacturer: row.manufacturer, plan_name: row.plan_name, monthly_cost: row.monthly_cost, contract_duration_months: row.contract_duration_months },
                delivery:    delivResult.rows[0] || null,
            });

            sendPDF(res, `order_confirmation_${orderId}.pdf`, buffer);
        } catch (err) {
            console.error('orderConfirmation error:', err);
            return fail(res, err.message);
        }
    }
}

module.exports = new PdfController();
