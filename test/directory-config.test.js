const test = require('node:test');
const assert = require('node:assert/strict');
const { loadDirectoryConfig, validateDirectoryConfig } = require('../src/directory/config');
const roles = require('../src/directory/roleMapper');

const ldapEnv = {
    AUTH_PROVIDER: 'ldap', LDAP_URL: 'ldaps://dc01.dojcd.local:636', LDAP_BIND_DN: 'CN=svc,DC=dojcd,DC=local',
    LDAP_BIND_PASSWORD: 'x', LDAP_BASE_DN: 'DC=dojcd,DC=local',
};

test('local is the default and needs nothing', () => {
    const cfg = loadDirectoryConfig({});
    assert.equal(cfg.provider, 'local');
    assert.deepEqual(validateDirectoryConfig(cfg), []);
    assert.throws(() => loadDirectoryConfig({ AUTH_PROVIDER: 'saml' }), /AUTH_PROVIDER must be one of/);
});

test('ldap needs its settings, and refuses clear-text passwords', () => {
    assert.equal(validateDirectoryConfig(loadDirectoryConfig({ AUTH_PROVIDER: 'ldap' })).length >= 4, true);
    assert.deepEqual(validateDirectoryConfig(loadDirectoryConfig(ldapEnv)), []);

    const plain = validateDirectoryConfig(loadDirectoryConfig({ ...ldapEnv, LDAP_URL: 'ldap://dc01:389' }));
    assert.ok(plain.some((p) => /clear text/.test(p)));
    assert.deepEqual(validateDirectoryConfig(loadDirectoryConfig({ ...ldapEnv, LDAP_URL: 'ldap://dc01:389', LDAP_STARTTLS: 'true' })), []);
    assert.deepEqual(validateDirectoryConfig(loadDirectoryConfig({ ...ldapEnv, LDAP_URL: 'ldap://dc01:389', LDAP_ALLOW_INSECURE: 'true' })), []);
    assert.ok(validateDirectoryConfig(loadDirectoryConfig({ ...ldapEnv, LDAP_URL: 'http://dc01' })).some((p) => /ldaps:\/\//.test(p)));
    assert.ok(validateDirectoryConfig(loadDirectoryConfig({ ...ldapEnv, LDAP_USER_FILTER: '(uid=x)' })).some((p) => /\{\{username\}\}/.test(p)));
});

test('group lists take names with commas, or DNs separated by semicolons', () => {
    const cfg = loadDirectoryConfig({
        AD_GROUP_ADMIN: 'DOJCD-Admins, Head Office Admins',
        AD_GROUP_MANAGER: 'CN=DOJCD-Managers,OU=Groups,DC=dojcd,DC=local;CN=Branch Managers,OU=Groups,DC=dojcd,DC=local',
        AD_GROUP_FINANCE: 'CN=Finance,OU=Groups,DC=dojcd,DC=local',
    });
    assert.deepEqual(cfg.groups.Admin, ['DOJCD-Admins', 'Head Office Admins']);
    assert.deepEqual(cfg.groups.Manager, ['CN=DOJCD-Managers,OU=Groups,DC=dojcd,DC=local', 'CN=Branch Managers,OU=Groups,DC=dojcd,DC=local']);
    assert.deepEqual(cfg.groups.Finance, ['CN=Finance,OU=Groups,DC=dojcd,DC=local']);
});

test('roles come from the strongest matching group, by name or DN, ignoring case and spacing', () => {
    const cfg = loadDirectoryConfig({
        AD_GROUP_ADMIN: 'DOJCD-Admins', AD_GROUP_FINANCE: 'CN=Finance,OU=Groups,DC=dojcd,DC=local', AD_GROUP_MANAGER: 'DOJCD-Managers',
        AD_GROUP_MTN_STAFF: 'MTN Liaison',
    });
    assert.equal(roles.resolveStaffRole(['everyone'], cfg), null);
    assert.equal(roles.resolveStaffRole(['dojcd-managers'], cfg), 'Manager');
    assert.equal(roles.resolveStaffRole(['cn=finance, ou=groups , dc=dojcd,dc=local'], cfg), 'Finance');
    assert.equal(roles.resolveStaffRole(['DOJCD-Managers', 'Finance', 'CN=Finance,OU=Groups,DC=dojcd,DC=local'], cfg), 'Finance');
    assert.equal(roles.resolveStaffRole(['DOJCD-Managers', 'DOJCD-Admins'], cfg), 'Admin');
    assert.equal(roles.resolveStaffRole(['MTN Liaison'], cfg), 'MTN_Staff');
    assert.equal(roles.resolveStaffRole([], cfg), null);
});

test('an empty clients group lets every directory user in; a set one limits it', () => {
    assert.equal(roles.isClientAllowed([], loadDirectoryConfig({})), true);
    const limited = loadDirectoryConfig({ AD_GROUP_CLIENTS: 'DOJCD-Clients' });
    assert.equal(roles.isClientAllowed(['other'], limited), false);
    assert.equal(roles.isClientAllowed(['dojcd-clients'], limited), true);
});

test('clients registering with a password is off unless asked for, and only an explicit true turns it on', () => {
    assert.equal(loadDirectoryConfig({ AUTH_PROVIDER: 'ldap' }).allowClientRegistration, false);
    assert.equal(loadDirectoryConfig({ AUTH_PROVIDER: 'ldap', AUTH_ALLOW_CLIENT_REGISTRATION: 'yes' }).allowClientRegistration, false);
    assert.equal(loadDirectoryConfig({ AUTH_PROVIDER: 'ldap', AUTH_ALLOW_CLIENT_REGISTRATION: 'TRUE' }).allowClientRegistration, true);
});

test('the client import searches the whole directory unless narrowed, and the extra filter must be in brackets', () => {
    const base = { AUTH_PROVIDER: 'ldap', LDAP_URL: 'ldaps://dc.x:636', LDAP_BIND_DN: 'cn=s', LDAP_BIND_PASSWORD: 'p', LDAP_BASE_DN: 'DC=x' };
    const plain = loadDirectoryConfig(base);
    assert.equal(plain.ldap.syncBaseDn, 'DC=x');
    assert.equal(plain.ldap.syncFilter, '');
    assert.deepEqual(validateDirectoryConfig(plain), []);

    const narrowed = loadDirectoryConfig({ ...base, LDAP_SYNC_BASE_DN: 'OU=Staff,DC=x', LDAP_SYNC_FILTER: ' (department=*) ' });
    assert.equal(narrowed.ldap.syncBaseDn, 'OU=Staff,DC=x');
    assert.equal(narrowed.ldap.syncFilter, '(department=*)');
    assert.deepEqual(validateDirectoryConfig(narrowed), []);

    const broken = validateDirectoryConfig(loadDirectoryConfig({ ...base, LDAP_SYNC_FILTER: 'department=*' }));
    assert.equal(broken.length, 1);
    assert.match(broken[0], /LDAP_SYNC_FILTER must be a complete filter in brackets/);
});

test('the sync script understands --clients and --all, and refuses both at once', () => {
    const { parseSyncArgs } = require('../src/scripts/sync-directory');
    assert.deepEqual(parseSyncArgs([]), { dryRun: false, force: false });
    assert.deepEqual(parseSyncArgs(['--dry-run', '--clients']), { dryRun: true, force: false, scope: 'clients' });
    assert.deepEqual(parseSyncArgs(['--all', '--force']), { dryRun: false, force: true, scope: 'all' });
    assert.throws(() => parseSyncArgs(['--clients', '--all']), /either --clients or --all/);
    assert.throws(() => parseSyncArgs(['--everyone']), /Unknown option/);
});
