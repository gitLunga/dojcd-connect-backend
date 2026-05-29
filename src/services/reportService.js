const db      = require('../config/db');
const storage = require('../config/localStorage');
const { toCSV } = require('../utils/csvExport');

// ── Shared data queries ───────────────────────────────────────────────────────

async function fetchApplicationsData(filters = {}) {
    const conditions = ['1=1'];
    const params     = [];
    let   idx        = 1;

    if (filters.status)      { conditions.push(`a.application_status = $${idx++}`); params.push(filters.status); }
    if (filters.region)      { conditions.push(`cu.region = $${idx++}`);            params.push(filters.region); }
    if (filters.date_from)   { conditions.push(`a.submission_date >= $${idx++}`);   params.push(filters.date_from); }
    if (filters.date_to)     { conditions.push(`a.submission_date <= $${idx++}`);   params.push(filters.date_to); }
    if (filters.department_id) { conditions.push(`cu.department_id = $${idx++}`);   params.push(filters.department_id); }

    const result = await db.query(`
        SELECT
            a.application_id,
            a.application_status,
            a.submission_date,
            a.last_updated,
            a.rejection_reason,
            cu.first_name        AS applicant_first_name,
            cu.last_name         AS applicant_last_name,
            cu.email             AS applicant_email,
            cu.persal_id,
            cu.department_id,
            cu.region,
            cu.user_type         AS applicant_type,
            d.device_name,
            d.model,
            d.manufacturer,
            d.plan_name,
            d.monthly_cost,
            d.contract_duration_months,
            mgr_ap.approval_date AS manager_approval_date,
            CONCAT(mgr.first_name,' ',mgr.last_name) AS manager_name,
            fin_ap.approval_date AS finance_approval_date,
            CONCAT(fin.first_name,' ',fin.last_name) AS finance_name,
            o.order_id,
            o.order_status,
            o.order_date
        FROM application a
        JOIN client_user    cu  ON a.client_user_id = cu.client_user_id
        JOIN device_catalog d   ON a.device_id      = d.device_id
        LEFT JOIN approval  mgr_ap ON mgr_ap.application_id = a.application_id AND mgr_ap.approval_stage = 'manager'
        LEFT JOIN operational_user mgr ON mgr_ap.approver_op_user_id = mgr.op_user_id
        LEFT JOIN approval  fin_ap ON fin_ap.application_id = a.application_id AND fin_ap.approval_stage = 'finance'
        LEFT JOIN operational_user fin ON fin_ap.approver_op_user_id = fin.op_user_id
        LEFT JOIN "order"   o   ON a.application_id = o.application_id
        WHERE ${conditions.join(' AND ')}
        ORDER BY a.submission_date DESC
    `, params);

    return result.rows;
}

async function fetchUsersData(filters = {}) {
    const conditions = ['1=1'];
    const params     = [];
    let   idx        = 1;

    if (filters.registration_status) { conditions.push(`registration_status = $${idx++}`); params.push(filters.registration_status); }
    if (filters.region)              { conditions.push(`region = $${idx++}`);              params.push(filters.region); }
    if (filters.user_type)           { conditions.push(`user_type = $${idx++}`);           params.push(filters.user_type); }

    const result = await db.query(`
        SELECT
            client_user_id,
            CONCAT(first_name,' ',last_name) AS full_name,
            email,
            phone_number,
            region,
            department_id,
            persal_id,
            user_type,
            registration_status,
            network_provider,
            contract_duration_months,
            contract_end_date,
            created_at
        FROM client_user
        WHERE ${conditions.join(' AND ')}
        ORDER BY created_at DESC
    `, params);

    return result.rows;
}

async function fetchInventoryData() {
    const result = await db.query(`
        SELECT
            d.device_id,
            d.device_name,
            d.model,
            d.manufacturer,
            d.plan_name,
            d.monthly_cost,
            d.contract_duration_months,
            d.status,
            d.stock_quantity,
            COUNT(a.application_id)                                                       AS total_applications,
            COUNT(a.application_id) FILTER (WHERE a.application_status = 'Pending')       AS pending_applications,
            COUNT(a.application_id) FILTER (WHERE a.application_status IN ('Approved','Pending_Finance')) AS active_applications,
            COUNT(o.order_id)                                                              AS total_orders,
            COUNT(o.order_id) FILTER (WHERE o.order_status = 'Delivered')                 AS delivered_orders,
            CASE
                WHEN d.stock_quantity IS NULL THEN 'Unlimited'
                WHEN d.stock_quantity - COUNT(o.order_id) FILTER (WHERE o.order_status IN ('Processing','Dispatched','Delivered')) < 0
                    THEN '0'
                ELSE (d.stock_quantity - COUNT(o.order_id) FILTER (WHERE o.order_status IN ('Processing','Dispatched','Delivered')))::TEXT
            END AS available_stock
        FROM device_catalog d
        LEFT JOIN application a ON a.device_id = d.device_id
        LEFT JOIN "order"     o ON o.application_id = a.application_id
        GROUP BY d.device_id
        ORDER BY d.device_name
    `);
    return result.rows;
}

