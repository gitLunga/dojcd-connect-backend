const auditService = require('../services/auditService');

function ok(res, data) {
    return res.status(200).json({ success: true, data, timestamp: new Date().toISOString() });
}

function fail(res, message, status = 500) {
    return res.status(status).json({ success: false, message, data: null });
}

class AuditController {

    async getAuditLogs(req, res) {
        try {
            const result = await auditService.getAuditLogs(req.query);
            return ok(res, result);
        } catch (error) {
            console.error('getAuditLogs error:', error);
            return fail(res, error.message);
        }
    }

    async getLoginAttempts(req, res) {
        try {
            const result = await auditService.getLoginAttempts(req.query);
            return ok(res, result);
        } catch (error) {
            console.error('getLoginAttempts error:', error);
            return fail(res, error.message);
        }
    }
}

module.exports = new AuditController();
