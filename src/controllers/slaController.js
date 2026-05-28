const slaService = require('../services/slaService');

function ok(res, data) {
    return res.status(200).json({ success: true, data, timestamp: new Date().toISOString() });
}

function fail(res, message, status = 500) {
    return res.status(status).json({ success: false, message, data: null });
}

class SlaController {

    // GET /api/sla/dashboard
    async getDashboard(req, res) {
        try {
            const data = await slaService.getSlaDashboard();
            return ok(res, data);
        } catch (error) {
            console.error('SLA dashboard error:', error);
            return fail(res, error.message);
        }
    }

    // GET /api/sla/applications?sla_status=breached&application_status=Pending&region=...
    async getApplications(req, res) {
        try {
            const data = await slaService.getSlaApplications(req.query);
            return ok(res, data);
        } catch (error) {
            console.error('SLA applications error:', error);
            return fail(res, error.message);
        }
    }

    // GET /api/sla/breached
    async getBreached(req, res) {
        try {
            const data = await slaService.getSlaApplications({ ...req.query, sla_status: 'breached' });
            return ok(res, data);
        } catch (error) {
            console.error('SLA breached error:', error);
            return fail(res, error.message);
        }
    }

    // GET /api/sla/approaching
    async getApproaching(req, res) {
        try {
            const data = await slaService.getSlaApplications({ ...req.query, sla_status: 'approaching' });
            return ok(res, data);
        } catch (error) {
            console.error('SLA approaching error:', error);
            return fail(res, error.message);
        }
    }

    // GET /api/sla/applications/:id
    async getApplicationDetail(req, res) {
        try {
            const applicationId = parseInt(req.params.id);
            if (!applicationId) return fail(res, 'Application ID is required.', 400);
            const data = await slaService.getApplicationSlaDetail(applicationId);
            return ok(res, data);
        } catch (error) {
            const status = error.message.includes('not found') ? 404 : 500;
            return fail(res, error.message, status);
        }
    }
}

module.exports = new SlaController();
