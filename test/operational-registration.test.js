// Staff accounts must only ever come from an Admin (or the create-admin script).
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

process.env.JWT_SECRET = 'test-secret-only-for-unit-tests-0123456789';
process.env.NODE_ENV   = 'test';

const { stubModule, stubBcrypt, fakeDb } = require('./helpers/stubs');
const db = fakeDb();
stubModule('config/db.js', db);
stubModule('services/emailService.js', {
    sendOperationalUserWelcome: async () => {},
    sendWelcomeClient: async () => {},
    sendProfileUnderReview: async () => {},
    sendPasswordChanged: async () => {},
    sendPasswordResetRequest: async () => {},
});
stubBcrypt();

const express        = require('express');
const authRoutes     = require('../src/routes/authRoutes');
const authService    = require('../src/services/authService');
const authController = require('../src/controllers/authController');
const adminService   = require('../src/services/adminService');
const passwordPolicy = require('../src/utils/passwordPolicy');
const { parseAdminArgs, createAdmin } = require('../src/scripts/create-admin');
const { generateTempPassword }        = require('../src/utils/tempPassword');

describe('public operational registration is gone', () => {
    let base, server;
    before(async () => {
        const app = express();
        app.use(express.json());
        app.use('/api/auth', authRoutes);
        await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
        base = `http://127.0.0.1:${server.address().port}`;
    });
    after(() => server.close());

    it('has no route for it and creates nothing, even when asking for the Admin role', async () => {
        db.reset();
        const res = await fetch(`${base}/api/auth/register-operational`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                first_name: 'Eve', last_name: 'Intruder', email: 'eve@evil.test',
                user_role: 'Admin', password: 'Sup3r$ecret!',
            }),
        });
        assert.equal(res.status, 404);
        assert.equal(db.log.length, 0, 'no database work should have happened');
    });

    it('no longer exposes the controller / service entry points', () => {
        assert.equal(authController.registerOperational, undefined);
        assert.equal(authService.registerOperationalUser, undefined);
    });

    it('client self-registration is untouched', () => {
        const paths = authRoutes.stack.filter((l) => l.route).map((l) => l.route.path);
        assert.ok(paths.includes('/register'));
        assert.ok(!paths.includes('/register-operational'));
    });
});

describe('adminService.createOperationalUser', () => {
    const input = { first_name: 'Jane', last_name: 'Doe', email: ' Jane.Doe@DOJCD.gov.za ', user_role: 'Manager', department_id: 'DoJ&CD Gauteng' };

    it('creates the account with a random temporary password that must be changed', async () => {
        const d = db;
        d.reset((sql) => {
            if (/INSERT INTO operational_user/.test(sql)) return { rows: [{ op_user_id: 42, first_name: 'Jane', last_name: 'Doe', email: 'jane.doe@dojcd.gov.za', user_role: 'Manager', department_id: 'DoJ&CD Gauteng' }] };
        });

        const { user, defaultPassword } = await adminService.createOperationalUser(input, 7);
        const insert = d.log.find((q) => /INSERT INTO operational_user/.test(q.sql));
        assert.ok(insert, 'inserted a user');

        // forced password change
        assert.match(insert.sql, /must_change_password/);
        assert.match(insert.sql, /VALUES \(\$1, \$2, \$3, \$4, \$5, \$6, \$7, true\)/);

        // not the old guessable "<first><last>#123"
        assert.notEqual(defaultPassword, 'janedoe#123');
        assert.doesNotMatch(defaultPassword.toLowerCase(), /janedoe/);
        assert.ok(passwordPolicy.validate(defaultPassword).valid);

        // what was stored is a hash of what the admin is shown, and the email is normalised
        assert.equal(insert.params[6], `hashed:${defaultPassword}`);
        assert.equal(insert.params[3], 'jane.doe@dojcd.gov.za');
        assert.equal(user.op_user_id, 42);
    });

    it('records who created the account in the audit log, atomically', async () => {
        const d = db;
        d.reset((sql) => /INSERT INTO operational_user/.test(sql)
            ? { rows: [{ op_user_id: 42, first_name: 'Jane', last_name: 'Doe', email: 'j@d.za', user_role: 'Manager', department_id: null }] } : undefined);

        await adminService.createOperationalUser(input, 7);
        const sqls = d.log.map((q) => q.sql);
        const audit = d.log.find((q) => /INSERT INTO audit_log/.test(q.sql));
        assert.ok(audit, 'audit entry written');
        assert.equal(audit.params[0], 7);                         // actor = the Admin who did it
        assert.equal(audit.params[1], 'Operational');
        assert.equal(audit.params[2], 'OPERATIONAL_USER_CREATED');
        assert.equal(audit.params[4], 42);
        assert.equal(sqls[0], 'BEGIN');
        assert.equal(sqls.at(-1), 'COMMIT');
        assert.ok(sqls.indexOf('COMMIT') > sqls.findIndex((s) => /INSERT INTO audit_log/.test(s)));
    });

    it('rolls back, releases the connection and reports duplicates cleanly', async () => {
        const d = db;
        d.reset((sql) => /SELECT op_user_id FROM operational_user/.test(sql) ? { rows: [{ op_user_id: 9 }] } : undefined);

        await assert.rejects(() => adminService.createOperationalUser(input, 7), /already exists/);
        assert.ok(d.log.some((q) => q.sql === 'ROLLBACK'));
        assert.ok(!d.log.some((q) => /INSERT INTO operational_user/.test(q.sql)));
        assert.equal(d.released.count, 1);
    });
});

