// A token for an account that still has a temporary password may only change it or sign out.
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

process.env.JWT_SECRET = 'test-secret-only-for-unit-tests-0123456789';
process.env.NODE_ENV   = 'test';

const { stubModule, fakeDb } = require('./helpers/stubs');
stubModule('config/db.js', fakeDb());

const express      = require('express');
const jwt          = require('jsonwebtoken');
const authenticate = require('../src/middleware/authenticate');

const sign = (claims, opts) => jwt.sign(claims, process.env.JWT_SECRET, { expiresIn: '15m', ...opts });
const tempPasswordToken = sign({ userId: 5, userType: 'Operational', role: 'Admin', mustChangePassword: true });
const normalToken       = sign({ userId: 5, userType: 'Operational', role: 'Admin', mustChangePassword: false });

let server, base;
before(async () => {
    const app = express();
    const ok = (req, res) => res.json({ ok: true, userId: req.user.userId });
    app.post('/api/auth/change-password', authenticate, ok);
    app.post('/api/auth/logout', authenticate, ok);
    app.get('/api/admin/all-users', authenticate, ok);
    app.get('/api/notifications/user', authenticate, ok);
    await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
    base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const call = (path, token, method = 'GET') =>
    fetch(base + path, { method, headers: token ? { Authorization: `Bearer ${token}` } : {} });

describe('authenticate — pending password change', () => {
    it('blocks everything except change-password and logout', async () => {
        for (const path of ['/api/admin/all-users', '/api/notifications/user']) {
            const res = await call(path, tempPasswordToken);
            assert.equal(res.status, 403, path);
            const body = await res.json();
            assert.equal(body.code, 'PASSWORD_CHANGE_REQUIRED');
            assert.match(body.message, /change your temporary password/i);
        }
    });

    it('still lets the user change the password or sign out', async () => {
        assert.equal((await call('/api/auth/change-password', tempPasswordToken, 'POST')).status, 200);
        assert.equal((await call('/api/auth/change-password/?x=1', tempPasswordToken, 'POST')).status, 200);
        assert.equal((await call('/api/auth/logout', tempPasswordToken, 'POST')).status, 200);
    });

    it('does not let look-alike paths through', async () => {
        const app = express();
        app.use((req, res, next) => authenticate(req, res, next));
        app.use((req, res) => res.json({ reached: true }));
        const s = await new Promise((r) => { const x = app.listen(0, '127.0.0.1', () => r(x)); });
        try {
            const b = `http://127.0.0.1:${s.address().port}`;
            for (const p of ['/api/auth/change-password/../admin/all-users', '/api/auth/change-password%2F..%2Fadmin', '//api/auth/change-password', '/api/auth/change-passwordX']) {
                const r = await fetch(b + p, { headers: { Authorization: `Bearer ${tempPasswordToken}` }, redirect: 'manual' });
                assert.notEqual((await r.json().catch(() => ({}))).reached, true, p);
            }
        } finally { s.close(); }
    });
});

describe('authenticate — everything else is unchanged', () => {
    it('lets a normal token through', async () => {
        const res = await call('/api/admin/all-users', normalToken);
        assert.equal(res.status, 200);
        assert.equal((await res.json()).userId, 5);
    });

    it('lets a token with no flag at all through (clients, older tokens)', async () => {
        const res = await call('/api/notifications/user', sign({ userId: 3, userType: 'Client' }));
        assert.equal(res.status, 200);
    });

    it('still returns 401 for missing, invalid and expired tokens', async () => {
        assert.equal((await call('/api/admin/all-users')).status, 401);
        assert.equal((await call('/api/admin/all-users', 'garbage')).status, 401);
        const expired = (await call('/api/admin/all-users', sign({ userId: 1 }, { expiresIn: -10 })));
        assert.equal(expired.status, 401);
        assert.match((await expired.json()).message, /expired/i);
    });
});
