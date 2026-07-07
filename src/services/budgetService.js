const db           = require('../config/db');
const auditService = require('./auditService');

// ── Helpers ───────────────────────────────────────────────────────────────────

function currentFiscalYear() {
    // SA government fiscal year runs Apr–Mar; use calendar year as default
    return new Date().getFullYear();
}

// ── Budget CRUD ───────────────────────────────────────────────────────────────

async function listBudgets(filters = {}) {
    const conditions = ['1=1'];
    const params     = [];
    let idx = 1;

    if (filters.department_id) { conditions.push(`db.department_id = $${idx++}`); params.push(filters.department_id); }
    if (filters.fiscal_year)   { conditions.push(`db.fiscal_year   = $${idx++}`); params.push(parseInt(filters.fiscal_year)); }

    const result = await db.query(
        `SELECT
             db.budget_id, db.department_id, db.fiscal_year,
             db.monthly_ceiling, db.monthly_ceiling * 12 AS annual_ceiling,
             db.notes, db.created_at, db.updated_at,
             ou.first_name AS created_by_first, ou.last_name AS created_by_last
         FROM department_budget db
         JOIN operational_user ou ON db.created_by = ou.op_user_id
         WHERE ${conditions.join(' AND ')}
         ORDER BY db.fiscal_year DESC, db.department_id`,
        params
    );
    return result.rows;
}

async function upsertBudget({ departmentId, fiscalYear, monthlyCeiling, notes, createdBy }) {
    const client = await db.connect();
    try {
        await client.query('BEGIN');

        const result = await client.query(
            `INSERT INTO department_budget (department_id, fiscal_year, monthly_ceiling, notes, created_by)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (department_id, fiscal_year)
             DO UPDATE SET
                 monthly_ceiling = EXCLUDED.monthly_ceiling,
                 notes           = EXCLUDED.notes,
                 updated_at      = NOW()
             RETURNING *`,
            [departmentId, fiscalYear, monthlyCeiling, notes || null, createdBy]
        );

        await auditService.log(client, {
            actorId:    createdBy,
            actorType:  'operational_user',
            action:     'BUDGET_UPSERTED',
            entityType: 'department_budget',
            entityId:   result.rows[0].budget_id,
            newValue:   { department_id: departmentId, fiscal_year: fiscalYear, monthly_ceiling: monthlyCeiling },
        });

        await client.query('COMMIT');
        return result.rows[0];
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}

async function deleteBudget(budgetId, actorId) {
    const existing = await db.query('SELECT * FROM department_budget WHERE budget_id = $1', [budgetId]);
    if (!existing.rows.length) throw new Error('Budget record not found.');

    const client = await db.connect();
    try {
        await client.query('BEGIN');
        await client.query('DELETE FROM department_budget WHERE budget_id = $1', [budgetId]);
        await auditService.log(client, {
            actorId,
            actorType:  'operational_user',
            action:     'BUDGET_DELETED',
            entityType: 'department_budget',
            entityId:   budgetId,
            oldValue:   existing.rows[0],
        });
        await client.query('COMMIT');
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}

// ── Spend tracking ────────────────────────────────────────────────────────────
// Computes actual monthly spend per department from live contracts and
// compares against budget ceilings for the given fiscal year.

async function getBudgetVsSpend(fiscalYear) {
    const year = fiscalYear ? parseInt(fiscalYear) : currentFiscalYear();

    // Actual monthly spend: sum of monthly_cost from active contracts per dept
    const spendResult = await db.query(
        `SELECT
             cu.department_id,
             COUNT(DISTINCT c.contract_id)     AS active_contracts,
             SUM(d.monthly_cost)               AS monthly_spend,
             SUM(d.monthly_cost * 12)          AS projected_annual_spend
         FROM contract c
         JOIN "order"        o  ON c.order_id       = o.order_id
         JOIN application    a  ON o.application_id = a.application_id
         JOIN client_user    cu ON a.client_user_id = cu.client_user_id
         JOIN device_catalog d  ON c.device_id      = d.device_id
         WHERE cu.contract_end_date > NOW()
           AND cu.department_id IS NOT NULL
         GROUP BY cu.department_id
         ORDER BY monthly_spend DESC`
    );

    // Budget ceilings for this fiscal year
    const budgetResult = await db.query(
        `SELECT department_id, monthly_ceiling, monthly_ceiling * 12 AS annual_ceiling
         FROM department_budget
         WHERE fiscal_year = $1`,
        [year]
    );

    const budgets = Object.fromEntries(
        budgetResult.rows.map(b => [b.department_id, b])
    );

    const rows = spendResult.rows.map(s => {
        const budget = budgets[s.department_id];
        const ceiling = budget ? parseFloat(budget.monthly_ceiling) : null;
        const spend   = parseFloat(s.monthly_spend || 0);
        return {
            department_id:          s.department_id,
            active_contracts:       parseInt(s.active_contracts),
            monthly_spend:          spend,
            projected_annual_spend: parseFloat(s.projected_annual_spend || 0),
            monthly_ceiling:        ceiling,
            annual_ceiling:         ceiling ? ceiling * 12 : null,
            utilisation_pct:        ceiling ? Math.round((spend / ceiling) * 100) : null,
            status:                 ceiling == null
                                        ? 'no_budget'
                                        : spend > ceiling
                                        ? 'over'
                                        : spend > ceiling * 0.85
                                        ? 'warning'
                                        : 'ok',
        };
    });

    // Also include departments with a budget but zero active contracts
    budgetResult.rows.forEach(b => {
        if (!rows.find(r => r.department_id === b.department_id)) {
            rows.push({
                department_id:          b.department_id,
                active_contracts:       0,
                monthly_spend:          0,
                projected_annual_spend: 0,
                monthly_ceiling:        parseFloat(b.monthly_ceiling),
                annual_ceiling:         parseFloat(b.monthly_ceiling) * 12,
                utilisation_pct:        0,
                status:                 'ok',
            });
        }
    });

    const overCount    = rows.filter(r => r.status === 'over').length;
    const warningCount = rows.filter(r => r.status === 'warning').length;

    return { fiscal_year: year, departments: rows, over_budget: overCount, near_limit: warningCount };
}

module.exports = { listBudgets, upsertBudget, deleteBudget, getBudgetVsSpend };
