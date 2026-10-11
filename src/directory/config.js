// Settings for directory sign-in (Microsoft Active Directory over LDAPS, or Microsoft Entra ID).
//
// AUTH_PROVIDER picks how people sign in:
//   local  email + password stored in this database (the original behaviour; the default)
//   ldap   on-premises Active Directory: the person types their domain credentials into our form
//          and the server checks them against a domain controller over LDAPS
//   entra  Microsoft Entra ID (Azure AD): "Sign in with Microsoft", OpenID Connect handled by the server
//
// Everything is read from the environment so one build serves every deployment.

const PROVIDERS = ['local', 'ldap', 'entra'];

// Highest first: someone in several role groups gets the strongest role.
const STAFF_ROLE_PRIORITY = ['Admin', 'Finance', 'Manager', 'Approver', 'MTN_Staff'];

const csv = (value) => String(value || '').split(',').map((s) => s.trim()).filter(Boolean);

// Group settings hold group NAMES (comma-separated) or distinguished names, which contain commas themselves.
// Separate entries with ";" (or a new line); an entry that contains "=" is a DN and keeps its commas.
//   AD_GROUP_MANAGER=DOJCD-Managers, Branch Managers
//   AD_GROUP_MANAGER=CN=DOJCD-Managers,OU=Groups,DC=dojcd,DC=local;CN=Branch Managers,OU=Groups,DC=dojcd,DC=local
const groupList = (value) => String(value || '')
    .split(/[;\n]/)
    .flatMap((chunk) => (chunk.includes('=') ? [chunk.trim()] : chunk.split(',').map((s) => s.trim())))
    .filter(Boolean);
const flag = (value, fallback = false) => (value === undefined || value === '' ? fallback : String(value).toLowerCase() === 'true');

function loadDirectoryConfig(env = process.env) {
    const provider = String(env.AUTH_PROVIDER || 'local').trim().toLowerCase();
    if (!PROVIDERS.includes(provider)) {
        throw new Error(`AUTH_PROVIDER must be one of ${PROVIDERS.join(', ')} (got "${env.AUTH_PROVIDER}")`);
    }

    return {
        provider,
        // Role groups. Each takes group names (AD: CN, sAMAccountName or full DN; Entra: object id or
        // display name), comma-separated.
        groups: {
            Admin:      groupList(env.AD_GROUP_ADMIN),
            Finance:    groupList(env.AD_GROUP_FINANCE),
            Manager:    groupList(env.AD_GROUP_MANAGER),
            Approver:   groupList(env.AD_GROUP_APPROVER),
            MTN_Staff:  groupList(env.AD_GROUP_MTN_STAFF),
            superAdmin: groupList(env.AD_GROUP_SUPER_ADMIN),
            magistrates: groupList(env.AD_GROUP_MAGISTRATES),
            clients:    groupList(env.AD_GROUP_CLIENTS),
        },
        defaultUserType: env.DIRECTORY_DEFAULT_USER_TYPE === 'Magistrate' ? 'Magistrate' : 'Advocate',
        allowLocalAdminLogin: flag(env.AUTH_ALLOW_LOCAL_ADMIN_LOGIN, false),
        allowedRedirects: csv(env.AUTH_ALLOWED_REDIRECTS),
        loginRateLimit: {
            maxFailures: parseInt(env.AUTH_MAX_FAILED_LOGINS, 10) || 8,
            windowMs: (parseInt(env.AUTH_FAILED_LOGIN_WINDOW_MINUTES, 10) || 10) * 60 * 1000,
        },

        ldap: {
            url:            env.LDAP_URL || '',
            bindDn:         env.LDAP_BIND_DN || '',
            bindPassword:   env.LDAP_BIND_PASSWORD || '',
            baseDn:         env.LDAP_BASE_DN || '',
            groupBaseDn:    env.LDAP_GROUP_BASE_DN || env.LDAP_BASE_DN || '',
            userFilter:     env.LDAP_USER_FILTER ||
                '(&(objectCategory=person)(objectClass=user)(|(sAMAccountName={{username}})(userPrincipalName={{username}})(mail={{username}})))',
            nestedGroups:   flag(env.LDAP_NESTED_GROUPS, true),
            startTls:       flag(env.LDAP_STARTTLS, false),
            allowInsecure:  flag(env.LDAP_ALLOW_INSECURE, false),
            caFile:         env.LDAP_CA_FILE || '',
            rejectUnauthorized: flag(env.LDAP_TLS_REJECT_UNAUTHORIZED, true),
            timeoutMs:      parseInt(env.LDAP_TIMEOUT_MS, 10) || 8000,
            persalAttribute: env.LDAP_ATTR_PERSAL || 'employeeID',
        },

        entra: {
            tenantId:     env.ENTRA_TENANT_ID || '',
            clientId:     env.ENTRA_CLIENT_ID || '',
            clientSecret: env.ENTRA_CLIENT_SECRET || '',
            redirectUri:  env.ENTRA_REDIRECT_URI || '',
            authorityHost: (env.ENTRA_AUTHORITY_HOST || 'https://login.microsoftonline.com').replace(/\/+$/, ''),
            graphHost:     (env.ENTRA_GRAPH_HOST || 'https://graph.microsoft.com').replace(/\/+$/, ''),
        },
    };
}

