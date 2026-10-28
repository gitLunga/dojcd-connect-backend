// The directory sync for CLIENTS, end to end over HTTP: the real Express app, a real PostgreSQL and a mock Active
// Directory. AUTH_PROVIDER=ldap. Skipped unless TEST_PG_HOST is set (see test/helpers/testDb.js).

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const { useTestDatabase } = require('./helpers/testDb');
const testDb = useTestDatabase();
const { stubBcrypt } = require('./helpers/stubs');
stubBcrypt();
const { startMockAd, user, BASE, SERVICE_DN } = require('./helpers/mockAd');

let ad, server, base, pool, mailed, dir;

const guid = (n) => `bbbbbbbb-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`;
const people = () => {
    const admin   = user({ given: 'Ada',    sn: 'Admin',      sam: 'aadmin',    guid: guid(1), employeeId: '20000001' });
    const manager = user({ given: 'Mo',     sn: 'Manager',    sam: 'mmanager',  guid: guid(2), employeeId: '20000002' });
    const cara    = user({ given: 'Cara',   sn: 'Client',     sam: 'cclient',   guid: guid(3), employeeId: '20000003', department: 'Gauteng', mobile: '0821110000' });
    const dev     = user({ given: 'Dev',    sn: 'Advocate',   sam: 'dadvocate', guid: guid(4), employeeId: '20000004', department: 'Western Cape' });
    const judge   = user({ given: 'Maggie', sn: 'Judge',      sam: 'mjudge',    guid: guid(5), employeeId: '20000005', department: 'Gauteng' });
    const gone    = user({ given: 'Dan',    sn: 'Disabled',   sam: 'ddisabled', guid: guid(6), uac: '514' });
    const printer = user({ given: 'Print',  sn: 'Service',    sam: 'svc-print', guid: guid(7), mail: undefined, upn: undefined });
    const group = (cn, members) => ({ dn: `CN=${cn},OU=Groups,${BASE}`, cn, members: members.map((m) => m.dn) });
    return {
        users: [admin, manager, cara, dev, judge, gone, printer],
        groups: [group('DOJCD-Admins', [admin]), group('DOJCD-Managers', [manager]), group('DOJCD-Magistrates', [judge]), group('DOJCD-Clients', [cara, judge])],
        admin, manager, cara, dev, judge,
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
const login = (who, audience = 'staff') =>
    call('POST', audience === 'staff' ? '/api/auth/login-operational' : '/api/auth/login-client', { body: { email: who, password: 'Correct-Horse-9' } });
const one = async (sql, params) => (await pool.query(sql, params)).rows[0];
const clients = async () => (await pool.query(`SELECT * FROM client_user ORDER BY email`)).rows;
const useConfig = (env) => {
    for (const k of ['AD_GROUP_CLIENTS', 'LDAP_SYNC_FILTER', 'LDAP_SYNC_BASE_DN']) delete process.env[k];
    Object.assign(process.env, env);
    require('../src/directory/config').resetDirectoryConfigCache();
    require('../src/directory').resetDirectoryAuth();
};

describe('syncing clients from Active Directory (real PostgreSQL, mock AD)', { skip: testDb.skip }, () => {
    let adminToken;

    before(async () => {
        await testDb.create();
        dir = people();
        ad = await startMockAd(dir);

        Object.assign(process.env, {
            AUTH_PROVIDER: 'ldap', LDAP_URL: ad.url, LDAP_ALLOW_INSECURE: 'true', LDAP_TIMEOUT_MS: '3000',
            LDAP_BIND_DN: SERVICE_DN, LDAP_BIND_PASSWORD: 'service-secret', LDAP_BASE_DN: BASE,
            AD_GROUP_ADMIN: 'DOJCD-Admins', AD_GROUP_MANAGER: 'DOJCD-Managers', AD_GROUP_MAGISTRATES: 'DOJCD-Magistrates',
            SLA_ALERT_SCHEDULE: 'off', UPLOADS_DIR: path.join(os.tmpdir(), `dojcd-uploads-clientsync-${process.pid}`),
        });
        delete process.env.AUTH_ALLOW_LOCAL_ADMIN_LOGIN;

        const app = require('../src/app');
        pool = require('../src/config/db');
        server = http.createServer(app);
        await new Promise((r) => server.listen(0, '127.0.0.1', r));
        base = `http://127.0.0.1:${server.address().port}`;

        // Welcome emails would be sent for every person; record them instead of sending.
        require('../src/services/emailService').sendWelcomeClient = async (to) => { mailed.push(to); };
    });

    after(async () => {
        if (!testDb.enabled) return;
        await new Promise((r) => { server.closeAllConnections?.(); server.close(r); });
        await ad.close();
        await testDb.drop(pool);
    });

    beforeEach(async () => {
        mailed = [];
        useConfig({});
        await pool.query(`TRUNCATE operational_user, client_user RESTART IDENTITY CASCADE`);
        await pool.query(`TRUNCATE audit_log, login_attempt, refresh_token RESTART IDENTITY`);
        adminToken = (await login('aadmin')).json.data.accessToken;
    });

    const sync = (query = '') => call('POST', `/api/admin/directory/sync${query}`, { token: adminToken });

    it('a dry run says what an import of everyone would do and changes nothing', async () => {
        const res = await sync('?scope=clients&dryRun=true');
        assert.equal(res.status, 200, res.text);
        const c = res.json.data.clients;
        assert.equal(c.source, 'everyone');
        // cclient, dadvocate, mjudge. Not the two staff, not the disabled person, not the account with no email.
        assert.deepEqual({ created: c.created, linked: c.linked, updated: c.updated, skippedStaff: c.skippedStaff }, { created: 3, linked: 0, updated: 0, skippedStaff: 2 });
        assert.equal((await clients()).length, 0);
        assert.equal(res.json.data.dryRun, true);
    });

    it('imports everyone else as unverified clients, with what the directory knows about them', async () => {
        const res = await sync('?scope=clients');
        assert.equal(res.status, 200, res.text);
        assert.equal(res.json.data.clients.created, 3);
        assert.deepEqual(res.json.data.errors, []);

        const rows = await clients();
        assert.deepEqual(rows.map((r) => r.email), ['cclient@dojcd.gov.za', 'dadvocate@dojcd.gov.za', 'mjudge@dojcd.gov.za']);
        const cara = rows[0];
        assert.equal(cara.registration_status, 'Pending');
        assert.equal(cara.auth_source, 'ldap');
        assert.equal(cara.password_hash, null);
        assert.equal(cara.persal_id, '20000003');
        assert.equal(cara.user_type, 'Advocate');
        assert.equal(cara.phone_number, '0821110000');
        assert.equal(rows[2].user_type, 'Magistrate', 'the magistrates group decides the type');

        const audited = (await pool.query(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'DIRECTORY_CLIENT_PROVISIONED'`)).rows[0].n;
        assert.equal(audited, 3);
    });

    it('sends no welcome email for an imported person', async () => {
        await sync('?scope=clients');
        assert.deepEqual(mailed, []);
    });

    it('running it again updates people and never duplicates them', async () => {
        await sync('?scope=clients');
        const again = await sync('?scope=clients');
        assert.deepEqual({ created: again.json.data.clients.created, updated: again.json.data.clients.updated }, { created: 0, updated: 3 });
        assert.equal((await clients()).length, 3);
    });

    it('the person who then signs in to the client portal is the account the sync made', async () => {
        await sync('?scope=clients');
        const before = await one(`SELECT client_user_id FROM client_user WHERE email = 'cclient@dojcd.gov.za'`);
        const res = await login('cclient', 'client');
        assert.equal(res.status, 200, res.text);
        assert.equal(res.json.data.user.client_user_id, before.client_user_id);
        assert.equal((await clients()).length, 3);
    });

    it('links a client who had registered with a password, keeping their verification', async () => {
        await pool.query(
            `INSERT INTO client_user (first_name, last_name, email, user_type, password_hash, registration_status)
             VALUES ('Cara','Old','CClient@dojcd.gov.za','Magistrate','hashed:Local-Secret-9!','Verified')`
        );
        const res = await sync('?scope=clients');
        assert.equal(res.json.data.clients.linked, 1);
        assert.equal(res.json.data.clients.created, 2);
        const row = await one(`SELECT * FROM client_user WHERE lower(email) = 'cclient@dojcd.gov.za'`);
        assert.equal(row.registration_status, 'Verified');
        assert.equal(row.auth_source, 'ldap');
        assert.equal(row.password_hash, null, 'the old password stops working');
        assert.equal((await clients()).length, 3);
    });

    it('leaves a deactivated client alone', async () => {
        await sync('?scope=clients');
        await pool.query(`UPDATE client_user SET registration_status = 'Deactivated', first_name = 'Frozen' WHERE email = 'cclient@dojcd.gov.za'`);
        const res = await sync('?scope=clients');
        assert.equal(res.json.data.clients.skippedDeactivated, 1);
        assert.equal((await one(`SELECT first_name FROM client_user WHERE email = 'cclient@dojcd.gov.za'`)).first_name, 'Frozen');
    });

    it('reports an email that already belongs to a different directory account instead of taking it over', async () => {
        await pool.query(
            `INSERT INTO client_user (first_name, last_name, email, user_type, auth_source, external_id, registration_status)
             VALUES ('Someone','Else','cclient@dojcd.gov.za','Advocate','ldap','cccccccc-0000-4000-8000-000000000001','Verified')`
        );
        const res = await sync('?scope=clients');
        assert.equal(res.json.data.errors.length, 1);
        assert.match(res.json.data.errors[0].message, /different directory account/);
        assert.equal((await one(`SELECT external_id FROM client_user WHERE email = 'cclient@dojcd.gov.za'`)).external_id, 'cccccccc-0000-4000-8000-000000000001');
        assert.equal(res.json.data.clients.created, 2);
    });

    it('without a scope it still does only what it did before: staff, and no clients unless a clients group is set', async () => {
        const res = await sync();
        assert.equal(res.status, 200, res.text);
        assert.equal(res.json.data.clients, null);
        assert.equal((await clients()).length, 0);
        assert.equal((await one(`SELECT count(*)::int AS n FROM operational_user`)).n, 2, 'the Manager arrives');
    });

    it('scope=staff leaves clients alone, scope=clients leaves staff alone, scope=all does both', async () => {
        const staffOnly = await sync('?scope=staff');
        assert.equal(staffOnly.json.data.clients, null);
        assert.equal((await clients()).length, 0);
        await pool.query(`TRUNCATE operational_user RESTART IDENTITY CASCADE`);
        adminToken = (await login('aadmin')).json.data.accessToken;

        await sync('?scope=clients');
        assert.equal((await one(`SELECT count(*)::int AS n FROM operational_user`)).n, 1, 'the Manager is not created by a client sync');
        assert.equal((await clients()).length, 3);

        const all = await sync('?scope=all');
        assert.equal(all.json.data.created, 1);
        assert.equal(all.json.data.clients.updated, 3);
    });

    it('refuses a scope it does not know', async () => {
        const res = await sync('?scope=everything');
        assert.equal(res.status, 400);
        assert.match(res.json.message, /scope must be one of/);
    });

    it('with a clients group, only its members are imported, and the plain sync does it too', async () => {
        useConfig({ AD_GROUP_CLIENTS: 'DOJCD-Clients' });
        const res = await sync();
        assert.equal(res.status, 200, res.text);
        assert.equal(res.json.data.clients.source, 'clients group');
        assert.deepEqual((await clients()).map((r) => r.email), ['cclient@dojcd.gov.za', 'mjudge@dojcd.gov.za']);
        assert.equal((await one(`SELECT user_type FROM client_user WHERE email = 'mjudge@dojcd.gov.za'`)).user_type, 'Magistrate');
    });

    it('LDAP_SYNC_FILTER narrows who is imported', async () => {
        useConfig({ LDAP_SYNC_FILTER: '(department=Gauteng)' });
        const res = await sync('?scope=clients');
        assert.equal(res.status, 200, res.text);
        assert.deepEqual((await clients()).map((r) => r.email), ['cclient@dojcd.gov.za', 'mjudge@dojcd.gov.za']);
        assert.ok(ad.searches.some((f) => f.includes('(department=Gauteng)')));
    });

    it('only an Admin may import', async () => {
        const manager = (await login('mmanager')).json.data.accessToken;
        assert.equal((await call('POST', '/api/admin/directory/sync?scope=clients', { token: manager })).status, 403);
    });
});
