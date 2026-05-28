const db           = require('../config/db');
const emailService = require('./emailService');

// ── Contract queries ──────────────────────────────────────────────────────────

async function getContracts(filters = {}) {
    const conditions = ['cu.contract_end_date IS NOT NULL'];
    const params     = [];
    let   idx        = 1;

    if (filters.status === 'active')    { conditions.push(`cu.contract_end_date >= NOW()`); }
    if (filters.status === 'expired')   { conditions.push(`cu.contract_end_date < NOW()`); }
    if (filters.region)                 { conditions.push(`cu.region = $${idx++}`);  params.push(filters.region); }
    if (filters.department_id)          { conditions.push(`cu.department_id = $${idx++}`); params.push(filters.department_id); }
    if (filters.network_provider)       { conditions.push(`cu.network_provider = $${idx++}`); params.push(filters.network_provider); }

    const limit  = Math.min(parseInt(filters.limit  || 50), 200);
    const offset = parseInt(filters.offset || 0);

    const [dataResult, countResult] = await Promise.all([
        db.query(`
            SELECT
                cu.client_user_id,
                cu.first_name,
                cu.last_name,
                cu.email,
                cu.phone_number,
                cu.region,
                cu.department_id,
                cu.persal_id,
                cu.user_type,
                cu.network_provider,
                cu.contract_duration_months,
                cu.contract_end_date,
                c.contract_id,
                c.imei,
                c.sim_number,
                c.billing_plan_ref,
                c.activation_date,
                c.mtn_contract_ref,
                d.device_name,
                d.model,
                d.manufacturer,
                d.plan_name,
                d.monthly_cost,
                o.order_id,
                o.order_status,
                o.order_date,
                CASE
                    WHEN cu.contract_end_date < NOW()                               THEN 'expired'
                    WHEN cu.contract_end_date < NOW() + INTERVAL '30 days'         THEN 'expiring_30'
                    WHEN cu.contract_end_date < NOW() + INTERVAL '60 days'         THEN 'expiring_60'
                    WHEN cu.contract_end_date < NOW() + INTERVAL '90 days'         THEN 'expiring_90'
                    ELSE 'active'
                END                                                                  AS contract_status,
                (cu.contract_end_date::date - CURRENT_DATE)                          AS days_until_expiry
            FROM client_user cu
            LEFT JOIN application a  ON a.client_user_id = cu.client_user_id
                AND a.application_status = 'Approved'
            LEFT JOIN "order"     o  ON o.application_id = a.application_id
                AND o.order_status = 'Delivered'
            LEFT JOIN contract    c  ON c.order_id = o.order_id
            LEFT JOIN device_catalog d ON d.device_id = c.device_id
            WHERE ${conditions.join(' AND ')}
            ORDER BY cu.contract_end_date ASC
            LIMIT $${idx} OFFSET $${idx + 1}
        `, [...params, limit, offset]),
        db.query(
            `SELECT COUNT(*) FROM client_user cu WHERE ${conditions.join(' AND ')}`,
            params
        ),
    ]);

    return {
        contracts: dataResult.rows,
        total:     parseInt(countResult.rows[0].count),
        limit,
        offset,
    };
}

async function getExpiringContracts(days = 30, filters = {}) {
    return getContracts({ ...filters, status: null,
        _expiry_clause: true, _days: days });
}

// Single targeted query for expiring-in-N-days
async function getExpiringWithinDays(days, filters = {}) {
    const conditions = [
        `cu.contract_end_date >= NOW()`,
        `cu.contract_end_date < NOW() + INTERVAL '${parseInt(days)} days'`,
    ];
    const params = [];
    let   idx    = 1;

    if (filters.region)       { conditions.push(`cu.region = $${idx++}`);       params.push(filters.region); }
    if (filters.department_id){ conditions.push(`cu.department_id = $${idx++}`); params.push(filters.department_id); }

    const limit  = Math.min(parseInt(filters.limit || 50), 200);
    const offset = parseInt(filters.offset || 0);

    const result = await db.query(`
        SELECT
            cu.client_user_id,
            cu.first_name,
            cu.last_name,
            cu.email,
            cu.phone_number,
            cu.region,
            cu.department_id,
            cu.network_provider,
            cu.contract_end_date,
            (cu.contract_end_date::date - CURRENT_DATE) AS days_until_expiry,
            c.contract_id,
            c.imei,
            c.mtn_contract_ref,
            d.device_name,
            d.plan_name,
            d.monthly_cost
        FROM client_user cu
        LEFT JOIN application a  ON a.client_user_id = cu.client_user_id AND a.application_status = 'Approved'
        LEFT JOIN "order"     o  ON o.application_id = a.application_id AND o.order_status = 'Delivered'
        LEFT JOIN contract    c  ON c.order_id = o.order_id
        LEFT JOIN device_catalog d ON d.device_id = c.device_id
        WHERE ${conditions.join(' AND ')}
        ORDER BY cu.contract_end_date ASC
        LIMIT $${idx} OFFSET $${idx + 1}
    `, [...params, limit, offset]);

    return result.rows;
}

async function getContractSummary() {
    const result = await db.query(`
        SELECT
            COUNT(*)                                                                                AS total_contracts,
            COUNT(*) FILTER (WHERE cu.contract_end_date >= NOW())                                  AS active,
            COUNT(*) FILTER (WHERE cu.contract_end_date < NOW())                                   AS expired,
            COUNT(*) FILTER (WHERE cu.contract_end_date BETWEEN NOW() AND NOW() + INTERVAL '30 days') AS expiring_30_days,
            COUNT(*) FILTER (WHERE cu.contract_end_date BETWEEN NOW() AND NOW() + INTERVAL '60 days') AS expiring_60_days,
            COUNT(*) FILTER (WHERE cu.contract_end_date BETWEEN NOW() AND NOW() + INTERVAL '90 days') AS expiring_90_days,
            COUNT(*) FILTER (WHERE cu.contract_end_date IS NULL)                                   AS no_contract
        FROM client_user cu
    `);
    return result.rows[0];
}

// Sends reminder emails to all users whose contract expires within `days`.
// Called manually by admin or by a scheduled job.
async function sendExpiryReminders(days = 30) {
    const expiring = await getExpiringWithinDays(days);
    let sent = 0;

    for (const user of expiring) {
        try {
            await emailService.send(
                user.email,
                `Your DOJCD device contract expires in ${user.days_until_expiry} day(s)`,
                `<p>Dear ${user.first_name},</p>
                 <p>Your device contract for <strong>${user.device_name || 'your device'}</strong> (${user.plan_name || ''}) expires on <strong>${new Date(user.contract_end_date).toLocaleDateString('en-ZA')}</strong> — that is ${user.days_until_expiry} day(s) from today.</p>
                 <p>Please contact your department administrator to discuss renewal or device return.</p>`
            );
            sent++;
        } catch (_) {}
    }

    return { total_expiring: expiring.length, reminders_sent: sent };
}

module.exports = {
    getContracts,
    getExpiringWithinDays,
    getContractSummary,
    sendExpiryReminders,
};
