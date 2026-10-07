const db = require('../config/db');

// Write one audit entry using the SAME client that holds the business transaction.
// The record is committed or rolled back atomically with the operation it describes.
async function log(client, {
    actorId,
    actorType,
    action,
    entityType  = null,
    entityId    = null,
    oldValue    = null,
    newValue    = null,
}) {
    await client.query(
        `INSERT INTO audit_log
             (actor_id, actor_type, action, entity_type, entity_id, old_value, new_value)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
            actorId,
            actorType,
            action,
            entityType,
            entityId,
            oldValue  != null ? JSON.stringify(oldValue)  : null,
            newValue  != null ? JSON.stringify(newValue)  : null,
        ]
    );
}

// Record a login attempt (success or failure).
// Uses the pool directly — no business transaction needed.
async function logLoginAttempt(email, ipAddress, success) {
    try {
        await db.query(
            `INSERT INTO login_attempt (email, ip_address, success) VALUES ($1, $2, $3)`,
            [email, ipAddress || null, success]
        );
    } catch (err) {
        // Non-fatal — never let audit logging break the login flow
        console.error('Failed to record login attempt:', err.message);
    }
}

// ── Admin query API ───────────────────────────────────────────────────────────

async function getAuditLogs(filters = {}) {
    const conditions = ['1=1'];
    const params     = [];
    let idx = 1;

    // Columns are qualified with "al." because the data query below joins operational_user and
    // client_user, which also have a created_at column (an unqualified created_at was ambiguous).
    if (filters.actor_id)    { conditions.push(`al.actor_id = $${idx++}`);    params.push(parseInt(filters.actor_id)); }
    if (filters.actor_type)  {
        // The app writes actor_type in two spellings: 'Operational' / 'Client' / 'System' (most services)
        // and 'operational_user' / 'client_user' / 'system' (budget and delegation). Treat them as one.
        conditions.push(`lower(al.actor_type) IN ($${idx}, $${idx} || '_user')`);
        params.push(String(filters.actor_type).toLowerCase().replace(/_user$/, ''));
        idx++;
    }
    if (filters.action)      { conditions.push(`al.action ILIKE $${idx++}`);  params.push(`%${filters.action}%`); }
    if (filters.entity_type) { conditions.push(`al.entity_type = $${idx++}`); params.push(filters.entity_type); }
    if (filters.entity_id)   { conditions.push(`al.entity_id = $${idx++}`);   params.push(parseInt(filters.entity_id)); }
    if (filters.date_from)   { conditions.push(`al.created_at >= $${idx++}`); params.push(filters.date_from); }
    if (filters.date_to)     { conditions.push(`al.created_at <= $${idx++}`); params.push(filters.date_to); }

    const where  = conditions.join(' AND ');
    const limit  = Math.min(parseInt(filters.limit  || 100), 500);
    const offset = parseInt(filters.offset || 0);

    const [dataResult, countResult] = await Promise.all([
        db.query(
            `SELECT al.*,
                COALESCE(
                    CASE WHEN lower(al.actor_type) IN ('operational', 'operational_user') THEN ou.first_name || ' ' || ou.last_name END,
                    CASE WHEN lower(al.actor_type) IN ('client', 'client_user')            THEN cu.first_name || ' ' || cu.last_name END,
                    'System'
                ) AS actor_name
             FROM audit_log al
             LEFT JOIN operational_user ou ON lower(al.actor_type) IN ('operational', 'operational_user') AND al.actor_id = ou.op_user_id
             LEFT JOIN client_user      cu ON lower(al.actor_type) IN ('client', 'client_user')            AND al.actor_id = cu.client_user_id
             WHERE ${where}
             ORDER BY al.created_at DESC LIMIT $${idx} OFFSET $${idx + 1}`,
            [...params, limit, offset]
        ),
        db.query(`SELECT COUNT(*) FROM audit_log al WHERE ${where}`, params),
    ]);

    return {
        logs:   dataResult.rows,
        total:  parseInt(countResult.rows[0].count),
        limit,
        offset,
    };
}

async function getLoginAttempts(filters = {}) {
    const conditions = ['1=1'];
    const params     = [];
    let idx = 1;

    if (filters.email)     { conditions.push(`email = $${idx++}`);          params.push(filters.email); }
    if (filters.success != null) { conditions.push(`success = $${idx++}`);  params.push(filters.success === 'true' || filters.success === true); }
    if (filters.date_from) { conditions.push(`created_at >= $${idx++}`);    params.push(filters.date_from); }
    if (filters.date_to)   { conditions.push(`created_at <= $${idx++}`);    params.push(filters.date_to); }

    const where  = conditions.join(' AND ');
    const limit  = Math.min(parseInt(filters.limit || 100), 500);
    const offset = parseInt(filters.offset || 0);

    const [dataResult, countResult] = await Promise.all([
        db.query(
            `SELECT attempt_id, email, ip_address, success, created_at
             FROM login_attempt WHERE ${where}
             ORDER BY created_at DESC LIMIT $${idx} OFFSET $${idx + 1}`,
            [...params, limit, offset]
        ),
        db.query(`SELECT COUNT(*) FROM login_attempt WHERE ${where}`, params),
    ]);

    return {
        attempts: dataResult.rows,
        total:    parseInt(countResult.rows[0].count),
        limit,
        offset,
    };
}

module.exports = { log, logLoginAttempt, getAuditLogs, getLoginAttempts };
