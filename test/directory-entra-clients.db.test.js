// Microsoft Entra ID: importing clients from the directory, and clients who register with a password next to the
// Microsoft button. Real Express app, real PostgreSQL, mock Entra ID (AUTH_PROVIDER=entra).
// Skipped unless TEST_PG_HOST is set (see test/helpers/testDb.js).

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const { useTestDatabase } = require('./helpers/testDb');
const testDb = useTestDatabase();
const { stubBcrypt } = require('./helpers/stubs');
stubBcrypt();
const { startMockEntra, person, TENANT, CLIENT_ID, SECRET, REDIRECT } = require('./helpers/mockEntra');

const ADMINS     = { id: 'a0a0a0a0-0000-4000-8000-000000000001', displayName: 'DOJCD-Admins' };
const MAGISTRATE = { id: 'e0e0e0e0-0000-4000-8000-000000000005', displayName: 'DOJCD-Magistrates' };
const oid = (n) => `eeeeeeee-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`;
const ADMIN_PAGE = 'https://admin.example.test/auth/callback';

let idp, server, base, pool, mailed;

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
const clients = async () => (await pool.query(`SELECT * FROM client_user ORDER BY email`)).rows;
const member = (n, over = {}) => person({
    oid: oid(n), upn: `user${n}@dojcd.onmicrosoft.com`, mail: `user${n}@dojcd.gov.za`, givenName: `User${n}`, surname: 'Test',
    displayName: `User${n} Test`, employeeId: `4000000${n}`, department: 'DoJ&CD Gauteng', ...over,
});
const useConfig = (env = {}) => {
    delete process.env.AUTH_ALLOW_CLIENT_REGISTRATION;
    Object.assign(process.env, env);
    require('../src/directory/config').resetDirectoryConfigCache();
    require('../src/directory').resetDirectoryAuth();
};