// Returns a list of human-readable problems (empty = fine). Called at startup so a half-configured
// server refuses to boot instead of failing on the first person who tries to sign in.
function validateDirectoryConfig(cfg) {
    const problems = [];
    if (cfg.provider === 'local') return problems;

    if (cfg.provider === 'ldap') {
        const l = cfg.ldap;
        if (!l.url)      problems.push('LDAP_URL is not set (for example ldaps://dc01.dojcd.local:636)');
        if (!l.bindDn)   problems.push('LDAP_BIND_DN is not set (the service account used to look people up)');
        if (!l.bindPassword) problems.push('LDAP_BIND_PASSWORD is not set');
        if (!l.baseDn)   problems.push('LDAP_BASE_DN is not set (for example DC=dojcd,DC=local)');
        if (l.url && !/^ldaps?:\/\//i.test(l.url)) problems.push('LDAP_URL must start with ldaps:// or ldap://');
        if (/^ldap:\/\//i.test(l.url) && !l.startTls && !l.allowInsecure) {
            problems.push('LDAP_URL uses ldap:// without TLS: passwords would cross the network in clear text. ' +
                'Use ldaps://, or set LDAP_STARTTLS=true (or LDAP_ALLOW_INSECURE=true for a lab only).');
        }
        if (!l.userFilter.includes('{{username}}')) problems.push('LDAP_USER_FILTER must contain {{username}}');
    }

    if (cfg.provider === 'entra') {
        const e = cfg.entra;
        if (!e.tenantId)    problems.push('ENTRA_TENANT_ID is not set (the Directory (tenant) ID)');
        else if (!/^[0-9a-f]{8}-([0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(e.tenantId)) {
            problems.push('ENTRA_TENANT_ID must be the tenant GUID, not a domain name or "common" (tokens from other tenants must be refused)');
        }
        if (!e.clientId)    problems.push('ENTRA_CLIENT_ID is not set (the Application (client) ID)');
        if (!e.clientSecret) problems.push('ENTRA_CLIENT_SECRET is not set');
        if (!e.redirectUri) problems.push('ENTRA_REDIRECT_URI is not set (the API callback URL registered in Entra ID)');
        if (cfg.allowedRedirects.length === 0) {
            problems.push('AUTH_ALLOWED_REDIRECTS is not set (comma-separated front-end URLs people may be sent back to)');
        }
    }

    return problems;
}

function assertDirectoryConfig(env = process.env) {
    const cfg = loadDirectoryConfig(env);
    const problems = validateDirectoryConfig(cfg);
    if (problems.length > 0) {
        throw new Error(`AUTH_PROVIDER=${cfg.provider} is not fully configured:\n  - ${problems.join('\n  - ')}`);
    }
    return cfg;
}

// Cached for the running server; tests pass their own env to loadDirectoryConfig instead.
let cached;
function getDirectoryConfig() {
    if (!cached) cached = loadDirectoryConfig(process.env);
    return cached;
}
function resetDirectoryConfigCache() { cached = undefined; }

const isDirectoryMode = (cfg = getDirectoryConfig()) => cfg.provider !== 'local';

module.exports = {
    PROVIDERS, STAFF_ROLE_PRIORITY,
    loadDirectoryConfig, validateDirectoryConfig, assertDirectoryConfig,
    getDirectoryConfig, resetDirectoryConfigCache, isDirectoryMode,
};
