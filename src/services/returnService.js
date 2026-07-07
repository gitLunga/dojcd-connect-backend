const db           = require('../config/db');
const auditService = require('./auditService');

const VALID_STATUSES = ['Requested', 'Approved', 'Collected', 'Assessed', 'Completed', 'Cancelled'];
const VALID_GRADES   = ['A', 'B', 'C', 'D'];

// GET /api/returns  — paginated list with filters
async function listReturns(filters = {}) {
    const conditions = ['1=1'];
    const params     = [];
    let idx = 1;

    if (filters.status)        { conditions.push(`dr.return_status = $${idx++}`);      params.push(filters.status); }
    if (filters.department_id) { conditions.push(`cu.department_id = $${idx++}`);      params.push(filters.department_id); }
    if (filters.region)        { conditions.push(`cu.region = $${idx++}`);             params.push(filters.region); }
    if (filters.date_from)     { conditions.push(`dr.initiated_at >= $${idx++}`);      params.push(filters.date_from); }
    if (filters.date_to)       { conditions.push(`dr.initiated_at <= $${idx++}`);      params.push(filters.date_to); }

    const limit  = Math.min(parseInt(filters.limit  || 50), 200);
    const offset = parseInt(filters.offset || 0);
    const where  = conditions.join(' AND ');

    const [data, count] = await Promise.all([
        db.query(
            `SELECT
                 dr.return_id, dr.return_status, dr.return_reason,
                 dr.condition_grade, dr.condition_notes,
                 dr.initiated_at, dr.collected_at, dr.completed_at,
                 cu.first_name, cu.last_name, cu.email,
                 cu.department_id, cu.region, cu.persal_id,
                 d.device_name, d.model, d.manufacturer,
                 c.contract_id, c.imei,
                 ou.first_name AS initiated_by_first, ou.last_name AS initiated_by_last
             FROM device_return dr
             JOIN client_user       cu ON dr.client_user_id = cu.client_user_id
             JOIN contract          c  ON dr.contract_id    = c.contract_id
             JOIN device_catalog    d  ON c.device_id       = d.device_id
             JOIN operational_user  ou ON dr.initiated_by   = ou.op_user_id
             WHERE ${where}
             ORDER BY dr.initiated_at DESC
             LIMIT $${idx} OFFSET $${idx + 1}`,
            [...params, limit, offset]
        ),
        db.query(
            `SELECT COUNT(*) FROM device_return dr
             JOIN client_user cu ON dr.client_user_id = cu.client_user_id
             WHERE ${where}`,
            params
        ),
    ]);

    return { returns: data.rows, total: parseInt(count.rows[0].count), limit, offset };
}

// GET /api/returns/:id
async function getReturn(returnId) {
    const result = await db.query(
        `SELECT
             dr.*,
             cu.first_name, cu.last_name, cu.email, cu.phone_number,
             cu.department_id, cu.region, cu.persal_id, cu.user_type,
             d.device_name, d.model, d.manufacturer, d.plan_name, d.monthly_cost,
             c.imei, c.sim_number, c.activation_date,
             ou.first_name AS initiated_by_first, ou.last_name AS initiated_by_last,
             ou.user_role  AS initiated_by_role
         FROM device_return dr
         JOIN client_user       cu ON dr.client_user_id = cu.client_user_id
         JOIN contract          c  ON dr.contract_id    = c.contract_id
         JOIN device_catalog    d  ON c.device_id       = d.device_id
         JOIN operational_user  ou ON dr.initiated_by   = ou.op_user_id
         WHERE dr.return_id = $1`,
        [returnId]
    );
    if (!result.rows.length) throw new Error('Return not found.');
    return result.rows[0];
}

