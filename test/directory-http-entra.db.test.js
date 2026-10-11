// End to end over HTTP for Microsoft Entra ID: the real Express app, a real PostgreSQL, and a mock Entra ID
// that signs real tokens. The test plays the browser. AUTH_PROVIDER=entra.
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
const { startMockEntra, person, TENANT, CLIENT_ID, SECRET, REDIRECT } = require('./helpers/mockEntra');

const ADMIN_PAGE  = 'https://admin.example.test/auth/callback';
const CLIENT_PAGE = 'https://client.example.test/auth/callback';
const ADMINS   = { id: 'a0a0a0a0-0000-4000-8000-000000000001', displayName: 'DOJCD-Admins' };
const MANAGERS = { id: 'b0b0b0b0-0000-4000-8000-000000000002', displayName: 'DOJCD-Managers' };

let idp, server, base, pool;

const call = async (method, urlPath, { body, token } = {}) => {
    const res = await fetch(`${base}${urlPath}`, {
        method, redirect: 'manual',
        headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (_) { /* not JSON */ }
    return { status: res.status, json, text, location: res.headers.get('location') };
};

// The browser: ask our API to start, "sign in at Microsoft", come back to the callback, swap the ticket.
async function browserSignIn(user, { audience = 'staff', redirect = ADMIN_PAGE, token = {} } = {}) {
    const start = await call('GET', `/api/auth/entra/login?audience=${audience}&redirect=${encodeURIComponent(redirect)}`);
    assert.equal(start.status, 302, start.text);
    const authorize = new URL(start.location);
    const q = Object.fromEntries(authorize.searchParams);

    const code = idp.issueCode(user, { nonce: q.nonce, challenge: q.code_challenge, ...token });
    const callback = await call('GET', `/api/auth/entra/callback?code=${code}&state=${encodeURIComponent(q.state)}`);
    return { start, authorize, q, callback, back: callback.location ? new URL(callback.location) : null };
}

const exchange = (ticket) => call('POST', '/api/auth/directory/exchange', { body: { ticket } });
const one = async (sql, params) => (await pool.query(sql, params)).rows[0];

describe('Microsoft Entra ID sign-in over HTTP (real PostgreSQL, mock Entra ID)', { skip: testDb.skip }, () => {
    before(async () => {
        await testDb.create();
        idp = await startMockEntra();

        Object.assign(process.env, {
            AUTH_PROVIDER: 'entra', ENTRA_TENANT_ID: TENANT, ENTRA_CLIENT_ID: CLIENT_ID, ENTRA_CLIENT_SECRET: SECRET,
            ENTRA_REDIRECT_URI: REDIRECT, ENTRA_AUTHORITY_HOST: idp.url, ENTRA_GRAPH_HOST: idp.url,
            AUTH_ALLOWED_REDIRECTS: `${ADMIN_PAGE},${CLIENT_PAGE}`,
            AD_GROUP_ADMIN: 'DOJCD-Admins', AD_GROUP_MANAGER: MANAGERS.id,
            SLA_ALERT_SCHEDULE: 'off', UPLOADS_DIR: path.join(os.tmpdir(), `dojcd-uploads-entra-${process.pid}`),
        });

        const app = require('../src/app');
        pool = require('../src/config/db');
        server = http.createServer(app);
        await new Promise((r) => server.listen(0, '127.0.0.1', r));
        base = `http://127.0.0.1:${server.address().port}`;
    });

    after(async () => {
        if (!testDb.enabled) return;
        await new Promise((r) => { server.closeAllConnections?.(); server.close(r); });
        await idp.close();
        await testDb.drop(pool);
    });

    beforeEach(async () => {
        idp.failGraph = false; idp.failGroups = false;
        await pool.query(`TRUNCATE operational_user, client_user RESTART IDENTITY CASCADE`);
        await pool.query(`TRUNCATE audit_log, login_attempt, refresh_token, directory_login_state, directory_login_ticket RESTART IDENTITY`);
    });

    it('tells the front-ends to show the Microsoft button', async () => {
        const res = await call('GET', '/api/auth/config');
        assert.equal(res.json.data.provider, 'entra');
        assert.equal(res.json.data.loginMethod, 'microsoft');
        assert.equal(res.json.data.selfRegistration, false);
        assert.ok(!JSON.stringify(res.json).includes(SECRET), 'no secret is ever served');
    });

    it('password endpoints point people to Microsoft sign-in', async () => {
        const res = await call('POST', '/api/auth/login-operational', { body: { email: 'a@b.co', password: 'x' } });
        assert.equal(res.status, 400);
        assert.equal(res.json.code, 'USE_MICROSOFT_SIGN_IN');
    });

    it('the whole staff sign-in: Microsoft, callback, ticket, tokens', async () => {
        const jane = person({ groups: [ADMINS] });
        const { start, authorize, q, back } = await browserSignIn(jane);

        assert.equal(authorize.origin, idp.url);
        assert.equal(q.code_challenge_method, 'S256');
        assert.equal(q.redirect_uri, REDIRECT);

        assert.equal(back.origin + back.pathname, ADMIN_PAGE, 'the person is sent back to the page that asked');
        const ticket = back.searchParams.get('ticket');
        assert.ok(ticket && !back.search.includes('access'), 'a one-time ticket, never tokens, travels in the URL');

        const session = await exchange(ticket);
        assert.equal(session.status, 200, session.text);
        const { user, accessToken, refreshToken } = session.json.data;
        assert.equal(user.user_role, 'Admin');
        assert.equal(user.email, 'jane.mokoena@dojcd.gov.za');
        assert.equal(user.auth_source, 'entra');
        assert.ok(refreshToken && !('external_id' in user) && !('password_hash' in user));
        assert.equal(jwt.verify(accessToken, process.env.JWT_SECRET).role, 'Admin');

        const list = await call('GET', '/api/admin/operational-users', { token: accessToken });
        assert.equal(list.status, 200);
        assert.equal(list.json.data.users.length, 1);
        assert.equal((await one(`SELECT count(*)::int AS n FROM login_attempt WHERE success`)).n, 1);
        assert.equal((await one(`SELECT count(*)::int AS n FROM directory_login_state`)).n, 0, 'the sign-in state is single use');
    });

    it('groups can be matched by object id as well as display name', async () => {
        const mo = person({ oid: 'cccccccc-0000-4000-8000-000000000003', upn: 'mo@x.test', mail: 'mo@dojcd.gov.za', givenName: 'Mo', groups: [MANAGERS] });
        const { back } = await browserSignIn(mo);
        const session = await exchange(back.searchParams.get('ticket'));
        assert.equal(session.json.data.user.user_role, 'Manager');
    });

    it('a ticket works once', async () => {
        const { back } = await browserSignIn(person({ groups: [ADMINS] }));
        const ticket = back.searchParams.get('ticket');
        assert.equal((await exchange(ticket)).status, 200);
        const replay = await exchange(ticket);
        assert.equal(replay.status, 401);
        assert.equal((await exchange('made-up')).status, 401);
        assert.equal((await exchange(undefined)).status, 401);
    });

    it('a ticket expires', async () => {
        const { back } = await browserSignIn(person({ groups: [ADMINS] }));
        await pool.query(`UPDATE directory_login_ticket SET expires_at = NOW() - interval '1 second'`);
        assert.equal((await exchange(back.searchParams.get('ticket'))).status, 401);
    });

    it('a callback cannot be replayed, forged, or used after it expired', async () => {
        const jane = person({ groups: [ADMINS] });
        const first = await browserSignIn(jane);
        assert.equal(first.callback.status, 302);

        const code = idp.issueCode(jane, { nonce: first.q.nonce, challenge: first.q.code_challenge });
        const replay = await call('GET', `/api/auth/entra/callback?code=${code}&state=${encodeURIComponent(first.q.state)}`);
        assert.equal(replay.status, 400, 'the state was consumed by the first callback');

        const forged = await call('GET', `/api/auth/entra/callback?code=${code}&state=forged`);
        assert.equal(forged.status, 400);
        assert.equal((await call('GET', '/api/auth/entra/callback?code=x')).status, 400, 'no state at all');

        const start = await call('GET', `/api/auth/entra/login?audience=staff&redirect=${encodeURIComponent(ADMIN_PAGE)}`);
        const q = Object.fromEntries(new URL(start.location).searchParams);
        await pool.query(`UPDATE directory_login_state SET expires_at = NOW() - interval '1 second'`);
        const late = await call('GET', `/api/auth/entra/callback?code=${idp.issueCode(jane, { nonce: q.nonce, challenge: q.code_challenge })}&state=${encodeURIComponent(q.state)}`);
        assert.equal(late.status, 400);
        assert.equal((await one(`SELECT count(*)::int AS n FROM operational_user`)).n, 1, 'only the first sign-in created an account');
    });

    it('refuses to send people anywhere that is not on the allow-list', async () => {
        for (const evil of ['https://evil.example.test/steal', 'https://admin.example.test.evil.test/auth/callback', 'javascript:alert(1)', 'not a url', '']) {
            const res = await call('GET', `/api/auth/entra/login?audience=staff&redirect=${encodeURIComponent(evil)}`);
            assert.equal(res.status, 400, evil);
            assert.equal(res.location, null, evil);
        }
        assert.equal((await call('GET', `/api/auth/entra/login?audience=nobody&redirect=${encodeURIComponent(ADMIN_PAGE)}`)).status, 400);
        assert.equal((await one(`SELECT count(*)::int AS n FROM directory_login_state`)).n, 0);
    });

    it('a person with no staff group goes back with an explanation and gets no ticket', async () => {
        const { back } = await browserSignIn(person({ groups: [] }));
        assert.equal(back.searchParams.get('ticket'), null);
        assert.equal(back.searchParams.get('error'), 'NO_STAFF_ACCESS');
        assert.match(back.searchParams.get('error_description'), /staff access/);
        assert.equal((await one(`SELECT count(*)::int AS n FROM operational_user`)).n, 0);
        assert.equal((await one(`SELECT count(*)::int AS n FROM login_attempt WHERE NOT success`)).n, 1);
    });

    it('the same person is welcome in the client portal', async () => {
        const { back } = await browserSignIn(person({ groups: [] }), { audience: 'client', redirect: CLIENT_PAGE });
        assert.equal(back.origin + back.pathname, CLIENT_PAGE);
        const session = await exchange(back.searchParams.get('ticket'));
        assert.equal(session.status, 200, session.text);
        assert.equal(session.json.data.user.registration_status, 'Pending');
        assert.equal(session.json.data.user.persal_id, '12345678');
        assert.equal(jwt.verify(session.json.data.accessToken, process.env.JWT_SECRET).userType, 'Client');
    });

    it('closing the Microsoft page or being refused by conditional access comes back as a clear message', async () => {
        const start = await call('GET', `/api/auth/entra/login?audience=staff&redirect=${encodeURIComponent(ADMIN_PAGE)}`);
        const state = new URL(start.location).searchParams.get('state');
        const cancelled = await call('GET', `/api/auth/entra/callback?error=access_denied&error_description=AADSTS65004&state=${encodeURIComponent(state)}`);
        assert.equal(cancelled.status, 302);
        const back = new URL(cancelled.location);
        assert.equal(back.searchParams.get('error'), 'SIGN_IN_CANCELLED');
        assert.equal(back.searchParams.get('ticket'), null);
    });

    it('an ID token that fails verification never produces a ticket or an account', async () => {
        for (const token of [{ aud: 'other-app' }, { expired: true }, { signWith: 'rogue' }, { nonce: 'attacker' }]) {
            const { back } = await browserSignIn(person({ groups: [ADMINS] }), { token });
            assert.equal(back.searchParams.get('ticket'), null, JSON.stringify(token));
            assert.equal(back.searchParams.get('error'), 'INVALID_CREDENTIALS', JSON.stringify(token));
        }
        assert.equal((await one(`SELECT count(*)::int AS n FROM operational_user`)).n, 0);
    });

    it('a Microsoft outage is reported as an outage, and nobody is signed in', async () => {
        idp.failGroups = true;
        const { back } = await browserSignIn(person({ groups: [ADMINS] }));
        assert.equal(back.searchParams.get('error'), 'DIRECTORY_UNAVAILABLE');
        assert.equal(back.searchParams.get('ticket'), null);
        assert.equal((await one(`SELECT count(*)::int AS n FROM login_attempt WHERE NOT success`)).n, 0, 'an outage is not a failed password');
    });

    it('a ticket is not honoured if the account was switched off in the meantime', async () => {
        const { back } = await browserSignIn(person({ groups: [ADMINS] }));
        await pool.query(`UPDATE operational_user SET is_deleted = true`);
        const res = await exchange(back.searchParams.get('ticket'));
        assert.equal(res.status, 403);
        assert.equal(res.json.code, 'ACCOUNT_DEACTIVATED');
    });

    it('sync reads the staff groups from Microsoft Graph', async () => {
        const admin = await (async () => {
            const { back } = await browserSignIn(person({ groups: [ADMINS] }));
            return (await exchange(back.searchParams.get('ticket'))).json.data.accessToken;
        })();

        const managers = ['one', 'two', 'three'].map((n, i) => person({ oid: `dddddddd-0000-4000-8000-00000000000${i}`, upn: `${n}@x.test`, mail: `${n}@dojcd.gov.za`, givenName: n, surname: 'Manager', employeeId: `9000000${i}` }));
        idp.groupMembers[MANAGERS.id] = { id: MANAGERS.id, displayName: MANAGERS.displayName, members: managers };
        idp.groupMembers[ADMINS.id]   = { id: ADMINS.id, displayName: ADMINS.displayName, members: [person({ groups: [ADMINS] })] };

        const run = await call('POST', '/api/admin/directory/sync', { token: admin });
        assert.equal(run.status, 200, run.text);
        assert.equal(run.json.data.created, 3);
        const roles = (await pool.query(`SELECT user_role, count(*)::int AS n FROM operational_user GROUP BY user_role ORDER BY 1`)).rows;
        assert.deepEqual(roles, [{ user_role: 'Admin', n: 1 }, { user_role: 'Manager', n: 3 }]);
    });
});