describe('create-admin script', () => {
    it('parses flags or environment variables and validates them', () => {
        assert.deepEqual(
            parseAdminArgs(['--email', ' Jane@DOJCD.gov.za ', '--first-name', 'Jane', '--last-name', 'Doe']),
            { email: 'jane@dojcd.gov.za', firstName: 'Jane', lastName: 'Doe' }
        );
        assert.deepEqual(
            parseAdminArgs([], { ADMIN_EMAIL: 'a@b.co', ADMIN_FIRST_NAME: 'A', ADMIN_LAST_NAME: 'B' }),
            { email: 'a@b.co', firstName: 'A', lastName: 'B' }
        );
        assert.throws(() => parseAdminArgs([], {}), /Usage/);
        assert.throws(() => parseAdminArgs(['--email', 'nope', '--first-name', 'A', '--last-name', 'B']), /not a valid email/);
    });

    it('inserts a forced-change Admin and audits it', async () => {
        const d = fakeDb((sql) => /INSERT INTO operational_user/.test(sql) ? { rows: [{ op_user_id: 1 }] } : undefined);
        const bcrypt = { hash: async (p) => `hashed:${p}` };
        const auditService = { log: async (client, entry) => client.query('AUDIT', [entry]) };

        const { opUserId, tempPassword } = await createAdmin(
            { email: 'first@dojcd.gov.za', firstName: 'First', lastName: 'Admin' },
            { db: d, bcrypt, generateTempPassword, auditService }
        );
        const insert = d.log.find((q) => /INSERT INTO operational_user/.test(q.sql));
        assert.equal(opUserId, 1);
        assert.match(insert.sql, /'Admin', \$4, true, true/);
        assert.equal(insert.params[3], `hashed:${tempPassword}`);
        assert.equal(d.log.find((q) => q.sql === 'AUDIT').params[0].actorType, 'System');
    });

    it('refuses to overwrite an existing account', async () => {
        const d = fakeDb((sql) => /SELECT 1 FROM operational_user/.test(sql) ? { rows: [{}] } : undefined);
        await assert.rejects(
            () => createAdmin({ email: 'x@y.za', firstName: 'X', lastName: 'Y' },
                { db: d, bcrypt: {}, generateTempPassword, auditService: {} }),
            /already exists/
        );
        assert.ok(!d.log.some((q) => /INSERT/.test(q.sql)));
    });
});
