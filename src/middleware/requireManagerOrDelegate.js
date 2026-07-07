const delegationService = require('../services/delegationService');

// Grants access if the user has Manager/Approver role OR has an active delegation
// from a Manager for today's date. Attaches req.user.actingForDelegatorId if delegated.
module.exports = async function requireManagerOrDelegate(req, res, next) {
    const { role } = req.user;

    if (role === 'Manager' || role === 'Approver' || role === 'Admin') {
        return next();
    }

    try {
        const delegation = await delegationService.getActiveDelegation(req.user.userId);
        if (delegation) {
            req.user.actingForDelegatorId = delegation.delegator_id;
            return next();
        }
    } catch (_) { /* fall through to 403 */ }

    return res.status(403).json({
        success: false,
        message: 'Access denied. Manager role or active delegation required.',
        data:    null,
    });
};
