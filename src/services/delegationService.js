const db           = require('../config/db');
const auditService = require('./auditService');

// Check if a given user currently has active delegation authority.
// Used by the approve/reject middleware to allow delegates to act.
async function getActiveDelegation(userId) {
    const result = await db.query(
        `SELECT ad.*, ou.first_name AS delegator_first, ou.last_name AS delegator_last,
                ou.user_role AS delegator_role
         FROM approval_delegation ad
         JOIN operational_user ou ON ad.delegator_id = ou.op_user_id
         WHERE ad.delegate_id = $1
           AND ad.is_active   = TRUE
           AND ad.start_date  <= NOW()
           AND ad.end_date    >= NOW()
         LIMIT 1`,
        [userId]
    );
    return result.rows[0] || null;
}

// GET /api/delegation — list all delegations (Admin) or own delegations (Manager)
async function listDelegations(filters = {}, requestingUser) {
    const conditions = ['1=1'];
    const params     = [];
    let idx = 1;

    if (requestingUser.role !== 'Admin') {
        conditions.push(`(ad.delegator_id = $${idx} OR ad.delegate_id = $${idx})`);
        params.push(requestingUser.userId);
        idx++;
    }
    if (filters.is_active != null) {
        conditions.push(`ad.is_active = $${idx++}`);
        params.push(filters.is_active === 'true' || filters.is_active === true);
    }

    const result = await db.query(
        `SELECT
             ad.*,
             dor.first_name AS delegator_first, dor.last_name AS delegator_last, dor.user_role AS delegator_role,
             dee.first_name AS delegate_first,  dee.last_name AS delegate_last,  dee.user_role AS delegate_role
         FROM approval_delegation ad
         JOIN operational_user dor ON ad.delegator_id = dor.op_user_id
         JOIN operational_user dee ON ad.delegate_id  = dee.op_user_id
         WHERE ${conditions.join(' AND ')}
         ORDER BY ad.created_at DESC`,
        params
    );
    return result.rows;
}

// POST /api/delegation — create a delegation
async function createDelegation({ delegatorId, delegateId, startDate, endDate, reason }) {
    if (delegatorId === delegateId) throw new Error('Cannot delegate to yourself.');

    // Check delegate exists and has appropriate role
    const delegateCheck = await db.query(
        `SELECT op_user_id, user_role FROM operational_user WHERE op_user_id = $1`,
        [delegateId]
    );
    if (!delegateCheck.rows.length) throw new Error('Delegate user not found.');

    const client = await db.connect();
    try {
        await client.query('BEGIN');

        const ins = await client.query(
            `INSERT INTO approval_delegation (delegator_id, delegate_id, start_date, end_date, reason)
             VALUES ($1, $2, $3, $4, $5) RETURNING *`,
            [delegatorId, delegateId, startDate, endDate, reason || null]
        );

        await auditService.log(client, {
            actorId:    delegatorId,
            actorType:  'operational_user',
            action:     'DELEGATION_CREATED',
            entityType: 'approval_delegation',
            entityId:   ins.rows[0].delegation_id,
            newValue:   { delegate_id: delegateId, start_date: startDate, end_date: endDate },
        });

        await client.query('COMMIT');
        return ins.rows[0];
    } catch (err) {
        await client.query('ROLLBACK');
        // Surface the unique violation cleanly
        if (err.code === '23505') throw new Error('You already have an active delegation. Revoke it before creating a new one.');
        throw err;
    } finally {
        client.release();
    }
}

// DELETE /api/delegation/:id — revoke (set is_active = false)
async function revokeDelegation(delegationId, actorId) {
    const existing = await db.query(
        'SELECT * FROM approval_delegation WHERE delegation_id = $1',
        [delegationId]
    );
    if (!existing.rows.length) throw new Error('Delegation not found.');

    const del = existing.rows[0];
    if (del.delegator_id !== actorId) throw new Error('Only the delegator can revoke this delegation.');

    const client = await db.connect();
    try {
        await client.query('BEGIN');

        await client.query(
            'UPDATE approval_delegation SET is_active = FALSE WHERE delegation_id = $1',
            [delegationId]
        );

        await auditService.log(client, {
            actorId:    actorId,
            actorType:  'operational_user',
            action:     'DELEGATION_REVOKED',
            entityType: 'approval_delegation',
            entityId:   delegationId,
        });

        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}

// GET /api/delegation/eligible-delegates — operational users who can receive delegation
async function getEligibleDelegates(excludeUserId) {
    const result = await db.query(
        `SELECT op_user_id, first_name, last_name, user_role, department_id
         FROM operational_user
         WHERE op_user_id <> $1
           AND user_role IN ('Manager', 'Approver', 'Finance', 'Admin')
           AND is_deleted = FALSE
         ORDER BY user_role, last_name`,
        [excludeUserId]
    );
    return result.rows;
}

module.exports = { getActiveDelegation, listDelegations, createDelegation, revokeDelegation, getEligibleDelegates };
