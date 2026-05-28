const contractService = require('../services/contractService');

function ok(res, data)       { return res.json({ success: true, data, timestamp: new Date().toISOString() }); }
function fail(res, msg, s=500){ return res.status(s).json({ success: false, message: msg, data: null }); }

class ContractController {

    // GET /api/contracts?status=active|expired&region=&department_id=&limit=&offset=
    async list(req, res) {
        try {
            const data = await contractService.getContracts(req.query);
            return ok(res, data);
        } catch (err) { return fail(res, err.message); }
    }

    // GET /api/contracts/summary
    async summary(req, res) {
        try {
            const data = await contractService.getContractSummary();
            return ok(res, data);
        } catch (err) { return fail(res, err.message); }
    }

    // GET /api/contracts/expiring?days=30&region=&department_id=
    async expiring(req, res) {
        try {
            const days = parseInt(req.query.days || '30');
            if (![30, 60, 90].includes(days) && days > 0) {
                // allow any positive value but default hint is 30/60/90
            }
            const data = await contractService.getExpiringWithinDays(days, req.query);
            return ok(res, { contracts: data, days_window: days });
        } catch (err) { return fail(res, err.message); }
    }

    // POST /api/contracts/send-reminders?days=30
    async sendReminders(req, res) {
        try {
            const days = parseInt(req.query.days || '30');
            const result = await contractService.sendExpiryReminders(days);
            return ok(res, result);
        } catch (err) { return fail(res, err.message); }
    }
}

module.exports = new ContractController();
