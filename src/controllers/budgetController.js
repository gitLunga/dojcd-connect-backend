const budgetService = require('../services/budgetService');

function ok(res, data)        { return res.json({ success: true, data, timestamp: new Date().toISOString() }); }
function fail(res, msg, s=500){ return res.status(s).json({ success: false, message: msg, data: null }); }

class BudgetController {

    async list(req, res) {
        try { return ok(res, await budgetService.listBudgets(req.query)); }
        catch (err) { return fail(res, err.message); }
    }

    async upsert(req, res) {
        try {
            const { department_id, fiscal_year, monthly_ceiling, notes } = req.body;
            if (!department_id || !fiscal_year || !monthly_ceiling) {
                return fail(res, 'department_id, fiscal_year, and monthly_ceiling are required.', 400);
            }
            const data = await budgetService.upsertBudget({
                departmentId:   department_id,
                fiscalYear:     parseInt(fiscal_year),
                monthlyCeiling: parseFloat(monthly_ceiling),
                notes,
                createdBy:      req.user.userId,
            });
            return ok(res, data);
        } catch (err) { return fail(res, err.message); }
    }

    async remove(req, res) {
        try {
            await budgetService.deleteBudget(parseInt(req.params.id), req.user.userId);
            return ok(res, { message: 'Budget record deleted.' });
        } catch (err) { return fail(res, err.message, err.message.includes('not found') ? 404 : 500); }
    }

    async spend(req, res) {
        try { return ok(res, await budgetService.getBudgetVsSpend(req.query.fiscal_year)); }
        catch (err) { return fail(res, err.message); }
    }
}

module.exports = new BudgetController();
