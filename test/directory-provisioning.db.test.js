// Runs the directory provisioning rules against a REAL PostgreSQL, because they are mostly SQL
// (matching, linking, role changes, unique indexes, races) and a fake database cannot catch a typo in it.
//
// Skipped unless a server is named:
//   TEST_PG_HOST=127.0.0.1 TEST_PG_PORT=5432 TEST_PG_USER=postgres TEST_PG_PASSWORD=... npm test
// It creates a throwaway database from dojc_db.sql plus the migrations, and drops it afterwards.

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { useTestDatabase } = require('./helpers/testDb');
const testDb = useTestDatabase();      // sets DB_* and JWT_SECRET: must run before anything under src/ is loaded

const { loadDirectoryConfig } = require('../src/directory/config');
const { stubBcrypt } = require('./helpers/stubs');
stubBcrypt();

let pool, users, audit, tokens, cfg, mailed;

const CONFIG_ENV = {
    AUTH_PROVIDER: 'ldap', AD_GROUP_ADMIN: 'DOJCD-Admins', AD_GROUP_MANAGER: 'DOJCD-Managers', AD_GROUP_FINANCE: 'DOJCD-Finance',
    AD_GROUP_MAGISTRATES: 'DOJCD-Magistrates',
};

const profile = (over = {}) => ({
    externalId: 'guid-jane', upn: 'jmokoena@example.local', email: 'Jane.Mokoena@dojcd.gov.za', firstName: 'Jane', lastName: 'Mokoena',
    displayName: 'Jane Mokoena', phone: '0821234567', department: 'DoJ&CD Gauteng', employeeId: '12345678', groups: [], ...over,
});

const ctxFor = (c = cfg) => ({ cfg: c, db: pool, audit, email: { sendWelcomeClient: async (to) => { mailed.push(to); } } });
const staff = (p, c) => users.provision(p, 'staff', ctxFor(c));
const client = (p, c) => users.provision(p, 'client', ctxFor(c));
const one = async (sql, params) => (await pool.query(sql, params)).rows[0];
const actions = async (entityType, id) =>
    (await pool.query(`SELECT action FROM audit_log WHERE entity_type = $1 AND entity_id = $2 ORDER BY log_id`, [entityType, id])).rows.map((r) => r.action);

