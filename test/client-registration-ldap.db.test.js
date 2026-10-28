// Clients who are not in the directory may still register with a password (AUTH_ALLOW_CLIENT_REGISTRATION=true),
// next to the organisation sign-in. Real Express app, real PostgreSQL, mock Active Directory (AUTH_PROVIDER=ldap).
// Skipped unless TEST_PG_HOST is set (see test/helpers/testDb.js).

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

let ad, server, base, pool, resets;

const guid = (n) => `dddddddd-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`;
const dir = () => {
    const admin = user({ given: 'Ada',  sn: 'Admin',  sam: 'aadmin',  guid: guid(1), employeeId: '30000001' });
    const staff = user({ given: 'Cara', sn: 'Client', sam: 'cclient', guid: guid(2), employeeId: '30000002' });
    return {
        users: [admin, staff],
        groups: [{ dn: `CN=DOJCD-Admins,OU=Groups,${BASE}`, cn: 'DOJCD-Admins', members: [admin.dn] }],
    };
};

const call = async (method, urlPath, { body, token } = {}) => {
    const res = await fetch(`${base}${urlPath}`, {
        method, redirect: 'manual',
        headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (_) { /* not JSON */ }
    return { status: res.status, json, text };
};
const one = async (sql, params) => (await pool.query(sql, params)).rows[0];
const PASSWORD = 'Str0ng-Pass-9x';
const outsider = (over = {}) => ({
    first_name: 'Olive', last_name: 'Outside', email: 'olive@chambers.example.org', phone_number: '0821234567',
    persal_id: '55500001', user_type: 'Advocate', password: PASSWORD, ...over,
});
const register = (over) => call('POST', '/api/auth/register', { body: outsider(over) });
const signIn = (email, password = PASSWORD, route = '/api/auth/login-client') => call('POST', route, { body: { email, password } });

const useConfig = (env = {}) => {
    delete process.env.AUTH_ALLOW_CLIENT_REGISTRATION;
    process.env.LDAP_BIND_PASSWORD = 'service-secret';
    Object.assign(process.env, env);
    require('../src/directory/config').resetDirectoryConfigCache();
    require('../src/directory').resetDirectoryAuth();
};
const open = () => useConfig({ AUTH_ALLOW_CLIENT_REGISTRATION: 'true' });

describe('clients registering next to Active Directory sign-in (real PostgreSQL, mock AD)', { skip: testDb.skip }, () => {
    before(async () => {
        await testDb.create();
        ad = await startMockAd(dir());

        Object.assign(process.env, {
            AUTH_PROVIDER: 'ldap', LDAP_URL: ad.url, LDAP_ALLOW_INSECURE: 'true', LDAP_TIMEOUT_MS: '3000',
            LDAP_BIND_DN: SERVICE_DN, LDAP_BIND_PASSWORD: 'service-secret', LDAP_BASE_DN: BASE,
            AD_GROUP_ADMIN: 'DOJCD-Admins', AUTH_MAX_FAILED_LOGINS: '3',
            SLA_ALERT_SCHEDULE: 'off', UPLOADS_DIR: path.join(os.tmpdir(), `dojcd-uploads-register-${process.pid}`),
        });
        delete process.env.AUTH_ALLOW_LOCAL_ADMIN_LOGIN;

        const app = require('../src/app');
        pool = require('../src/config/db');
        server = http.createServer(app);
        await new Promise((r) => server.listen(0, '127.0.0.1', r));
        base = `http://127.0.0.1:${server.address().port}`;

        const mail = require('../src/services/emailService');
        mail.sendWelcomeClient = async () => {};
        mail.sendPasswordResetRequest = async (to, name, url) => { resets.push({ to, url }); };
        mail.sendPasswordChanged = async () => {};
    });

    after(async () => {
        if (!testDb.enabled) return;
        await new Promise((r) => { server.closeAllConnections?.(); server.close(r); });
        await ad.close();
        await testDb.drop(pool);
    });

    beforeEach(async () => {
        resets = [];
        useConfig();
        await pool.query(`TRUNCATE operational_user, client_user, password_reset_token RESTART IDENTITY CASCADE`);
        await pool.query(`TRUNCATE audit_log, login_attempt, refresh_token RESTART IDENTITY`);
    });

    describe('switched off (the default)', () => {
        it('the client portal is told registration is closed, and the server agrees', async () => {
            assert.equal((await call('GET', '/api/auth/config')).json.data.clientRegistration, false);
            const res = await register();
            assert.equal(res.status, 403);
            assert.equal(res.json.code, 'MANAGED_BY_DIRECTORY');
            assert.equal((await call('POST', '/api/auth/forgot-password', { body: { email: 'a@b.co' } })).status, 403);
            assert.equal((await one(`SELECT count(*)::int AS n FROM client_user`)).n, 0);
        });
    });

    describe('switched on', () => {
        beforeEach(() => open());

        it('is announced to the front-ends', async () => {
            const cfg = (await call('GET', '/api/auth/config')).json.data;
            assert.equal(cfg.clientRegistration, true);
            assert.equal(cfg.provider, 'ldap');
            assert.equal(cfg.selfRegistration, false, 'the staff screens still see a closed directory');
        });

        it('a client outside the directory registers, and signs in with that password on the usual endpoints', async () => {
            const res = await register();
            assert.equal(res.status, 201, res.text);
            assert.equal(res.json.data.user.registration_status, 'Pending');
            assert.ok(!('password_hash' in res.json.data.user));

            const row = await one(`SELECT auth_source, external_id, password_hash FROM client_user WHERE email = 'olive@chambers.example.org'`);
            assert.equal(row.auth_source, 'local');
            assert.equal(row.external_id, null);
            assert.ok(row.password_hash);

            for (const route of ['/api/auth/login-client', '/api/auth/login']) {
                const login = await signIn('olive@chambers.example.org', PASSWORD, route);
                assert.equal(login.status, 200, `${route}: ${login.text}`);
                assert.equal(jwt.verify(login.json.data.accessToken, process.env.JWT_SECRET).userType, 'Client');
            }
            assert.equal((await one(`SELECT count(*)::int AS n FROM login_attempt WHERE success AND email = 'olive@chambers.example.org'`)).n, 2);
        });

        it('an address that belongs to an organisation account must use the organisation sign-in', async () => {
            for (const email of ['cclient@dojcd.gov.za', 'CClient@Example.Local']) {   // by mail, and by user principal name
                const res = await register({ email, persal_id: `7${Math.random().toString().slice(2, 9)}` });
                assert.equal(res.status, 409, res.text);
                assert.equal(res.json.code, 'USE_DIRECTORY_SIGN_IN');
            }
            assert.equal((await one(`SELECT count(*)::int AS n FROM client_user`)).n, 0);
        });

        it('the address cannot be used to rewrite the directory search', async () => {
            const res = await register({ email: 'x*)(objectClass=*@evil.test' });
            assert.notEqual(res.status, 409);
            assert.ok(!ad.searches.some((f) => f.includes('(objectClass=*)')), 'the typed text never became part of the filter');
        });

        it('registration waits when the directory cannot be asked, instead of guessing', async () => {
            useConfig({ AUTH_ALLOW_CLIENT_REGISTRATION: 'true', LDAP_BIND_PASSWORD: 'wrong-service-password' });
            const res = await register();
            assert.equal(res.status, 503, res.text);
            assert.equal(res.json.code, 'REGISTRATION_UNAVAILABLE');
            assert.equal((await one(`SELECT count(*)::int AS n FROM client_user`)).n, 0);
        });

        it('an organisation account still signs in to the client portal with its domain password', async () => {
            await register();
            const res = await signIn('cclient', 'Correct-Horse-9');
            assert.equal(res.status, 200, res.text);
            assert.equal((await one(`SELECT auth_source FROM client_user WHERE email = 'cclient@dojcd.gov.za'`)).auth_source, 'ldap');
        });

        it('a wrong password is refused and counts towards the pause, local account or not', async () => {
            await register();
            for (let i = 0; i < 3; i++) {
                const res = await signIn('olive@chambers.example.org', 'not-the-password');
                assert.equal(res.status, 401);
                assert.equal(res.json.code, 'INVALID_CREDENTIALS');
            }
            const paused = await signIn('olive@chambers.example.org', PASSWORD);
            assert.equal(paused.status, 429, 'even the right password waits once the failures add up');
        });

        it('staff never sign in with a client password', async () => {
            await register();
            const res = await signIn('olive@chambers.example.org', PASSWORD, '/api/auth/login-operational');
            assert.notEqual(res.status, 200);
            assert.equal((await one(`SELECT count(*)::int AS n FROM operational_user`)).n, 0);
        });

        it('a client who registered before joining the directory becomes that person on their first organisation sign-in', async () => {
            // (inserted directly: registration itself now refuses this address)
            await pool.query(
                `INSERT INTO client_user (first_name, last_name, email, user_type, password_hash, registration_status, persal_id)
                 VALUES ('Cara','Old','cclient@dojcd.gov.za','Advocate','hashed:${PASSWORD}','Verified','55500002')`
            );
            assert.equal((await signIn('cclient@dojcd.gov.za')).status, 200, 'the old password works until the directory takes over');

            assert.equal((await signIn('cclient', 'Correct-Horse-9')).status, 200);
            const row = await one(`SELECT auth_source, password_hash, registration_status FROM client_user WHERE lower(email) = 'cclient@dojcd.gov.za'`);
            assert.deepEqual(row, { auth_source: 'ldap', password_hash: null, registration_status: 'Verified' });
            assert.equal((await signIn('cclient@dojcd.gov.za', PASSWORD)).status, 401, 'the old password no longer works');
        });

        it('a switched-off client cannot sign in', async () => {
            await register();
            await pool.query(`UPDATE client_user SET registration_status = 'Deactivated'`);
            const res = await signIn('olive@chambers.example.org');
            assert.equal(res.status, 403);
            assert.equal(res.json.code, 'ACCOUNT_DEACTIVATED');
        });

        it('forgot password works for a client with a password here, and for nobody else', async () => {
            await register();
            await signIn('cclient', 'Correct-Horse-9');                       // a directory client
            await pool.query(
                `INSERT INTO operational_user (first_name, last_name, email, user_role, password_hash, must_change_password, auth_source)
                 VALUES ('Brea','Kglass','breakglass@dojcd.gov.za','Admin','hashed:Local-Secret-9!',false,'local')`
            );

            for (const email of ['olive@chambers.example.org', 'cclient@dojcd.gov.za', 'breakglass@dojcd.gov.za', 'nobody@x.test']) {
                const res = await call('POST', '/api/auth/forgot-password', { body: { email } });
                assert.equal(res.status, 200, `${email}: ${res.text}`);
            }
            assert.deepEqual(resets.map((r) => r.to), ['olive@chambers.example.org']);

            const token = new URL(resets[0].url).searchParams.get('token');
            const reset = await call('POST', '/api/auth/reset-password', { body: { token, new_password: 'An0ther-Pass-7y' } });
            assert.equal(reset.status, 200, reset.text);
            assert.equal((await signIn('olive@chambers.example.org', 'An0ther-Pass-7y')).status, 200);
        });

        it('a reset link made for a staff account before the switch is refused', async () => {
            await pool.query(
                `INSERT INTO operational_user (first_name, last_name, email, user_role, password_hash, must_change_password, auth_source)
                 VALUES ('Brea','Kglass','breakglass@dojcd.gov.za','Admin','hashed:Local-Secret-9!',false,'local')`
            );
            const crypto = require('crypto');
            await pool.query(
                `INSERT INTO password_reset_token (email, user_type, token_hash, expires_at)
                 VALUES ('breakglass@dojcd.gov.za','Operational',$1, NOW() + interval '1 hour')`,
                [crypto.createHash('sha256').update('old-token').digest('hex')]
            );
            const res = await call('POST', '/api/auth/reset-password', { body: { token: 'old-token', new_password: 'An0ther-Pass-7y' } });
            assert.equal(res.status, 400);
            assert.equal((await one(`SELECT password_hash FROM operational_user`)).password_hash, 'hashed:Local-Secret-9!');
        });

        it('a client can change their own password; an organisation account cannot', async () => {
            const reg = await register();
            const ok = await call('POST', '/api/auth/change-password', {
                token: reg.json.data.accessToken, body: { current_password: PASSWORD, new_password: 'An0ther-Pass-7y' },
            });
            assert.equal(ok.status, 200, ok.text);

            const org = await signIn('cclient', 'Correct-Horse-9');
            const refused = await call('POST', '/api/auth/change-password', {
                token: org.json.data.accessToken, body: { current_password: 'Correct-Horse-9', new_password: 'An0ther-Pass-7y' },
            });
            assert.notEqual(refused.status, 200);
            assert.match(refused.text, /managed by your organisation/);
        });
    });
});
