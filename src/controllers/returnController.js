const returnService = require('../services/returnService');

function ok(res, data)        { return res.json({ success: true, data, timestamp: new Date().toISOString() }); }
function fail(res, msg, s=500){ return res.status(s).json({ success: false, message: msg, data: null }); }
// Errors thrown by returnService carry the HTTP status to answer with (400/404/409); anything else is a 500.
function failErr(res, err){ return fail(res, err.message, err.status || 500); }
// Client routes never show raw JavaScript / PostgreSQL error text.
function failClient(res, err){
    if (err.status) return fail(res, err.message, err.status);
    console.error('returns (client) error:', err);
    return fail(res, 'Something went wrong. Please try again.', 500);
}
// A real positive 32-bit integer from a number or numeric string, else null (parseInt would accept '1abc').
function toId(v){
    if (typeof v !== 'number' && typeof v !== 'string') return null;
    if (typeof v === 'string' && !/^\d{1,10}$/.test(v.trim())) return null;
    const n = Number(v);
    return Number.isInteger(n) && n > 0 && n <= 2147483647 ? n : null;
}

class ReturnController {

    async list(req, res) {
        try { return ok(res, await returnService.listReturns(req.query)); }
        catch (err) { return fail(res, err.message); }
    }

    async getOne(req, res) {
        try {
            const returnId = toId(req.params.id);
            if (!returnId) return fail(res, 'Return not found.', 404);
            return ok(res, await returnService.getReturn(returnId));
        }
        catch (err) { return fail(res, err.message, err.message.includes('not found') ? 404 : 500); }
    }

    async initiate(req, res) {
        try {
            const { contract_id, return_reason } = req.body;
            if (!contract_id || !return_reason) return fail(res, 'contract_id and return_reason are required.', 400);
            const contractId = toId(contract_id);
            if (!contractId) return fail(res, 'contract_id must be a positive whole number.', 400);
            const result = await returnService.initiateReturn({
                contractId,
                returnReason: return_reason,
                initiatedBy:  req.user.userId,
            });
            return res.status(201).json({ success: true, data: result });
        } catch (err) { return failErr(res, err); }
    }

    async updateStatus(req, res) {
        try {
            const { status, condition_grade, condition_notes } = req.body;
            if (!status) return fail(res, 'status is required.', 400);
            const returnId = toId(req.params.id);
            if (!returnId) return fail(res, 'Return not found.', 404);
            const result = await returnService.updateReturnStatus({
                returnId,
                newStatus:      status,
                conditionGrade: condition_grade,
                conditionNotes: condition_notes,
                actorId:        req.user.userId,
            });
            return ok(res, result);
        } catch (err) { return failErr(res, err); }
    }

    async summary(req, res) {
        try { return ok(res, await returnService.getReturnSummary()); }
        catch (err) { return fail(res, err.message); }
    }

    // ── Client self-service (req.user.userId is the client_user_id from the JWT) ──

    async myContracts(req, res) {
        try { return ok(res, { contracts: await returnService.listMyContracts(req.user.userId) }); }
        catch (err) { return failClient(res, err); }
    }

    async myReturns(req, res) {
        try { return ok(res, { returns: await returnService.listMyReturns(req.user.userId) }); }
        catch (err) { return failClient(res, err); }
    }

    async requestMine(req, res) {
        try {
            const { contract_id, return_reason } = req.body || {};
            const contractId = toId(contract_id);
            if (!contractId) return fail(res, 'contract_id must be a positive whole number.', 400);
            if (typeof return_reason !== 'string') return fail(res, 'return_reason must be text.', 400);
            const result = await returnService.requestReturnAsClient({
                clientUserId: req.user.userId,
                contractId,
                returnReason: return_reason,
            });
            return res.status(201).json({ success: true, message: 'Return request submitted.', data: result });
        } catch (err) { return failClient(res, err); }
    }

    async cancelMine(req, res) {
        try {
            const returnId = toId(req.params.id);
            if (!returnId) return fail(res, 'Return not found.', 404);
            const result = await returnService.cancelOwnReturn({
                returnId,
                clientUserId: req.user.userId,
            });
            return ok(res, result);
        } catch (err) { return failClient(res, err); }
    }
}

module.exports = new ReturnController();