describe('directory provisioning (real PostgreSQL)', { skip: testDb.skip }, () => {
    before(async () => {
        await testDb.create();
        pool = require('../src/config/db');
        users = require('../src/directory/directoryUsers');
        audit = require('../src/services/auditService');
        tokens = require('../src/services/tokenService');
        cfg = loadDirectoryConfig(CONFIG_ENV);
    });

    after(async () => { await testDb.drop(pool); });

    beforeEach(async () => {
        mailed = [];
        await pool.query(`TRUNCATE operational_user, client_user RESTART IDENTITY CASCADE`);
        await pool.query(`TRUNCATE audit_log, login_attempt, refresh_token RESTART IDENTITY`);
    });

    // ── staff ────────────────────────────────────────────────────────────────

    describe('staff', () => {
        it('creates a staff account from a group, with no password', async () => {
            const row = await staff(profile({ groups: ['DOJCD-Managers'] }));
            assert.equal(row.user_role, 'Manager');
            assert.equal(row.role_source, 'directory_group');
            assert.equal(row.auth_source, 'ldap');
            assert.equal(row.external_id, 'guid-jane');
            assert.equal(row.password_hash, null);
            assert.equal(row.must_change_password, false);
            assert.equal(row.email, 'jane.mokoena@dojcd.gov.za', 'email is stored lower-case');
            assert.equal(row.department_id, 'DoJ&CD Gauteng', 'department resolved from the directory attribute');
            assert.deepEqual(await actions('operational_user', row.op_user_id), ['DIRECTORY_STAFF_PROVISIONED']);
        });

        it('signing in again updates the directory-owned fields and never duplicates the person', async () => {
            const first = await staff(profile({ groups: ['DOJCD-Managers'] }));
            const second = await staff(profile({ groups: ['DOJCD-Managers'], firstName: 'Janet', email: 'janet@dojcd.gov.za' }));
            assert.equal(second.op_user_id, first.op_user_id);
            assert.equal(second.first_name, 'Janet');
            assert.equal(second.email, 'janet@dojcd.gov.za');
            assert.equal((await one(`SELECT count(*)::int AS n FROM operational_user`)).n, 1);
        });

        it('the strongest group wins, and a role change is audited', async () => {
            const asManager = await staff(profile({ groups: ['DOJCD-Managers'] }));
            const both = await staff(profile({ groups: ['DOJCD-Managers', 'DOJCD-Finance'] }));
            assert.equal(both.user_role, 'Finance');
            assert.deepEqual(await actions('operational_user', asManager.op_user_id), ['DIRECTORY_STAFF_PROVISIONED', 'DIRECTORY_ROLE_CHANGED']);

            const admin = await staff(profile({ groups: ['DOJCD-Managers', 'DOJCD-Finance', 'DOJCD-Admins'] }));
            assert.equal(admin.user_role, 'Admin');
        });

        it('matches groups by DN or CN, case-insensitively', async () => {
            const byDn = loadDirectoryConfig({ ...CONFIG_ENV, AD_GROUP_MANAGER: 'CN=DOJCD-Managers,OU=Groups,DC=x' });
            const row = await staff(profile({ groups: ['cn=dojcd-managers, ou=groups,dc=x'] }), byDn);
            assert.equal(row.user_role, 'Manager');
        });

        it('with no mapped group and no account, refuses and creates nothing', async () => {
            await assert.rejects(staff(profile({ groups: ['Some Other Group'] })), { code: 'NO_STAFF_ACCESS', status: 403 });
            assert.equal((await one(`SELECT count(*)::int AS n FROM operational_user`)).n, 0);
        });

        it('leaving every group switches a group-granted account off, and rejoining switches it back on', async () => {
            const granted = await staff(profile({ groups: ['DOJCD-Finance'] }));
            await assert.rejects(staff(profile({ groups: [] })), { code: 'NO_STAFF_ACCESS' });

            const off = await one(`SELECT is_deleted, deleted_at FROM operational_user WHERE op_user_id = $1`, [granted.op_user_id]);
            assert.equal(off.is_deleted, true);
            assert.ok(off.deleted_at);
            assert.ok((await actions('operational_user', granted.op_user_id)).includes('DIRECTORY_STAFF_ACCESS_REVOKED'));

            const back = await staff(profile({ groups: ['DOJCD-Finance'] }));
            assert.equal(back.op_user_id, granted.op_user_id, 'the same account, so history stays attached');
            assert.equal(back.is_deleted, false);
            assert.equal(back.deleted_at, null);
        });

        it('a role an Admin gave by hand survives sign-ins with no group', async () => {
            await pool.query(
                `INSERT INTO operational_user (first_name, last_name, email, user_role, password_hash, must_change_password, auth_source, role_source)
                 VALUES ('Jane','Mokoena','jane.mokoena@dojcd.gov.za','Manager',NULL,false,'ldap','manual')`
            );
            const row = await staff(profile({ groups: [] }));
            assert.equal(row.user_role, 'Manager');
            assert.equal(row.role_source, 'manual');
            assert.equal(row.external_id, 'guid-jane', 'linked on first sign-in');
            assert.ok((await actions('operational_user', row.op_user_id)).includes('DIRECTORY_ACCOUNT_LINKED'));

            const again = await staff(profile({ groups: [] }));
            assert.equal(again.user_role, 'Manager');
        });

        it('a group overrides a manual role and takes over responsibility for it', async () => {
            await pool.query(
                `INSERT INTO operational_user (first_name, last_name, email, user_role, password_hash, must_change_password, auth_source, role_source)
                 VALUES ('Jane','Mokoena','jane.mokoena@dojcd.gov.za','Manager',NULL,false,'ldap','manual')`
            );
            const row = await staff(profile({ groups: ['DOJCD-Finance'] }));
            assert.equal(row.user_role, 'Finance');
            assert.equal(row.role_source, 'directory_group');
            await assert.rejects(staff(profile({ groups: [] })), { code: 'NO_STAFF_ACCESS' }, 'now it is group-managed, so leaving the group removes it');
        });

        it('turns an existing local staff account into a directory account without losing its history', async () => {
            const local = await one(
                `INSERT INTO operational_user (first_name, last_name, email, user_role, password_hash, must_change_password, is_super_admin, has_global_access)
                 VALUES ('Jane','M','jane.mokoena@dojcd.gov.za','Manager','$2b$10$abcdefghijklmnopqrstuv',false,false,true) RETURNING op_user_id`
            );
            const row = await staff(profile({ groups: ['DOJCD-Managers'] }));
            assert.equal(row.op_user_id, local.op_user_id);
            assert.equal(row.password_hash, null, 'the local password stops working');
            assert.equal(row.auth_source, 'ldap');
            assert.equal(row.has_global_access, true, 'application-owned settings are kept');
        });

        it('never hands an account to a different directory identity that has the same email', async () => {
            await staff(profile({ groups: ['DOJCD-Managers'] }));
            await assert.rejects(
                staff(profile({ externalId: 'guid-someone-else', groups: ['DOJCD-Managers'] })),
                { code: 'ACCOUNT_CONFLICT', status: 409 }
            );
            assert.equal((await one(`SELECT external_id FROM operational_user`)).external_id, 'guid-jane');
        });

        it('keeps the old email when the new one already belongs to someone else', async () => {
            await staff(profile({ externalId: 'guid-a', email: 'a@dojcd.gov.za', groups: ['DOJCD-Managers'] }));
            const b = await staff(profile({ externalId: 'guid-b', email: 'b@dojcd.gov.za', groups: ['DOJCD-Managers'] }));
            const moved = await staff(profile({ externalId: 'guid-b', email: 'a@dojcd.gov.za', groups: ['DOJCD-Managers'] }));
            assert.equal(moved.op_user_id, b.op_user_id);
            assert.equal(moved.email, 'b@dojcd.gov.za');
        });

        it('super-admin follows its group for group-managed accounts', async () => {
            const withSuper = loadDirectoryConfig({ ...CONFIG_ENV, AD_GROUP_SUPER_ADMIN: 'DOJCD-SuperAdmins' });
            const a = await staff(profile({ groups: ['DOJCD-Admins', 'DOJCD-SuperAdmins'] }), withSuper);
            assert.equal(a.is_super_admin, true);
            const b = await staff(profile({ groups: ['DOJCD-Admins'] }), withSuper);
            assert.equal(b.is_super_admin, false, 'removed from the group, removed from the power');
            const unmanaged = await staff(profile({ groups: ['DOJCD-Admins'] }));     // no AD_GROUP_SUPER_ADMIN configured
            assert.equal(unmanaged.is_super_admin, false);
        });

        it('only fills the department when it is empty and only with a known department', async () => {
            const known = await staff(profile({ groups: ['DOJCD-Managers'], department: 'DOJ&CD WESTERN CAPE' }));
            assert.equal(known.department_id, 'DoJ&CD Western Cape', 'matched case-insensitively to the canonical name');
            const kept = await staff(profile({ groups: ['DOJCD-Managers'], department: 'DoJ&CD Limpopo' }));
            assert.equal(kept.department_id, 'DoJ&CD Western Cape', 'not overwritten by the directory');

            const unknown = await staff(profile({ externalId: 'guid-2', email: 'two@dojcd.gov.za', groups: ['DOJCD-Managers'], department: 'Ministry of Nonsense' }));
            assert.equal(unknown.department_id, null);
        });

        it('refuses a directory account that has no email address', async () => {
            await assert.rejects(users.provision(profile({ email: '', upn: '' }), 'staff', ctxFor()), { code: 'NO_EMAIL' });
        });

        it('two first sign-ins at the same moment create exactly one account', async () => {
            const results = await Promise.all(Array.from({ length: 6 }, () => staff(profile({ groups: ['DOJCD-Managers'] }))));
            assert.equal(new Set(results.map((r) => r.op_user_id)).size, 1);
            assert.equal((await one(`SELECT count(*)::int AS n FROM operational_user`)).n, 1);
        });
    });

    // ── clients ──────────────────────────────────────────────────────────────

    describe('clients', () => {
        it('creates an unverified client on first sign-in and welcomes them once', async () => {
            const row = await client(profile());
            assert.equal(row.registration_status, 'Pending');
            assert.equal(row.user_type, 'Advocate', 'the default');
            assert.equal(row.persal_id, '12345678');
            assert.equal(row.department_id, 'DoJ&CD Gauteng');
            assert.equal(row.phone_number, '0821234567');
            assert.equal(row.password_hash, null);
            assert.equal(row.auth_source, 'ldap');
            assert.deepEqual(await actions('client_user', row.client_user_id), ['DIRECTORY_CLIENT_PROVISIONED']);

            await client(profile());
            assert.deepEqual(mailed, ['jane.mokoena@dojcd.gov.za'], 'one welcome email, on creation only');
        });

        it('magistrates are recognised by their group', async () => {
            const row = await client(profile({ groups: ['DOJCD-Magistrates'] }));
            assert.equal(row.user_type, 'Magistrate');
        });

        it('the default user type is configurable', async () => {
            const row = await client(profile(), loadDirectoryConfig({ ...CONFIG_ENV, DIRECTORY_DEFAULT_USER_TYPE: 'Magistrate' }));
            assert.equal(row.user_type, 'Magistrate');
        });

        it('keeps what an Admin or the client edited, and refreshes only what the directory owns', async () => {
            const row = await client(profile());
            await pool.query(
                `UPDATE client_user SET user_type = 'Magistrate', region = 'Gauteng North', department_id = 'DoJ&CD Limpopo',
                        phone_number = '0831112222', registration_status = 'Verified' WHERE client_user_id = $1`, [row.client_user_id]
            );
            const again = await client(profile({ firstName: 'Janet', phone: '0999999999', department: 'DoJ&CD Gauteng' }));
            assert.equal(again.first_name, 'Janet');
            assert.equal(again.user_type, 'Magistrate');
            assert.equal(again.region, 'Gauteng North');
            assert.equal(again.department_id, 'DoJ&CD Limpopo');
            assert.equal(again.phone_number, '0831112222');
            assert.equal(again.registration_status, 'Verified');
        });

        it('links an existing self-registered client by email and keeps their verification and applications', async () => {
            const local = await one(
                `INSERT INTO client_user (first_name, last_name, email, user_type, password_hash, registration_status)
                 VALUES ('Jane','M','jane.mokoena@dojcd.gov.za','Magistrate','$2b$10$abcdefghijklmnopqrstuv','Verified') RETURNING client_user_id`
            );
            const row = await client(profile());
            assert.equal(row.client_user_id, local.client_user_id);
            assert.equal(row.registration_status, 'Verified');
            assert.equal(row.user_type, 'Magistrate');
            assert.equal(row.password_hash, null);
            assert.deepEqual(await actions('client_user', row.client_user_id), ['DIRECTORY_ACCOUNT_LINKED']);
            assert.deepEqual(mailed, [], 'an existing client is not welcomed again');
        });

        it('refuses a deactivated client without touching the account', async () => {
            const row = await client(profile());
            await pool.query(`UPDATE client_user SET registration_status = 'Deactivated', first_name = 'Frozen' WHERE client_user_id = $1`, [row.client_user_id]);
            await assert.rejects(client(profile({ firstName: 'Janet' })), { code: 'ACCOUNT_DEACTIVATED' });
            assert.equal((await one(`SELECT first_name FROM client_user`)).first_name, 'Frozen');
        });

        it('can be limited to members of a clients group', async () => {
            const limited = loadDirectoryConfig({ ...CONFIG_ENV, AD_GROUP_CLIENTS: 'DOJCD-Clients' });
            await assert.rejects(client(profile({ groups: ['Other'] }), limited), { code: 'NOT_ALLOWED' });
            assert.equal((await one(`SELECT count(*)::int AS n FROM client_user`)).n, 0);
            const row = await client(profile({ groups: ['DOJCD-Clients'] }), limited);
            assert.equal(row.registration_status, 'Pending');
        });

        it('does not fail when two people carry the same PERSAL number: the second goes without one', async () => {
            await client(profile());
            const second = await client(profile({ externalId: 'guid-2', email: 'two@dojcd.gov.za' }));
            assert.equal(second.persal_id, null);
        });

        it('a person can hold both a staff and a client account at once', async () => {
            const s = await staff(profile({ groups: ['DOJCD-Managers'] }));
            const c = await client(profile({ groups: ['DOJCD-Managers'] }));
            assert.ok(s.op_user_id && c.client_user_id);
        });

        it('two first sign-ins at the same moment create exactly one account', async () => {
            const results = await Promise.all(Array.from({ length: 6 }, () => client(profile())));
            assert.equal(new Set(results.map((r) => r.client_user_id)).size, 1);
            assert.equal((await one(`SELECT count(*)::int AS n FROM client_user`)).n, 1);
        });
    });

    // ── sessions ─────────────────────────────────────────────────────────────

    describe('sessions', () => {
        const jwt = require('jsonwebtoken');

        it('a staff session carries the role, department and no forced password change', async () => {
            const row = await staff(profile({ groups: ['DOJCD-Finance'] }));
            const session = await users.openSession('Operational', row, tokens);
            const claims = jwt.verify(session.accessToken, process.env.JWT_SECRET);
            assert.equal(claims.userType, 'Operational');
            assert.equal(claims.role, 'Finance');
            assert.equal(claims.userId, row.op_user_id);
            assert.equal(claims.departmentId, 'DoJ&CD Gauteng');
            assert.equal(claims.mustChangePassword, false);
            assert.equal(session.user.name, 'Jane Mokoena');
            assert.ok(!('password_hash' in session.user) && !('external_id' in session.user), 'internal fields never leave the server');
            assert.equal((await one(`SELECT count(*)::int AS n FROM refresh_token WHERE user_type = 'Operational'`)).n, 1);
        });

        it('a client session is a Client session', async () => {
            const row = await client(profile());
            const claims = jwt.verify((await users.openSession('Client', row, tokens)).accessToken, process.env.JWT_SECRET);
            assert.equal(claims.userType, 'Client');
            assert.equal(claims.role, null);
        });

        it('a switched-off account cannot renew its session', async () => {
            const row = await staff(profile({ groups: ['DOJCD-Managers'] }));
            const { refreshToken } = await users.openSession('Operational', row, tokens);
            await assert.rejects(staff(profile({ groups: [] })), { code: 'NO_STAFF_ACCESS' });
            await assert.rejects(tokens.refreshTokens(refreshToken), /no longer active/);
        });

        it('a deactivated client cannot renew its session', async () => {
            const row = await client(profile());
            const { refreshToken } = await users.openSession('Client', row, tokens);
            await pool.query(`UPDATE client_user SET registration_status = 'Deactivated'`);
            await assert.rejects(tokens.refreshTokens(refreshToken), /no longer active/);
        });
    });
});