// POST /api/returns  — initiate a return request
async function initiateReturn({ contractId, returnReason, initiatedBy }) {
    // Check no active return already exists for this contract
    const existing = await db.query(
        `SELECT return_id FROM device_return
         WHERE contract_id = $1 AND return_status NOT IN ('Completed','Cancelled')`,
        [contractId]
    );
    if (existing.rows.length) throw new Error('An active return already exists for this contract.');

    const contractCheck = await db.query(
        `SELECT c.contract_id, c.device_id, a.client_user_id
         FROM contract c
         JOIN "order"     o ON c.order_id      = o.order_id
         JOIN application a ON o.application_id = a.application_id
         WHERE c.contract_id = $1`,
        [contractId]
    );
    if (!contractCheck.rows.length) throw new Error('Contract not found.');

    const { client_user_id } = contractCheck.rows[0];

    const client = await db.connect();
    try {
        await client.query('BEGIN');

        const ins = await client.query(
            `INSERT INTO device_return (contract_id, client_user_id, initiated_by, return_reason)
             VALUES ($1, $2, $3, $4) RETURNING *`,
            [contractId, client_user_id, initiatedBy, returnReason]
        );

        await auditService.log(client, {
            actorId:    initiatedBy,
            actorType:  'operational_user',
            action:     'RETURN_INITIATED',
            entityType: 'device_return',
            entityId:   ins.rows[0].return_id,
            newValue:   { contract_id: contractId, reason: returnReason },
        });

        await client.query('COMMIT');
        return ins.rows[0];
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}

// PATCH /api/returns/:id/status  — advance status + optional condition grading
async function updateReturnStatus({ returnId, newStatus, conditionGrade, conditionNotes, actorId }) {
    if (!VALID_STATUSES.includes(newStatus)) throw new Error(`Invalid status: ${newStatus}`);
    if (conditionGrade && !VALID_GRADES.includes(conditionGrade)) throw new Error(`Invalid grade: ${conditionGrade}`);

    const existing = await db.query('SELECT * FROM device_return WHERE return_id = $1', [returnId]);
    if (!existing.rows.length) throw new Error('Return not found.');

    const current = existing.rows[0];
    if (['Completed', 'Cancelled'].includes(current.return_status)) {
        throw new Error(`Cannot update a ${current.return_status} return.`);
    }

    const now = new Date();
    const collectedAt  = newStatus === 'Collected'  ? now : current.collected_at;
    const completedAt  = newStatus === 'Completed'  ? now : current.completed_at;

    const dbClient = await db.connect();
    try {
        await dbClient.query('BEGIN');

        const upd = await dbClient.query(
            `UPDATE device_return SET
                 return_status   = $1,
                 condition_grade = COALESCE($2, condition_grade),
                 condition_notes = COALESCE($3, condition_notes),
                 collected_at    = $4,
                 completed_at    = $5
             WHERE return_id = $6 RETURNING *`,
            [newStatus, conditionGrade || null, conditionNotes || null, collectedAt, completedAt, returnId]
        );

        // When completed, restore stock
        if (newStatus === 'Completed') {
            await dbClient.query(
                `UPDATE device_catalog SET stock_quantity = stock_quantity + 1
                 WHERE device_id = (SELECT device_id FROM contract WHERE contract_id = $1)`,
                [current.contract_id]
            );
        }

        await auditService.log(dbClient, {
            actorId:    actorId,
            actorType:  'operational_user',
            action:     `RETURN_STATUS_CHANGED`,
            entityType: 'device_return',
            entityId:   returnId,
            oldValue:   { status: current.return_status },
            newValue:   { status: newStatus, grade: conditionGrade },
        });

        await dbClient.query('COMMIT');
        return upd.rows[0];
    } catch (err) {
        await dbClient.query('ROLLBACK');
        throw err;
    } finally {
        dbClient.release();
    }
}

// GET /api/returns/summary
async function getReturnSummary() {
    const result = await db.query(
        `SELECT
             return_status,
             COUNT(*) AS total,
             COUNT(*) FILTER (WHERE completed_at IS NOT NULL)  AS completed_count
         FROM device_return
         GROUP BY return_status
         ORDER BY return_status`
    );
    return result.rows;
}

module.exports = { listReturns, getReturn, initiateReturn, updateReturnStatus, getReturnSummary };