async function fetchSlaData() {
    const SLA = require('../config/slaConfig');
    const result = await db.query(`
        WITH stage_times AS (
            SELECT a.application_id, a.application_status, a.submission_date,
                cu.first_name, cu.last_name, cu.email, cu.region, cu.department_id,
                d.device_name, d.plan_name,
                CASE
                    WHEN a.application_status = 'Pending'         THEN a.submission_date
                    WHEN a.application_status = 'Pending_Finance' THEN
                        (SELECT ap.approval_date FROM approval ap WHERE ap.application_id = a.application_id AND ap.approval_stage = 'manager' LIMIT 1)
                    WHEN a.application_status = 'Approved'        THEN
                        (SELECT ap.approval_date FROM approval ap WHERE ap.application_id = a.application_id AND ap.approval_stage = 'finance' LIMIT 1)
                END AS stage_entry_date,
                CASE
                    WHEN a.application_status = 'Pending'         THEN $1
                    WHEN a.application_status = 'Pending_Finance' THEN $2
                    WHEN a.application_status = 'Approved'        THEN $3
                END AS sla_days
            FROM application a
            JOIN client_user cu ON a.client_user_id = cu.client_user_id
            JOIN device_catalog d ON a.device_id = d.device_id
            WHERE a.application_status IN ('Pending','Pending_Finance','Approved')
        )
        SELECT *,
            ROUND(EXTRACT(EPOCH FROM (NOW()-stage_entry_date))/86400,1) AS days_in_stage,
            CASE
                WHEN EXTRACT(EPOCH FROM (NOW()-stage_entry_date))/86400 > sla_days THEN 'breached'
                WHEN EXTRACT(EPOCH FROM (NOW()-stage_entry_date))/86400 > sla_days*0.8 THEN 'approaching'
                ELSE 'within'
            END AS sla_status
        FROM stage_times
        WHERE stage_entry_date IS NOT NULL
        ORDER BY days_in_stage DESC
    `, [SLA.Pending.sla_days, SLA.Pending_Finance.sla_days, SLA.Approved.sla_days]);
    return result.rows;
}

// ── Report record helpers ─────────────────────────────────────────────────────

async function saveReportRecord(client, { reportName, csvContent, adminUserId }) {
    const savedPath = await storage.uploadFile(
        Buffer.from(csvContent, 'utf8'),
        'text/csv',
        'reports',
        reportName.toLowerCase().replace(/\s+/g, '_'),
        adminUserId
    );

    const result = await client.query(
        `INSERT INTO report (report_name, file_path, admin_op_user_id)
         VALUES ($1, $2, $3) RETURNING report_id, generated_date`,
        [reportName, savedPath, adminUserId]
    );

    return { ...result.rows[0], file_path: savedPath };
}

// ── Public API ────────────────────────────────────────────────────────────────

async function generateApplicationsReport(filters, adminUserId) {
    const rows = await fetchApplicationsData(filters);
    const columns = [
        { key: 'application_id',         label: 'Application ID' },
        { key: 'application_status',     label: 'Status' },
        { key: 'applicant_first_name',   label: 'First Name' },
        { key: 'applicant_last_name',    label: 'Last Name' },
        { key: 'applicant_email',        label: 'Email' },
        { key: 'persal_id',              label: 'Persal ID' },
        { key: 'department_id',          label: 'Department' },
        { key: 'region',                 label: 'Region' },
        { key: 'applicant_type',         label: 'User Type' },
        { key: 'device_name',            label: 'Device' },
        { key: 'plan_name',              label: 'Plan' },
        { key: 'monthly_cost',           label: 'Monthly Cost (R)' },
        { key: 'contract_duration_months', label: 'Contract (months)' },
        { key: 'submission_date',        label: 'Submitted' },
        { key: 'manager_approval_date',  label: 'Manager Approved' },
        { key: 'manager_name',           label: 'Manager' },
        { key: 'finance_approval_date',  label: 'Finance Approved' },
        { key: 'finance_name',           label: 'Finance Officer' },
        { key: 'order_status',           label: 'Order Status' },
        { key: 'rejection_reason',       label: 'Rejection Reason' },
    ];

    const csv = toCSV(rows, columns);

    const client = await db.connect();
    try {
        await client.query('BEGIN');
        const meta = await saveReportRecord(client, { reportName: 'Applications Report', csvContent: csv, adminUserId });
        await client.query('COMMIT');
        return { rows, csv, meta, columns };
    } catch (err) {
        await client.query('ROLLBACK');
        return { rows, csv, meta: null, columns }; // non-fatal if save fails
    } finally {
        client.release();
    }
}

