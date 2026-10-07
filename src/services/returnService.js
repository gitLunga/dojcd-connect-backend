const db                  = require('../config/db');
const auditService        = require('./auditService');
const notificationService = require('./notificationService');

const VALID_STATUSES = ['Requested', 'Approved', 'Collected', 'Assessed', 'Completed', 'Cancelled'];
const VALID_GRADES   = ['A', 'B', 'C', 'D'];
const MAX_CLIENT_REQUESTS_PER_DAY = 5;

// Normal order of a return. Staff may skip ahead (as the admin screen allows) or cancel,
// but never move backwards.
const STATUS_ORDER = ['Requested', 'Approved', 'Collected', 'Assessed', 'Completed'];

// Error that carries the HTTP status the controller should answer with.
function httpError(status, message) {
    const err = new Error(message);
    err.status = status;
    return err;
}

// Free-text reason: a non-empty string of at most 1000 characters without NUL bytes.
function cleanReason(value) {
    if (typeof value !== 'string' || value.includes('\u0000')) throw httpError(400, 'return_reason must be text.');
    const reason = value.trim();
    if (reason.length < 5)    throw httpError(400, 'Please tell us why the device is being returned (at least 5 characters).');
    if (reason.length > 1000) throw httpError(400, 'The reason is too long (1000 characters maximum).');
    return reason;
}

// A device is "in the client's hands" when the application is Approved, the order is Delivered
// and a contract row exists (same definition as adminService / contractService).
const ACTIVE_CONTRACT_JOINS = `
    FROM contract c
    JOIN "order"        o ON c.order_id       = o.order_id
    JOIN application    a ON o.application_id = a.application_id
    JOIN device_catalog d ON c.device_id      = d.device_id
    JOIN client_user   cu ON a.client_user_id = cu.client_user_id`;
