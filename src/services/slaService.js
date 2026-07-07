const db  = require('../config/db');
const SLA = require('../config/slaConfig');

// ── Core CTE: SLA thresholds are inlined as integer literals (no parameter
// type-inference ambiguity with node-postgres). Only filter/limit/offset
// values are passed as bound parameters — those start at $1.

function buildSlaCte() {
    const mDays = parseInt(SLA.Pending.sla_days);
    const fDays = parseInt(SLA.Pending_Finance.sla_days);
    const oDays = parseInt(SLA.Approved.sla_days);
    const warnPct = parseFloat(SLA.Pending.warning_threshold);   // e.g. 0.8

    return `
WITH stage_times AS (
    SELECT
        a.application_id,
        a.application_status,
        a.submission_date,
        a.last_updated,
        a.client_user_id,
        a.device_id,
        CASE
            WHEN a.application_status = 'Pending'
                THEN a.submission_date
            WHEN a.application_status = 'Pending_Finance'
                THEN (SELECT ap.approval_date FROM approval ap
                      WHERE ap.application_id = a.application_id
                        AND ap.approval_stage = 'manager'
                      ORDER BY ap.approval_date DESC LIMIT 1)
            WHEN a.application_status = 'Approved'
                THEN (SELECT ap.approval_date FROM approval ap
                      WHERE ap.application_id = a.application_id
                        AND ap.approval_stage = 'finance'
                      ORDER BY ap.approval_date DESC LIMIT 1)
        END                                       AS stage_entry_date,
        CASE
            WHEN a.application_status = 'Pending'         THEN ${mDays}
            WHEN a.application_status = 'Pending_Finance' THEN ${fDays}
            WHEN a.application_status = 'Approved'        THEN ${oDays}
        END                                       AS sla_days,
        CASE
            WHEN a.application_status = 'Pending'         THEN 'Manager Review'
            WHEN a.application_status = 'Pending_Finance' THEN 'Finance Review'
            WHEN a.application_status = 'Approved'        THEN 'Order Placement'
        END                                       AS stage_name
    FROM application a
    WHERE a.application_status IN ('Pending', 'Pending_Finance', 'Approved')
      AND (
          a.application_status <> 'Approved'
          OR NOT EXISTS (
              SELECT 1 FROM "order" o WHERE o.application_id = a.application_id
          )
      )
),
sla_calc AS (
    SELECT
        st.*,
        ROUND(
            EXTRACT(EPOCH FROM (NOW() - st.stage_entry_date)) / 86400, 1
        )::numeric                                                    AS days_in_stage,
        ROUND(
            EXTRACT(EPOCH FROM (NOW() - st.stage_entry_date)) / 86400
            / NULLIF(st.sla_days, 0) * 100
        )::int                                                        AS sla_percent_used,
        CASE
            WHEN EXTRACT(EPOCH FROM (NOW() - st.stage_entry_date)) / 86400
                 > st.sla_days
                THEN 'breached'
            WHEN EXTRACT(EPOCH FROM (NOW() - st.stage_entry_date)) / 86400
                 > st.sla_days * ${warnPct}
                THEN 'approaching'
            ELSE 'within'
        END                                                           AS sla_status
    FROM stage_times st
    WHERE st.stage_entry_date IS NOT NULL
)
`;
}

// ── Dashboard summary ─────────────────────────────────────────────────────────

async function getSlaDashboard() {
    const result = await db.query(
        buildSlaCte() + `
        SELECT
            sc.application_status,
            sc.stage_name,
            COUNT(*)                                   AS total,
            COUNT(*) FILTER (WHERE sc.sla_status = 'within')      AS within_sla,
            COUNT(*) FILTER (WHERE sc.sla_status = 'approaching')  AS approaching_sla,
            COUNT(*) FILTER (WHERE sc.sla_status = 'breached')     AS breached_sla,
            ROUND(AVG(sc.days_in_stage), 1)            AS avg_days_in_stage,
            MAX(sc.days_in_stage)                      AS max_days_in_stage,
            MIN(sc.sla_days)                           AS sla_threshold_days
        FROM sla_calc sc
        GROUP BY sc.application_status, sc.stage_name
        ORDER BY sc.application_status`
        // no bound params — all thresholds are inlined by buildSlaCte()
    );

    const stageRows = result.rows;

    const overall = stageRows.reduce(
        (acc, r) => {
            acc.total         += parseInt(r.total);
            acc.within        += parseInt(r.within_sla);
            acc.approaching   += parseInt(r.approaching_sla);
            acc.breached      += parseInt(r.breached_sla);
            return acc;
        },
        { total: 0, within: 0, approaching: 0, breached: 0 }
    );

    overall.compliance_pct = overall.total > 0
        ? Math.round((overall.within / overall.total) * 100)
        : 100;

    return { stages: stageRows, overall };
}

