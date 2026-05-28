const { verifyAccessToken } = require('../services/tokenService');

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
        next();
    } catch (err) {
        const message = err.name === 'TokenExpiredError'
            ? 'Session expired. Please log in again.'
            : 'Invalid token.';
        return res.status(401).json({ success: false, message, data: null });
    }
};
