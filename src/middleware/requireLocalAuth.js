// Blocks the routes that only make sense when this server keeps the passwords itself (self-registration,
// "forgot password"). With directory sign-in, accounts and passwords belong to the organisation's directory.

const { getDirectoryConfig } = require('../directory/config');

module.exports = function requireLocalAuth(req, res, next) {
    const { provider } = getDirectoryConfig();
    if (provider === 'local') return next();

    return res.status(403).json({
        success: false,
        code: 'MANAGED_BY_DIRECTORY',
        message: 'Accounts and passwords are managed by your organisation. Sign in with your organisation account instead.',
        data: null,
    });
};