// ── Active applications with SLA status (filterable) ─────────────────────────

async function getSlaApplications(filters = {}) {
    const params  = [];
    const clauses = [];
    let idx = 1;   // thresholds are inlined; params start at $1

    if (filters.sla_status) {
        clauses.push(`sc.sla_status = $${idx++}`);
        params.push(filters.sla_status);
    }
    if (filters.application_status) {
        clauses.push(`sc.application_status = $${idx++}`);
        params.push(filters.application_status);
    }
    if (filters.region) {
        clauses.push(`cu.region = $${idx++}`);
        params.push(filters.region);
    }
    if (filters.department_id) {
        clauses.push(`cu.department_id = $${idx++}`);
        params.push(filters.department_id);
    }

    const where  = clauses.length ? `AND ${clauses.join(' AND ')}` : '';
    const limit  = Math.min(parseInt(filters.limit  || 50), 200);
    const offset = parseInt(filters.offset || 0);
    const cte    = buildSlaCte();

    const [dataResult, countResult] = await Promise.all([
        db.query(
            cte + `
            SELECT
                sc.application_id,
                sc.application_status,
                sc.stage_name,
                sc.submission_date,
                sc.stage_entry_date,
                sc.sla_days,
                sc.days_in_stage,
                sc.sla_percent_used,
                sc.sla_status,
                cu.first_name         AS applicant_first_name,
                cu.last_name          AS applicant_last_name,
                cu.email              AS applicant_email,
                cu.region             AS applicant_region,
                cu.department_id,
                cu.user_type          AS applicant_type,
                cu.persal_id,
                d.device_name,
                d.plan_name,
                d.monthly_cost
            FROM sla_calc sc
            JOIN client_user    cu ON sc.client_user_id = cu.client_user_id
            JOIN device_catalog d  ON sc.device_id      = d.device_id
            WHERE 1=1 ${where}
            ORDER BY sc.sla_percent_used DESC, sc.days_in_stage DESC
            LIMIT $${idx} OFFSET $${idx + 1}`,
            [...params, limit, offset]
        ),
        db.query(
            cte + `
            SELECT COUNT(*) AS total
            FROM sla_calc sc
            JOIN client_user cu ON sc.client_user_id = cu.client_user_id
            WHERE 1=1 ${where}`,
            params
        ),
    ]);

    return {
        applications: dataResult.rows,
        total:        parseInt(countResult.rows[0].total),
        limit,
        offset,
        sla_config:   {
            manager_days:  SLA.Pending.sla_days,
            finance_days:  SLA.Pending_Finance.sla_days,
            order_days:    SLA.Approved.sla_days,
            warning_at:    `${SLA.Pending.warning_threshold * 100}%`,
        },
    };
}

// ── Single application SLA detail ─────────────────────────────────────────────

