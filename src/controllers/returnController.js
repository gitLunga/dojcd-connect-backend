const returnService = require('../services/returnService');

function ok(res, data)        { return res.json({ success: true, data, timestamp: new Date().toISOString() }); }
function fail(res, msg, s=500){ return res.status(s).json({ success: false, message: msg, data: null }); }

class ReturnController {

    async list(req, res) {
        try { return ok(res, await returnService.listReturns(req.query)); }
        catch (err) { return fail(res, err.message); }
    }

    async getOne(req, res) {
        try { return ok(res, await returnService.getReturn(parseInt(req.params.id))); }
        catch (err) { return fail(res, err.message, err.message.includes('not found') ? 404 : 500); }
    }

    async initiate(req, res) {
        try {
            const { contract_id, return_reason } = req.body;
            if (!contract_id || !return_reason) return fail(res, 'contract_id and return_reason are required.', 400);
            const result = await returnService.initiateReturn({
                contractId:   parseInt(contract_id),
                returnReason: return_reason,
                initiatedBy:  req.user.userId,
            });
            return res.status(201).json({ success: true, data: result });
        } catch (err) { return fail(res, err.message); }
    }

    async updateStatus(req, res) {
        try {
            const { status, condition_grade, condition_notes } = req.body;
            if (!status) return fail(res, 'status is required.', 400);
            const result = await returnService.updateReturnStatus({
                returnId:       parseInt(req.params.id),
                newStatus:      status,
                conditionGrade: condition_grade,
                conditionNotes: condition_notes,
                actorId:        req.user.userId,
            });
            return ok(res, result);
        } catch (err) { return fail(res, err.message); }
    }

    async summary(req, res) {
        try { return ok(res, await returnService.getReturnSummary()); }
        catch (err) { return fail(res, err.message); }
    }
}

module.exports = new ReturnController();
