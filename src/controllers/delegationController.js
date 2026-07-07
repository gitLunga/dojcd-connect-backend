const delegationService = require('../services/delegationService');

function ok(res, data)        { return res.json({ success: true, data, timestamp: new Date().toISOString() }); }
function fail(res, msg, s=500){ return res.status(s).json({ success: false, message: msg, data: null }); }

class DelegationController {

    async list(req, res) {
        try {
            const data = await delegationService.listDelegations(req.query, req.user);
            return ok(res, data);
        } catch (err) { return fail(res, err.message); }
    }

    async create(req, res) {
        try {
            const { delegate_id, start_date, end_date, reason } = req.body;
            if (!delegate_id || !start_date || !end_date) {
                return fail(res, 'delegate_id, start_date, and end_date are required.', 400);
            }
            const data = await delegationService.createDelegation({
                delegatorId: req.user.userId,
                delegateId:  parseInt(delegate_id),
                startDate:   start_date,
                endDate:     end_date,
                reason,
            });
            return res.status(201).json({ success: true, data });
        } catch (err) { return fail(res, err.message); }
    }

    async revoke(req, res) {
        try {
            await delegationService.revokeDelegation(parseInt(req.params.id), req.user.userId);
            return ok(res, { message: 'Delegation revoked.' });
        } catch (err) { return fail(res, err.message, err.message.includes('not found') ? 404 : 400); }
    }

    async eligibleDelegates(req, res) {
        try {
            const data = await delegationService.getEligibleDelegates(req.user.userId);
            return ok(res, data);
        } catch (err) { return fail(res, err.message); }
    }

    async myDelegation(req, res) {
        try {
            const data = await delegationService.getActiveDelegation(req.user.userId);
            return ok(res, data);
        } catch (err) { return fail(res, err.message); }
    }
}

module.exports = new DelegationController();