async function getApplicationSlaDetail(applicationId) {
    // Full approval history with stage-by-stage SLA analysis
    const appResult = await db.query(
        `SELECT
             a.application_id,
             a.application_status,
             a.submission_date,
             a.last_updated,
             a.rejection_reason,
             cu.first_name, cu.last_name, cu.email,
             cu.region, cu.department_id, cu.persal_id,
             d.device_name, d.plan_name, d.monthly_cost
         FROM application a
         JOIN client_user    cu ON a.client_user_id = cu.client_user_id
         JOIN device_catalog d  ON a.device_id      = d.device_id
         WHERE a.application_id = $1`,
        [applicationId]
    );

    if (appResult.rows.length === 0) throw new Error(`Application #${applicationId} not found.`);

    const app = appResult.rows[0];

    // All approval events for this application
    const historyResult = await db.query(
        `SELECT
             ap.approval_stage,
             ap.approval_status,
             ap.approval_date,
             ap.notes,
             ou.first_name AS approver_first_name,
             ou.last_name  AS approver_last_name,
             ou.user_role  AS approver_role
         FROM approval ap
         JOIN operational_user ou ON ap.approver_op_user_id = ou.op_user_id
         WHERE ap.application_id = $1
         ORDER BY ap.approval_date ASC`,
        [applicationId]
    );

    // Order info (if placed)
    const orderResult = await db.query(
        `SELECT order_id, order_status, order_date FROM "order" WHERE application_id = $1 LIMIT 1`,
        [applicationId]
    );

    const history      = historyResult.rows;
    const order        = orderResult.rows[0] || null;
    const managerEvent = history.find(h => h.approval_stage === 'manager');
    const financeEvent = history.find(h => h.approval_stage === 'finance');

    // Build stage-by-stage SLA breakdown
    const stages = [];

    // Stage 1: Manager Review
    const managerStart = app.submission_date;
    const managerEnd   = managerEvent?.approval_date || null;
    const managerDays  = managerEnd
        ? parseFloat(((new Date(managerEnd) - new Date(managerStart)) / 86400000).toFixed(1))
        : parseFloat(((Date.now() - new Date(managerStart)) / 86400000).toFixed(1));

    stages.push({
        stage:        'Manager Review',
        status:       managerEvent ? managerEvent.approval_status : 'Pending',
        started_at:   managerStart,
        completed_at: managerEnd,
        days_taken:   managerDays,
        sla_days:     SLA.Pending.sla_days,
        sla_status:   slaStatus(managerDays, SLA.Pending.sla_days, SLA.Pending.warning_threshold, !!managerEnd),
        approver:     managerEvent ? `${managerEvent.approver_first_name} ${managerEvent.approver_last_name}` : null,
        notes:        managerEvent?.notes || null,
    });

    // Stage 2: Finance Review (only if it reached this stage)
    if (managerEvent?.approval_status === 'Approved') {
        const financeStart = managerEvent.approval_date;
        const financeEnd   = financeEvent?.approval_date || null;
        const financeDays  = financeEnd
            ? parseFloat(((new Date(financeEnd) - new Date(financeStart)) / 86400000).toFixed(1))
            : parseFloat(((Date.now() - new Date(financeStart)) / 86400000).toFixed(1));

        stages.push({
            stage:        'Finance Review',
            status:       financeEvent ? financeEvent.approval_status : 'Pending',
            started_at:   financeStart,
            completed_at: financeEnd,
            days_taken:   financeDays,
            sla_days:     SLA.Pending_Finance.sla_days,
            sla_status:   slaStatus(financeDays, SLA.Pending_Finance.sla_days, SLA.Pending_Finance.warning_threshold, !!financeEnd),
            approver:     financeEvent ? `${financeEvent.approver_first_name} ${financeEvent.approver_last_name}` : null,
            notes:        financeEvent?.notes || null,
        });
    }

    // Stage 3: Order Placement (only if fully approved)
    if (financeEvent?.approval_status === 'Approved') {
        const orderStart = financeEvent.approval_date;
        const orderEnd   = order?.order_date || null;
        const orderDays  = orderEnd
            ? parseFloat(((new Date(orderEnd) - new Date(orderStart)) / 86400000).toFixed(1))
            : parseFloat(((Date.now() - new Date(orderStart)) / 86400000).toFixed(1));

        stages.push({
            stage:        'Order Placement',
            status:       order ? order.order_status : 'Awaiting',
            started_at:   orderStart,
            completed_at: orderEnd,
            days_taken:   orderDays,
            sla_days:     SLA.Approved.sla_days,
            sla_status:   slaStatus(orderDays, SLA.Approved.sla_days, SLA.Approved.warning_threshold, !!order),
            order_id:     order?.order_id || null,
        });
    }

    const totalDays = parseFloat(
        ((Date.now() - new Date(app.submission_date)) / 86400000).toFixed(1)
    );

    return { application: app, stages, total_days: totalDays, order };
}

function slaStatus(days, sla_days, warning_threshold, isCompleted) {
    if (isCompleted) {
        return days > sla_days ? 'breached' : 'met';
    }
    if (days > sla_days)             return 'breached';
    if (days > sla_days * warning_threshold) return 'approaching';
    return 'within';
}

module.exports = { getSlaDashboard, getSlaApplications, getApplicationSlaDetail, buildSlaCte };