describe('Entra ID: importing clients, and clients with their own password', { skip: testDb.skip }, () => {
    let adminToken;

    before(async () => {
        await testDb.create();
        idp = await startMockEntra();

        Object.assign(process.env, {
            AUTH_PROVIDER: 'entra', ENTRA_TENANT_ID: TENANT, ENTRA_CLIENT_ID: CLIENT_ID, ENTRA_CLIENT_SECRET: SECRET,
            ENTRA_REDIRECT_URI: REDIRECT, ENTRA_AUTHORITY_HOST: idp.url, ENTRA_GRAPH_HOST: idp.url,
            AUTH_ALLOWED_REDIRECTS: ADMIN_PAGE, AUTH_MAX_FAILED_LOGINS: '3',
            AD_GROUP_ADMIN: ADMINS.displayName, AD_GROUP_MAGISTRATES: MAGISTRATE.displayName,
            SLA_ALERT_SCHEDULE: 'off', UPLOADS_DIR: path.join(os.tmpdir(), `dojcd-uploads-entra-clients-${process.pid}`),
        });

        const app = require('../src/app');
        pool = require('../src/config/db');
        server = http.createServer(app);
        await new Promise((r) => server.listen(0, '127.0.0.1', r));
        base = `http://127.0.0.1:${server.address().port}`;

        const mail = require('../src/services/emailService');
        mail.sendWelcomeClient = async (to) => { mailed.push(to); };
        mail.sendPasswordChanged = async () => {};
    });

    after(async () => {
        if (!testDb.enabled) return;
        await new Promise((r) => { server.closeAllConnections?.(); server.close(r); });
        await idp.close();
        await testDb.drop(pool);
    });

    beforeEach(async () => {
        mailed = [];
        useConfig();
        idp.failGraph = false;
        idp.userQueries.length = 0;
        const staff = member(1);
        const judge = member(5);
        idp.users = [
            staff, member(2), member(3), judge,
            member(6, { userType: 'Guest' }),
            member(7, { accountEnabled: false }),
        ];
        idp.groupMembers = {
            [ADMINS.id]:     { id: ADMINS.id, displayName: ADMINS.displayName, members: [staff] },
            [MAGISTRATE.id]: { id: MAGISTRATE.id, displayName: MAGISTRATE.displayName, members: [judge] },
        };
        await pool.query(`TRUNCATE operational_user, client_user RESTART IDENTITY CASCADE`);
        await pool.query(`TRUNCATE audit_log, login_attempt, refresh_token, directory_login_state, directory_login_ticket RESTART IDENTITY`);

        // An Admin to call the API with.
        const admin = await one(
            `INSERT INTO operational_user (first_name, last_name, email, user_role, password_hash, must_change_password, auth_source, is_super_admin)
             VALUES ('Root','Admin','root@dojcd.gov.za','Admin','hashed:x',false,'local',true) RETURNING op_user_id`
        );
        adminToken = require('../src/services/tokenService').generateAccessToken(admin.op_user_id, 'Operational', 'Admin', null, false, false);
    });

    describe('importing clients', () => {
        const sync = (query = '?scope=clients') => call('POST', `/api/admin/directory/sync${query}`, { token: adminToken });

        it('a dry run reports the people it would import and changes nothing', async () => {
            const res = await sync('?scope=clients&dryRun=true');
            assert.equal(res.status, 200, res.text);
            const c = res.json.data.clients;
            // User2, User3, User5 (a magistrate). Not User1 (an Admin), not the guest, not the disabled account.
            assert.deepEqual({ created: c.created, skippedStaff: c.skippedStaff, found: c.found }, { created: 3, skippedStaff: 1, found: 4 });
            assert.equal((await clients()).length, 0);
        });

        it('imports members as unverified clients, with magistrates recognised, across several pages', async () => {
            const res = await sync();
            assert.equal(res.status, 200, res.text);
            assert.deepEqual(res.json.data.errors, []);
            const rows = await clients();
            assert.deepEqual(rows.map((r) => r.email), ['user2@dojcd.gov.za', 'user3@dojcd.gov.za', 'user5@dojcd.gov.za']);
            assert.ok(rows.every((r) => r.auth_source === 'entra' && r.registration_status === 'Pending' && r.password_hash === null));
            assert.deepEqual(rows.map((r) => r.user_type), ['Advocate', 'Advocate', 'Magistrate']);
            assert.deepEqual(mailed, [], 'no welcome email for an import');
        });

        it('asks Graph only for enabled accounts, and leaves guests out', async () => {
            await sync();
            assert.ok(idp.userQueries.some((f) => f === 'accountEnabled eq true'));
            assert.ok(!(await clients()).some((r) => r.email === 'user6@dojcd.gov.za'));
        });

        it('running it again updates and never duplicates', async () => {
            await sync();
            const again = await sync();
            assert.deepEqual({ created: again.json.data.clients.created, updated: again.json.data.clients.updated }, { created: 0, updated: 3 });
            assert.equal((await clients()).length, 3);
        });
    });

    describe('clients with their own password, next to the Microsoft button', () => {
        const PASSWORD = 'Str0ng-Pass-9x';
        const body = (over = {}) => ({
            first_name: 'Olive', last_name: 'Outside', email: 'olive@chambers.example.org', phone_number: '0821234567',
            persal_id: '55500001', user_type: 'Advocate', password: PASSWORD, ...over,
        });

        it('is switched off by default: Microsoft only, and registration is closed', async () => {
            const cfg = (await call('GET', '/api/auth/config')).json.data;
            assert.equal(cfg.clientRegistration, false);
            assert.equal((await call('POST', '/api/auth/login-client', { body: { email: 'a@b.co', password: 'x' } })).json.code, 'USE_MICROSOFT_SIGN_IN');
            assert.equal((await call('POST', '/api/auth/register', { body: body() })).status, 403);
        });

        it('when on: an outsider registers and signs in with the form, staff still only use Microsoft', async () => {
            useConfig({ AUTH_ALLOW_CLIENT_REGISTRATION: 'true' });
            const cfg = (await call('GET', '/api/auth/config')).json.data;
            assert.deepEqual({ r: cfg.clientRegistration, m: cfg.loginMethod }, { r: true, m: 'microsoft' });

            const reg = await call('POST', '/api/auth/register', { body: body() });
            assert.equal(reg.status, 201, reg.text);

            const ok = await call('POST', '/api/auth/login-client', { body: { email: 'olive@chambers.example.org', password: PASSWORD } });
            assert.equal(ok.status, 200, ok.text);

            const bad = await call('POST', '/api/auth/login-client', { body: { email: 'olive@chambers.example.org', password: 'nope' } });
            assert.equal(bad.status, 401);
            assert.match(bad.json.message, /Sign in with Microsoft/);

            const staff = await call('POST', '/api/auth/login-operational', { body: { email: 'olive@chambers.example.org', password: PASSWORD } });
            assert.equal(staff.status, 400);
            assert.equal(staff.json.code, 'USE_MICROSOFT_SIGN_IN');
        });

        it('an address that exists in Microsoft cannot be registered with a password', async () => {
            useConfig({ AUTH_ALLOW_CLIENT_REGISTRATION: 'true' });
            for (const email of ['user2@dojcd.gov.za', 'USER3@dojcd.onmicrosoft.com']) {
                const res = await call('POST', '/api/auth/register', { body: body({ email, persal_id: `6${Math.random().toString().slice(2, 9)}` }) });
                assert.equal(res.status, 409, res.text);
                assert.equal(res.json.code, 'USE_DIRECTORY_SIGN_IN');
            }
            assert.equal((await clients()).length, 0);
        });

        it('quotes in the address are escaped before they reach the Graph filter', async () => {
            useConfig({ AUTH_ALLOW_CLIENT_REGISTRATION: 'true' });
            await call('POST', '/api/auth/register', { body: body({ email: "o'brien@chambers.example.org" }) });
            assert.ok(idp.userQueries.some((f) => f.includes("mail eq 'o''brien@chambers.example.org'")), idp.userQueries.join(' | '));
        });

        it('registration waits when Microsoft cannot be asked', async () => {
            useConfig({ AUTH_ALLOW_CLIENT_REGISTRATION: 'true' });
            idp.failGraph = true;
            const res = await call('POST', '/api/auth/register', { body: body() });
            assert.equal(res.status, 503, res.text);
            assert.equal(res.json.code, 'REGISTRATION_UNAVAILABLE');
            assert.equal((await clients()).length, 0);
        });
    });
});