const ACTIVE_CONTRACT_WHERE = `a.application_status = 'Approved' AND o.order_status = 'Delivered'`;

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
                 dr.initiated_by_type,
                 cu.first_name, cu.last_name, cu.email,
                 cu.department_id, cu.region, cu.persal_id,
                 d.device_name, d.model, d.manufacturer,
                 c.contract_id, c.imei,
                 ou.first_name AS initiated_by_first, ou.last_name AS initiated_by_last
             FROM device_return dr
             JOIN client_user       cu ON dr.client_user_id = cu.client_user_id
             JOIN contract          c  ON dr.contract_id    = c.contract_id
             JOIN device_catalog    d  ON c.device_id       = d.device_id
             LEFT JOIN operational_user ou ON dr.initiated_by = ou.op_user_id
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
         LEFT JOIN operational_user ou ON dr.initiated_by = ou.op_user_id
         WHERE dr.return_id = $1`,
        [returnId]
    );
    if (!result.rows.length) throw new Error('Return not found.');
    return result.rows[0];
}

// A contract can be returned once: refuse when a return for it is still running or already done.
async function assertNoOpenOrCompletedReturn(contractId) {
    const existing = await db.query(
        `SELECT return_status FROM device_return
         WHERE contract_id = $1 AND return_status <> 'Cancelled'
         LIMIT 1`,
        [contractId]
    );
    if (existing.rows.length) {
        throw httpError(409, existing.rows[0].return_status === 'Completed'
            ? 'This device has already been returned.'
            : 'An active return already exists for this contract.');
    }
}

// POST /api/returns  — staff initiate a return request
async function initiateReturn({ contractId, returnReason, initiatedBy }) {
    const reason = cleanReason(returnReason);
    await assertNoOpenOrCompletedReturn(contractId);

    const contractCheck = await db.query(
        `SELECT c.contract_id, c.device_id, a.client_user_id
         FROM contract c
         JOIN "order"     o ON c.order_id      = o.order_id
         JOIN application a ON o.application_id = a.application_id
         WHERE c.contract_id = $1`,
        [contractId]
    );
    if (!contractCheck.rows.length) throw httpError(404, 'Contract not found.');

    const { client_user_id } = contractCheck.rows[0];

    const client = await db.connect();
    let created;
    try {
        await client.query('BEGIN');

        const ins = await client.query(
            `INSERT INTO device_return (contract_id, client_user_id, initiated_by, initiated_by_type, return_reason, visible_to_client)
             VALUES ($1, $2, $3, 'Operational', $4, true) RETURNING *`,
            [contractId, client_user_id, initiatedBy, reason]
        );
        created = ins.rows[0];

        await auditService.log(client, {
            actorId:    initiatedBy,
            actorType:  'Operational',
            action:     'RETURN_INITIATED',
            entityType: 'device_return',
            entityId:   created.return_id,
            newValue:   { contract_id: contractId, reason },
        });

        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK');
        if (err.code === '23505') throw httpError(409, 'An active return already exists for this contract.');
        throw err;
    } finally {
        client.release();
    }

    // Let the client know the department has started a return for their device (non-fatal).
    await notificationService.createNotification(
        client_user_id, 'Client', 'Device Return Started',
        'The department has started a return for one of your devices. You can follow its progress under Returns.'
    ).catch(() => {});

    return created;
}

// PATCH /api/returns/:id/status  — advance status + optional condition grading
async function updateReturnStatus({ returnId, newStatus, conditionGrade, conditionNotes, actorId }) {
    if (!VALID_STATUSES.includes(newStatus)) throw httpError(400, `Invalid status: ${newStatus}`);
    if (conditionGrade && !VALID_GRADES.includes(conditionGrade)) throw httpError(400, `Invalid grade: ${conditionGrade}`);

    // Stamp the time a stage is reached; never overwrite a stamp that is already there.
    const now = new Date();

    const dbClient = await db.connect();
    let current, updated;
    try {
        await dbClient.query('BEGIN');

        // Lock the row first: a client may be cancelling it at the same moment.
        const existing = await dbClient.query('SELECT * FROM device_return WHERE return_id = $1 FOR UPDATE', [returnId]);
        if (!existing.rows.length) throw httpError(404, 'Return not found.');
        current = existing.rows[0];

        if (['Completed', 'Cancelled'].includes(current.return_status)) {
            throw httpError(409, `Cannot update a ${current.return_status} return.`);
        }
        if (newStatus !== 'Cancelled' && STATUS_ORDER.indexOf(newStatus) < STATUS_ORDER.indexOf(current.return_status)) {
            throw httpError(409, `A return cannot move back from ${current.return_status} to ${newStatus}.`);
        }

        const stamp = (stage, existingValue) => (newStatus === stage ? (existingValue || now) : existingValue);

        const upd = await dbClient.query(
            `UPDATE device_return SET
                 return_status   = $1,
                 condition_grade = COALESCE($2, condition_grade),
                 condition_notes = COALESCE($3, condition_notes),
                 approved_at     = $4,
                 collected_at    = $5,
                 assessed_at     = $6,
                 completed_at    = $7,
                 cancelled_at    = $8
             WHERE return_id = $9 RETURNING *`,
            [
                newStatus, conditionGrade || null, conditionNotes || null,
                stamp('Approved',  current.approved_at),
                stamp('Collected', current.collected_at),
                stamp('Assessed',  current.assessed_at),
                stamp('Completed', current.completed_at),
                stamp('Cancelled', current.cancelled_at),
                returnId,
            ]
        );
        updated = upd.rows[0];

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
            actorType:  'Operational',
            action:     `RETURN_STATUS_CHANGED`,
            entityType: 'device_return',
            entityId:   returnId,
            oldValue:   { status: current.return_status },
            newValue:   { status: newStatus, grade: conditionGrade },
        });

        await dbClient.query('COMMIT');
    } catch (err) {
        await dbClient.query('ROLLBACK');
        throw err;
    } finally {
        dbClient.release();
    }

    // Tell the client about the new stage (non-fatal, written after the commit).
    if (newStatus !== current.return_status) {
        // Grade and notes are only shared for returns that are visible to the client (created after migration 009).
        const grade = current.visible_to_client && updated.condition_grade ? ` (condition grade ${updated.condition_grade})` : '';
        const note  = current.visible_to_client && conditionNotes ? ` Note from the department: ${conditionNotes}` : '';
        const messages = {
            Approved:  'Your device return request has been approved. The department will arrange collection of your device.',
            Collected: 'Your device has been collected.',
            Assessed:  `Your returned device has been assessed${grade}.`,
            Completed: 'Your device return is complete. Thank you.',
            Cancelled: 'Your device return request has been cancelled.',
        };
        await notificationService.createNotification(
            current.client_user_id, 'Client', `Device Return ${newStatus}`,
            (messages[newStatus] || `Your device return is now ${newStatus}.`) + note
        ).catch(() => {});
    }

    return updated;
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

// ── Client self-service ───────────────────────────────────────────────────────

// Operational users who should hear about a client's return activity: every Admin, plus the
// Managers of the client's department (or Managers with global access).
async function notifyStaff(departmentId, title, message) {
    try {
        const staff = await db.query(
            `SELECT op_user_id FROM operational_user
             WHERE is_deleted = false
               AND (user_role = 'Admin'
                    OR (user_role = 'Manager' AND (department_id = $1 OR has_global_access = true)))`,
            [departmentId]
        );
        await Promise.all(staff.rows.map(s =>
            notificationService.createNotification(s.op_user_id, 'Operational', title, message).catch(() => {})
        ));
    } catch (err) {
        console.error('Could not notify staff about a return:', err.message);
    }
}

// GET /api/returns/my/contracts — the client's own devices and whether each can be returned
async function listMyContracts(clientUserId) {
    const result = await db.query(
        `SELECT c.contract_id, c.imei, c.sim_number, c.activation_date, c.mtn_contract_ref,
                d.device_name, d.model, d.manufacturer, d.plan_name, d.monthly_cost,
                d.contract_duration_months,
                lr.return_id, lr.return_status
         ${ACTIVE_CONTRACT_JOINS}
         LEFT JOIN LATERAL (
             SELECT return_id, return_status FROM device_return
             WHERE contract_id = c.contract_id AND return_status <> 'Cancelled'
             ORDER BY initiated_at DESC LIMIT 1
         ) lr ON TRUE
         WHERE a.client_user_id = $1 AND ${ACTIVE_CONTRACT_WHERE}
         ORDER BY c.activation_date DESC NULLS LAST, c.contract_id DESC`,
        [clientUserId]
    );
    return result.rows.map(r => ({ ...r, can_request_return: r.return_id === null }));
}

// GET /api/returns/my — the client's own return requests, newest first
async function listMyReturns(clientUserId) {
    const result = await db.query(
        `SELECT dr.return_id, dr.contract_id, dr.return_status, dr.return_reason,
                CASE WHEN dr.visible_to_client THEN dr.condition_grade END AS condition_grade,
                CASE WHEN dr.visible_to_client THEN dr.condition_notes END AS condition_notes,
                dr.initiated_by_type,
                dr.initiated_at, dr.approved_at, dr.collected_at, dr.assessed_at,
                dr.completed_at, dr.cancelled_at,
                d.device_name, d.model, d.manufacturer, c.imei
         FROM device_return dr
         JOIN contract       c ON dr.contract_id = c.contract_id
         JOIN device_catalog d ON c.device_id    = d.device_id
         WHERE dr.client_user_id = $1
         ORDER BY dr.initiated_at DESC, dr.return_id DESC`,
        [clientUserId]
    );
    return result.rows;
}

// POST /api/returns/my — a client asks to return their own device
async function requestReturnAsClient({ clientUserId, contractId, returnReason }) {
    if (!contractId) throw httpError(400, 'contract_id is required.');
    const reason = cleanReason(returnReason);

    // Ownership + eligibility in one query. Not found and not-yours look the same on purpose.
    const owned = await db.query(
        `SELECT c.contract_id, d.device_name, cu.first_name, cu.last_name, cu.department_id, cu.registration_status
         ${ACTIVE_CONTRACT_JOINS}
         WHERE c.contract_id = $1 AND a.client_user_id = $2 AND ${ACTIVE_CONTRACT_WHERE}`,
        [contractId, clientUserId]
    );
    if (!owned.rows.length) throw httpError(404, 'Contract not found.');
    const info = owned.rows[0];
    // A token issued before an account was deactivated stays valid for a few minutes.
    if (info.registration_status === 'Deactivated') throw httpError(403, 'This account has been deactivated.');

    // Stops one client flooding the department with request / cancel cycles.
    const recent = await db.query(
        `SELECT count(*)::int AS n FROM device_return
         WHERE client_user_id = $1 AND initiated_by_type = 'Client' AND initiated_at > NOW() - INTERVAL '24 hours'`,
        [clientUserId]
    );
    if (recent.rows[0].n >= MAX_CLIENT_REQUESTS_PER_DAY) {
        throw httpError(429, 'You have reached the limit of return requests for today. Please try again tomorrow or contact the department.');
    }

    await assertNoOpenOrCompletedReturn(contractId);

    const client = await db.connect();
    let created;
    try {
        await client.query('BEGIN');

        const ins = await client.query(
            `INSERT INTO device_return (contract_id, client_user_id, initiated_by, initiated_by_type, return_reason, visible_to_client)
             VALUES ($1, $2, NULL, 'Client', $3, true) RETURNING *`,
            [contractId, clientUserId, reason]
        );
        created = ins.rows[0];

        await auditService.log(client, {
            actorId:    clientUserId,
            actorType:  'Client',
            action:     'RETURN_REQUESTED',
            entityType: 'device_return',
            entityId:   created.return_id,
            newValue:   { contract_id: contractId, reason },
        });

        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK');
        // Two requests raced past the check above: the partial unique index caught the second one.
        if (err.code === '23505') throw httpError(409, 'An active return already exists for this contract.');
        throw err;
    } finally {
        client.release();
    }

    // Notifications are written after the commit and never fail the request.
    await notificationService.createNotification(
        clientUserId, 'Client', 'Return Request Received',
        `Your request to return the ${info.device_name} has been received. We will let you know when it is approved.`
    ).catch(() => {});
    await notifyStaff(
        info.department_id, 'New Device Return Request',
        `${info.first_name} ${info.last_name} has asked to return the ${info.device_name} (return #${created.return_id}).`
    );

    return created;
}

