// End to end over HTTP: the real Express app, a real PostgreSQL, and a mock Active Directory.
// AUTH_PROVIDER=ldap. Skipped unless TEST_PG_HOST is set (see test/helpers/testDb.js).

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const jwt = require('jsonwebtoken');

const { useTestDatabase } = require('./helpers/testDb');
const testDb = useTestDatabase();
const { stubBcrypt } = require('./helpers/stubs');
stubBcrypt();
const { startMockAd, user, BASE, SERVICE_DN } = require('./helpers/mockAd');

let ad, server, base, pool;

const guid = (n) => `aaaaaaaa-0000-4000-8000-00000000000${n}`;
const people = () => {
    const admin   = user({ given: 'Ada',   sn: 'Admin',   sam: 'aadmin',   guid: guid(1), employeeId: '10000001' });
    const manager = user({ given: 'Mo',    sn: 'Manager', sam: 'mmanager', guid: guid(2), employeeId: '10000002' });
    const plain   = user({ given: 'Pat',   sn: 'Plain',   sam: 'pplain',   guid: guid(3), employeeId: '10000003' });
    const magi    = user({ given: 'Maggie', sn: 'Judge',  sam: 'mjudge',   guid: guid(4), employeeId: '10000004' });
    const adminsGroup   = { dn: `CN=DOJCD-Admins,OU=Groups,${BASE}`,   cn: 'DOJCD-Admins',   members: [admin.dn] };
    const managersGroup = { dn: `CN=DOJCD-Managers,OU=Groups,${BASE}`, cn: 'DOJCD-Managers', members: [manager.dn] };
    const magiGroup     = { dn: `CN=DOJCD-Magistrates,OU=Groups,${BASE}`, cn: 'DOJCD-Magistrates', members: [magi.dn] };
    return { users: [admin, manager, plain, magi], groups: [adminsGroup, managersGroup, magiGroup], admin, manager, plain, magi, managersGroup };
};

