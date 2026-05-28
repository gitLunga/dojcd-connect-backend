// SLA thresholds per workflow stage (calendar days).
// Override via environment variables — no redeploy needed to adjust SLAs.
const SLA = {
    Pending: {
        stage_name:        'Manager Review',
        sla_days:          parseInt(process.env.SLA_MANAGER_DAYS   || '3'),
        warning_threshold: parseFloat(process.env.SLA_WARNING_PCT  || '0.8'),
    },
    Pending_Finance: {
        stage_name:        'Finance Review',
        sla_days:          parseInt(process.env.SLA_FINANCE_DAYS   || '5'),
        warning_threshold: parseFloat(process.env.SLA_WARNING_PCT  || '0.8'),
    },
    Approved: {
        stage_name:        'Order Placement',
        sla_days:          parseInt(process.env.SLA_ORDER_DAYS     || '2'),
        warning_threshold: parseFloat(process.env.SLA_WARNING_PCT  || '0.8'),
    },
};

module.exports = SLA;
