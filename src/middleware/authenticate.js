const { verifyAccessToken } = require('../services/tokenService');

// While an account still has a temporary password (must_change_password), its token may
// only be used to change that password or to sign out. Everything else is refused, so a
// guessed or leaked temporary password cannot be used to do anything useful.
const ALLOWED_WHILE_PASSWORD_CHANGE_PENDING = new Set([
    '/api/auth/change-password',
    '/api/auth/logout',
]);

module.exports = function authenticate(req, res, next) {
    const authHeader = req.headers.authorization;

    if (!authHeader?.startsWith('Bearer ')) {
        return res.status(401).json({
            success: false,
            message: 'Authentication required.',
            data: null,
        });
    }

    const token = authHeader.slice(7);

    try {
        req.user = verifyAccessToken(token);
    } catch (err) {
        const message = err.name === 'TokenExpiredError'
            ? 'Your session has expired. Please sign in again.'
            : 'Your session is invalid. Please sign in again.';
        return res.status(401).json({ success: false, message, data: null });
    }

    if (req.user.mustChangePassword === true) {
        const path = req.originalUrl.split('?')[0].replace(/\/+$/, '');
        if (!ALLOWED_WHILE_PASSWORD_CHANGE_PENDING.has(path)) {
            return res.status(403).json({
                success: false,
                code: 'PASSWORD_CHANGE_REQUIRED',
                message: 'You must change your temporary password before continuing.',
                data: null,
            });
        }
    }

    next();
};