const call = async (method, urlPath, { body, token, headers = {} } = {}) => {
    const res = await fetch(`${base}${urlPath}`, {
        method, redirect: 'manual',
        headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (_) { /* not JSON */ }
    return { status: res.status, json, text, headers: res.headers };
};

const login = (who, password = 'Correct-Horse-9', audience = 'staff') =>
    call('POST', audience === 'staff' ? '/api/auth/login-operational' : '/api/auth/login-client', { body: { email: who, password } });
const one = async (sql, params) => (await pool.query(sql, params)).rows[0];

describe('LDAP sign-in over HTTP (real PostgreSQL, mock Active Directory)', { skip: testDb.skip }, () => {
    let dir;

    before(async () => {
        await testDb.create();
        dir = people();
        ad = await startMockAd(dir);

        Object.assign(process.env, {
            AUTH_PROVIDER: 'ldap', LDAP_URL: ad.url, LDAP_ALLOW_INSECURE: 'true', LDAP_TIMEOUT_MS: '3000',
            LDAP_BIND_DN: SERVICE_DN, LDAP_BIND_PASSWORD: 'service-secret', LDAP_BASE_DN: BASE,
            AD_GROUP_ADMIN: 'DOJCD-Admins', AD_GROUP_MANAGER: 'DOJCD-Managers', AD_GROUP_MAGISTRATES: 'DOJCD-Magistrates',
            AUTH_MAX_FAILED_LOGINS: '3',
            SLA_ALERT_SCHEDULE: 'off', UPLOADS_DIR: path.join(os.tmpdir(), `dojcd-uploads-${process.pid}`),
        });
        delete process.env.AUTH_ALLOW_LOCAL_ADMIN_LOGIN;

        const app = require('../src/app');
        pool = require('../src/config/db');
        server = http.createServer(app);
        await new Promise((r) => server.listen(0, '127.0.0.1', r));
        base = `http://127.0.0.1:${server.address().port}`;
    });

    after(async () => {
        if (!testDb.enabled) return;
        await new Promise((r) => { server.closeAllConnections?.(); server.close(r); });
        await ad.close();
        await testDb.drop(pool);
    });

    beforeEach(async () => {
        await pool.query(`TRUNCATE operational_user, client_user RESTART IDENTITY CASCADE`);
        await pool.query(`TRUNCATE audit_log, login_attempt, refresh_token RESTART IDENTITY`);
        // each test gets a fresh failure counter: restart the service so the in-memory limiter is empty
        require('../src/directory').resetDirectoryAuth();
    });

    it('tells the front-ends which sign-in to draw', async () => {
        const res = await call('GET', '/api/auth/config');
        assert.equal(res.status, 200);
        assert.deepEqual(res.json.data, {
            provider: 'ldap', directory: true, loginMethod: 'password', selfRegistration: false, passwordManagedLocally: false,
            usernameLabel: 'Email, user principal name or domain\\username',
        });
    });

    it('signs a group member in as staff on the existing operational endpoint, creating the account', async () => {
        const res = await login('mmanager');
        assert.equal(res.status, 200, res.text);
        assert.equal(res.json.message, 'Operational user login successful');
        const { user: u, accessToken, refreshToken } = res.json.data;
        assert.equal(u.user_role, 'Manager');
        assert.equal(u.email, 'mmanager@dojcd.gov.za');
        assert.equal(u.name, 'Mo Manager');
        assert.ok(!('password_hash' in u) && !('external_id' in u));
        assert.ok(refreshToken);
        assert.equal(jwt.verify(accessToken, process.env.JWT_SECRET).role, 'Manager');

        assert.equal((await one(`SELECT count(*)::int AS n FROM login_attempt WHERE success AND email = 'mmanager'`)).n, 1);
        // and the token really is accepted by the API, with the right permissions
        assert.equal((await call('GET', '/api/admin/operational-users', { token: accessToken })).status, 403, 'a Manager is not an Admin');
    });

    it('an Admin from the directory can use the admin API, and sees the people who signed in', async () => {
        await login('mmanager');
        const admin = await login('aadmin');
        const list = await call('GET', '/api/admin/operational-users', { token: admin.json.data.accessToken });
        assert.equal(list.status, 200);
        assert.deepEqual(list.json.data.users.map((r) => r.user_role).sort(), ['Admin', 'Manager']);
    });

    it('a directory user without a staff group is refused as staff but welcome as a client', async () => {
        const asStaff = await login('pplain');
        assert.equal(asStaff.status, 403);
        assert.equal(asStaff.json.code, 'NO_STAFF_ACCESS');

        const asClient = await login('pplain', 'Correct-Horse-9', 'client');
        assert.equal(asClient.status, 200, asClient.text);
        assert.equal(asClient.json.data.user.registration_status, 'Pending');
        assert.equal(asClient.json.data.user.user_type, 'Advocate');
        assert.equal(jwt.verify(asClient.json.data.accessToken, process.env.JWT_SECRET).userType, 'Client');
    });

    it('the generic /login serves the client portal, and magistrates are recognised', async () => {
        const res = await call('POST', '/api/auth/login', { body: { email: 'mjudge@example.local', password: 'Correct-Horse-9' } });
        assert.equal(res.status, 200, res.text);
        assert.equal(res.json.data.user.user_type, 'Magistrate');
        assert.equal(res.json.data.user.persal_id, '10000004');
    });

    it('wrong passwords are refused, logged, and eventually rate-limited', async () => {
        for (let i = 0; i < 3; i++) {
            const bad = await login('mmanager', 'wrong');
            assert.equal(bad.status, 401);
            assert.equal(bad.json.code, 'INVALID_CREDENTIALS');
        }
        const locked = await login('mmanager', 'wrong');
        assert.equal(locked.status, 429);
        assert.equal(locked.json.code, 'TOO_MANY_ATTEMPTS');

        const stillLocked = await login('mmanager');            // even the right password waits
        assert.equal(stillLocked.status, 429);
        assert.equal((await one(`SELECT count(*)::int AS n FROM login_attempt WHERE NOT success`)).n, 3);
        assert.equal((await one(`SELECT count(*)::int AS n FROM operational_user`)).n, 0, 'nothing was created for a failed sign-in');

        const other = await login('aadmin');                    // other people are unaffected
        assert.equal(other.status, 200);
    });

    it('self-registration and password reset are closed: the directory owns passwords', async () => {
        for (const [p, body] of [['/api/auth/register', { email: 'x@y.za', password: 'Passw0rd!x' }], ['/api/auth/forgot-password', { email: 'x@y.za' }],
            ['/api/auth/reset-password', { token: 't', new_password: 'Passw0rd!x' }]]) {
            const res = await call('POST', p, { body });
            assert.equal(res.status, 403, p);
            assert.equal(res.json.code, 'MANAGED_BY_DIRECTORY', p);
        }
        const session = (await login('mmanager')).json.data;
        const change = await call('POST', '/api/auth/change-password', { token: session.accessToken, body: { current_password: 'a', new_password: 'Passw0rd!xyz' } });
        assert.equal(change.status, 400);
        assert.match(change.json.message, /managed by your organisation/);
    });

    it('an Admin pre-authorising someone creates no password; the person then signs in with the directory', async () => {
        const admin = (await login('aadmin')).json.data.accessToken;
        const made = await call('POST', '/api/admin/operational-users', {
            token: admin, body: { first_name: 'Pat', last_name: 'Plain', email: 'pplain@dojcd.gov.za', user_role: 'Finance', department_id: 'DoJ&CD Gauteng' },
        });
        assert.equal(made.status, 201, made.text);
        assert.equal(made.json.data.default_password, null);
        assert.equal(made.json.data.directory, true);
        assert.match(made.json.message, /organisation account/);
        const row = await one(`SELECT password_hash, auth_source, role_source, external_id FROM operational_user WHERE email = 'pplain@dojcd.gov.za'`);
        assert.deepEqual(row, { password_hash: null, auth_source: 'ldap', role_source: 'manual', external_id: null });

        const signIn = await login('pplain');
        assert.equal(signIn.status, 200, signIn.text);
        assert.equal(signIn.json.data.user.user_role, 'Finance');
        assert.equal(signIn.json.data.user.department_id, 'DoJ&CD Gauteng');
    });

    it('a directory-linked account cannot have its password set from the dashboard', async () => {
        const admin = (await login('aadmin')).json.data;
        const res = await call('PATCH', `/api/admin/operational-users/${admin.user.op_user_id}/change-password`, {
            token: admin.accessToken, body: { current_password: 'x', new_password: 'Passw0rd!xyz', confirm_password: 'Passw0rd!xyz' },
        });
        assert.equal(res.status >= 400, true);
        assert.match(JSON.stringify(res.json), /organisation directory/);
    });

    it('refresh keeps a live account signed in and refuses one that was switched off', async () => {
        const session = (await login('mmanager')).json.data;
        const refreshed = await call('POST', '/api/auth/refresh', { body: { refreshToken: session.refreshToken } });
        assert.equal(refreshed.status, 200);
        assert.equal(jwt.verify(refreshed.json.data.accessToken, process.env.JWT_SECRET).role, 'Manager');

        // removed from the group in AD: the next sign-in attempt switches the account off ...
        dir.managersGroup.members.length = 0;
        assert.equal((await login('mmanager')).status, 403);
        // ... and the session that was still open can no longer renew itself
        const denied = await call('POST', '/api/auth/refresh', { body: { refreshToken: refreshed.json.data.refreshToken } });
        assert.equal(denied.status, 401);
        assert.match(denied.json.message, /no longer active/);
        dir.managersGroup.members.push(dir.manager.dn);
    });

    it('sync previews, creates staff from the groups, and switches off those who left', async () => {
        const admin = (await login('aadmin')).json.data.accessToken;

        const preview = await call('POST', '/api/admin/directory/sync?dryRun=true', { token: admin });
        assert.equal(preview.status, 200, preview.text);
        assert.deepEqual({ created: preview.json.data.created, updated: preview.json.data.updated, dry: preview.json.data.dryRun }, { created: 1, updated: 1, dry: true });
        assert.equal((await one(`SELECT count(*)::int AS n FROM operational_user`)).n, 1, 'a dry run changes nothing');

        const real = await call('POST', '/api/admin/directory/sync', { token: admin });
        assert.equal(real.status, 200, real.text);
        assert.equal(real.json.data.created, 1);
        assert.equal((await one(`SELECT user_role FROM operational_user WHERE email = 'mmanager@dojcd.gov.za'`)).user_role, 'Manager');

        // The manager leaves the group; the Admin remains in theirs, so the directory still returns someone.
        dir.managersGroup.members.length = 0;
        const after = await call('POST', '/api/admin/directory/sync', { token: admin });
        assert.equal(after.json.data.revoked, 1);
        assert.equal((await one(`SELECT is_deleted FROM operational_user WHERE email = 'mmanager@dojcd.gov.za'`)).is_deleted, true);
        dir.managersGroup.members.push(dir.manager.dn);
    });

    it('sync refuses to switch everyone off when the directory returns nobody', async () => {
        const admin = (await login('aadmin')).json.data.accessToken;
        await call('POST', '/api/admin/directory/sync', { token: admin });
        const saved = dir.groups.map((g) => [...g.members]);
        dir.groups.forEach((g) => { g.members.length = 0; });

        const refused = await call('POST', '/api/admin/directory/sync', { token: admin });
        assert.equal(refused.status, 400);
        assert.match(refused.json.message, /returned no members/);
        assert.equal((await one(`SELECT count(*)::int AS n FROM operational_user WHERE is_deleted = false`)).n, 2);

        dir.groups.forEach((g, i) => g.members.push(...saved[i]));
    });

    it('only an Admin may run the sync', async () => {
        const manager = (await login('mmanager')).json.data.accessToken;
        assert.equal((await call('POST', '/api/admin/directory/sync', { token: manager })).status, 403);
        assert.equal((await call('POST', '/api/admin/directory/sync')).status, 401);
    });

    it('a break-glass local Admin works only when it is switched on', async () => {
        await pool.query(
            `INSERT INTO operational_user (first_name, last_name, email, user_role, password_hash, must_change_password, is_super_admin, auth_source)
             VALUES ('Brea', 'Kglass', 'breakglass@dojcd.gov.za', 'Admin', 'hashed:Local-Secret-9!', false, true, 'local')`
        );
        const off = await login('breakglass@dojcd.gov.za', 'Local-Secret-9!');
        assert.equal(off.status, 401, 'off by default: the directory does not know this account');

        process.env.AUTH_ALLOW_LOCAL_ADMIN_LOGIN = 'true';
        require('../src/directory/config').resetDirectoryConfigCache();
        require('../src/directory').resetDirectoryAuth();
        try {
            const on = await login('breakglass@dojcd.gov.za', 'Local-Secret-9!');
            assert.equal(on.status, 200, on.text);
            assert.equal(on.json.data.user.user_role, 'Admin');

            const wrong = await login('breakglass@dojcd.gov.za', 'nope');
            assert.equal(wrong.status, 401);
            // a directory-managed Admin is not a break-glass account: it never signs in locally
            assert.equal((await login('aadmin')).status, 200);
        } finally {
            delete process.env.AUTH_ALLOW_LOCAL_ADMIN_LOGIN;
            require('../src/directory/config').resetDirectoryConfigCache();
            require('../src/directory').resetDirectoryAuth();
        }
    });
});
