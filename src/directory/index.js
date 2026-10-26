// Builds the directory sign-in service from the environment, once, the first time it is needed.
// Controllers import this; nothing here runs when AUTH_PROVIDER=local.

const { getDirectoryConfig, isDirectoryMode } = require('./config');

let instance;

function getDirectoryAuth() {
    if (instance) return instance;

    const cfg = getDirectoryConfig();
    let provider = null;
    if (cfg.provider === 'ldap')  provider = require('./ldapProvider').createLdapProvider(cfg);
    if (cfg.provider === 'entra') provider = require('./entraProvider').createEntraProvider(cfg);

    instance = require('./directoryAuthService').createDirectoryAuth({
        cfg,
        provider,
        db: require('../config/db'),
        audit: require('../services/auditService'),
        tokens: require('../services/tokenService'),
        email: require('../services/emailService'),
    });
    return instance;
}

// What the front-ends need to know to draw the right sign-in screen. Contains no secrets.
function publicAuthConfig(cfg = getDirectoryConfig()) {
    const directory = cfg.provider !== 'local';
    return {
        provider: cfg.provider,
        directory,
        loginMethod: cfg.provider === 'entra' ? 'microsoft' : 'password',
        selfRegistration: !directory,
        passwordManagedLocally: !directory,
        usernameLabel: cfg.provider === 'ldap' ? 'Email, user principal name or domain\\username' : 'Email',
    };
}

function resetDirectoryAuth() { instance = undefined; }

module.exports = { getDirectoryAuth, publicAuthConfig, resetDirectoryAuth, isDirectoryMode };
