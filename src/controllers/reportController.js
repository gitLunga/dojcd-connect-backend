const reportService = require('../services/reportService');
const { sendCSV }   = require('../utils/csvExport');

function fail(res, msg, status = 500) {
    return res.status(status).json({ success: false, message: msg, data: null });
}

class ReportController {

    // GET /api/reports/history
    async getHistory(req, res) {
        try {
            const data = await reportService.getReportHistory(req.query);
            return res.json({ success: true, data });
        } catch (err) {
            return fail(res, err.message);
        }
    }

    // POST /api/reports/applications        → JSON preview
    // GET  /api/reports/applications/export → CSV download
    async applicationsPreview(req, res) {
        try {
            const { rows, meta } = await reportService.generateApplicationsReport(req.query, req.user.userId);
            return res.json({ success: true, data: { rows, count: rows.length, report: meta } });
        } catch (err) { return fail(res, err.message); }
    }

    async applicationsExport(req, res) {
        try {
            const { csv } = await reportService.generateApplicationsReport(req.query, req.user.userId);
            sendCSV(res, `applications_${Date.now()}.csv`, csv);
        } catch (err) { return fail(res, err.message); }
    }

    // POST /api/reports/users
    // GET  /api/reports/users/export
    async usersPreview(req, res) {
        try {
            const { rows, meta } = await reportService.generateUsersReport(req.query, req.user.userId);
            return res.json({ success: true, data: { rows, count: rows.length, report: meta } });
        } catch (err) { return fail(res, err.message); }
    }

    async usersExport(req, res) {
        try {
            const { csv } = await reportService.generateUsersReport(req.query, req.user.userId);
            sendCSV(res, `users_${Date.now()}.csv`, csv);
        } catch (err) { return fail(res, err.message); }
    }

    // GET /api/reports/inventory
    // GET /api/reports/inventory/export
    async inventoryPreview(req, res) {
        try {
            const { rows, meta } = await reportService.generateInventoryReport(req.user.userId);
            return res.json({ success: true, data: { rows, count: rows.length, report: meta } });
        } catch (err) { return fail(res, err.message); }
    }

    async inventoryExport(req, res) {
        try {
            const { csv } = await reportService.generateInventoryReport(req.user.userId);
            sendCSV(res, `inventory_${Date.now()}.csv`, csv);
        } catch (err) { return fail(res, err.message); }
    }

    // GET /api/reports/sla
    // GET /api/reports/sla/export
    async slaPreview(req, res) {
        try {
            const { rows, meta } = await reportService.generateSlaReport(req.user.userId);
            return res.json({ success: true, data: { rows, count: rows.length, report: meta } });
        } catch (err) { return fail(res, err.message); }
    }

    async slaExport(req, res) {
        try {
            const { csv } = await reportService.generateSlaReport(req.user.userId);
            sendCSV(res, `sla_${Date.now()}.csv`, csv);
        } catch (err) { return fail(res, err.message); }
    }
}

module.exports = new ReportController();