// PATCH /api/returns/my/:id/cancel — a client withdraws their own request, only while still 'Requested'
async function cancelOwnReturn({ returnId, clientUserId }) {
    const client = await db.connect();
    let cancelled, info;
    try {
        await client.query('BEGIN');

        const found = await client.query(
            `SELECT dr.*, d.device_name, cu.first_name, cu.last_name, cu.department_id
             FROM device_return dr
             JOIN contract       c  ON dr.contract_id    = c.contract_id
             JOIN device_catalog d  ON c.device_id       = d.device_id
             JOIN client_user    cu ON dr.client_user_id = cu.client_user_id
             WHERE dr.return_id = $1 AND dr.client_user_id = $2
             FOR UPDATE OF dr`,
            [returnId, clientUserId]
        );
        if (!found.rows.length) throw httpError(404, 'Return not found.');
        info = found.rows[0];

        if (info.return_status !== 'Requested') {
            throw httpError(409, info.return_status === 'Cancelled'
                ? 'This return request is already cancelled.'
                : `This request can no longer be cancelled because it is already ${info.return_status}. Please contact the department.`);
        }

        const upd = await client.query(
            `UPDATE device_return SET return_status = 'Cancelled', cancelled_at = NOW()
             WHERE return_id = $1 RETURNING *`,
            [returnId]
        );
        cancelled = upd.rows[0];

        await auditService.log(client, {
            actorId:    clientUserId,
            actorType:  'Client',
            action:     'RETURN_CANCELLED_BY_CLIENT',
            entityType: 'device_return',
            entityId:   returnId,
            oldValue:   { status: 'Requested' },
            newValue:   { status: 'Cancelled' },
        });

        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }

    await notifyStaff(
        info.department_id, 'Device Return Withdrawn',
        `${info.first_name} ${info.last_name} withdrew their request to return the ${info.device_name} (return #${returnId}).`
    );

    return cancelled;
}

module.exports = {
    listReturns, getReturn, initiateReturn, updateReturnStatus, getReturnSummary,
    listMyContracts, listMyReturns, requestReturnAsClient, cancelOwnReturn,
};