async function generateUsersReport(filters, adminUserId) {
    const rows = await fetchUsersData(filters);
    const columns = [
        { key: 'client_user_id',          label: 'User ID' },
        { key: 'full_name',               label: 'Full Name' },
        { key: 'email',                   label: 'Email' },
        { key: 'phone_number',            label: 'Phone' },
        { key: 'region',                  label: 'Region' },
        { key: 'department_id',           label: 'Department' },
        { key: 'persal_id',               label: 'Persal ID' },
        { key: 'user_type',               label: 'User Type' },
        { key: 'registration_status',     label: 'Registration Status' },
        { key: 'network_provider',        label: 'Network Provider' },
        { key: 'contract_duration_months', label: 'Contract Duration' },
        { key: 'contract_end_date',       label: 'Contract End Date' },
        { key: 'created_at',              label: 'Registered On' },
    ];

    const csv = toCSV(rows, columns);

    const client = await db.connect();
    try {
        await client.query('BEGIN');
        const meta = await saveReportRecord(client, { reportName: 'Users Report', csvContent: csv, adminUserId });
        await client.query('COMMIT');
        return { rows, csv, meta, columns };
    } catch (err) {
        await client.query('ROLLBACK');
        return { rows, csv, meta: null, columns };
    } finally {
        client.release();
    }
}

async function generateInventoryReport(adminUserId) {
    const rows = await fetchInventoryData();
    const columns = [
        { key: 'device_id',               label: 'Device ID' },
        { key: 'device_name',             label: 'Device Name' },
        { key: 'model',                   label: 'Model' },
        { key: 'manufacturer',            label: 'Manufacturer' },
        { key: 'plan_name',               label: 'Plan' },
        { key: 'monthly_cost',            label: 'Monthly Cost (R)' },
        { key: 'status',                  label: 'Catalog Status' },
        { key: 'stock_quantity',          label: 'Stock Qty' },
        { key: 'available_stock',         label: 'Available Stock' },
        { key: 'total_applications',      label: 'Total Applications' },
        { key: 'pending_applications',    label: 'Pending Review' },
        { key: 'active_applications',     label: 'In Approval' },
        { key: 'total_orders',            label: 'Total Orders' },
        { key: 'delivered_orders',        label: 'Delivered' },
    ];

    const csv = toCSV(rows, columns);

    const client = await db.connect();
    try {
        await client.query('BEGIN');
        const meta = await saveReportRecord(client, { reportName: 'Inventory Report', csvContent: csv, adminUserId });
        await client.query('COMMIT');
        return { rows, csv, meta, columns };
    } catch (err) {
        await client.query('ROLLBACK');
        return { rows, csv, meta: null, columns };
    } finally {
        client.release();
    }
}

async function generateSlaReport(adminUserId) {
    const rows = await fetchSlaData();
    const columns = [
        { key: 'application_id',     label: 'Application ID' },
        { key: 'application_status', label: 'Stage' },
        { key: 'first_name',         label: 'First Name' },
        { key: 'last_name',          label: 'Last Name' },
        { key: 'email',              label: 'Email' },
        { key: 'region',             label: 'Region' },
        { key: 'department_id',      label: 'Department' },
        { key: 'device_name',        label: 'Device' },
        { key: 'submission_date',    label: 'Submitted' },
        { key: 'stage_entry_date',   label: 'Stage Started' },
        { key: 'sla_days',           label: 'SLA (days)' },
        { key: 'days_in_stage',      label: 'Days in Stage' },
        { key: 'sla_status',         label: 'SLA Status' },
    ];

    const csv = toCSV(rows, columns);

    const client = await db.connect();
    try {
        await client.query('BEGIN');
        const meta = await saveReportRecord(client, { reportName: 'SLA Compliance Report', csvContent: csv, adminUserId });
        await client.query('COMMIT');
        return { rows, csv, meta, columns };
    } catch (err) {
        await client.query('ROLLBACK');
        return { rows, csv, meta: null, columns };
    } finally {
        client.release();
    }
}

async function getReportHistory(filters = {}) {
    const limit  = Math.min(parseInt(filters.limit  || 50), 200);
    const offset = parseInt(filters.offset || 0);

    const result = await db.query(`
        SELECT r.report_id, r.report_name, r.generated_date, r.file_path,
               ou.first_name || ' ' || ou.last_name AS generated_by,
               ou.email AS generated_by_email
        FROM report r
        JOIN operational_user ou ON r.admin_op_user_id = ou.op_user_id
        ORDER BY r.generated_date DESC
        LIMIT $1 OFFSET $2
    `, [limit, offset]);

    const count = await db.query(`SELECT COUNT(*) FROM report`);

    return { reports: result.rows, total: parseInt(count.rows[0].count), limit, offset };
}

module.exports = {
    generateApplicationsReport,
    generateUsersReport,
    generateInventoryReport,
    generateSlaReport,
    getReportHistory,
    fetchInventoryData,
};
