const categoryService = require('../services/categoryService');
const { CategoryError } = categoryService;

function reply(res, status, message, data = null) {
    return res.status(status).json({ success: status < 400, message, data, timestamp: new Date().toISOString() });
}

function fail(res, err) {
    if (err instanceof CategoryError) return reply(res, err.status, err.message);
    console.error('Category error:', err);
    return reply(res, 500, 'We could not complete this request. Please try again.');
}

class CategoryController {

    // GET /api/device-categories           active categories with item counts (any signed-in user)
    // GET /api/device-categories?include_inactive=true   also switched-off ones (Admin only)
    list = async (req, res) => {
        try {
            const wantsAll = req.query.include_inactive === 'true';
            if (wantsAll && req.user.role !== 'Admin') {
                return reply(res, 403, 'Only Admins can see switched-off categories.');
            }
            const categories = await categoryService.list({ includeInactive: wantsAll });
            return reply(res, 200, `${categories.length} categor${categories.length === 1 ? 'y' : 'ies'}.`, { categories });
        } catch (err) { return fail(res, err); }
    };

    create = async (req, res) => {
        try {
            const category = await categoryService.create(req.body || {}, req.user.userId);
            return reply(res, 201, `"${category.name}" has been added.`, { category });
        } catch (err) { return fail(res, err); }
    };

    update = async (req, res) => {
        try {
            const category = await categoryService.update(parseInt(req.params.id, 10), req.body || {}, req.user.userId);
            return reply(res, 200, `"${category.name}" has been updated.`, { category });
        } catch (err) { return fail(res, err); }
    };

    remove = async (req, res) => {
        try {
            const removed = await categoryService.remove(parseInt(req.params.id, 10), req.user.userId);
            return reply(res, 200, `"${removed.name}" has been deleted.`, removed);
        } catch (err) { return fail(res, err); }
    };
}

module.exports = new CategoryController();
