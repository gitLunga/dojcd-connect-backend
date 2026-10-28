// Guards the routes that only make sense when this server keeps passwords itself: self-registration and
// "forgot password". With directory sign-in, accounts and passwords belong to the organisation's directory, except
// that AUTH_ALLOW_CLIENT_REGISTRATION=true keeps them open for clients who are not in the directory (the services
// behind them only ever touch client accounts that sign in locally).

const { getDirectoryConfig } = require('../directory/config');

module.exports = function requireLocalAuth(req, res, next) {
    const cfg = getDirectoryConfig();
    if (cfg.provider === 'local' || cfg.allowClientRegistration) return next();

    return res.status(403).json({
        success: false,
        code: 'MANAGED_BY_DIRECTORY',
        message: 'Accounts and passwords are managed by your organisation. Sign in with your organisation account instead.',
        data: null,
    });
};
