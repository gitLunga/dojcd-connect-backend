// Creates and updates application users from a directory profile, then opens a session for them.
//
// People never register: the first time someone signs in through the directory, their account is
// created here from what the directory says about them. Rules:
//
//  Staff sign-in (audience "staff", the admin dashboard)
//    * The role comes from group membership (config AD_GROUP_*). Strongest group wins.
//    * No mapped group? A role an Admin gave them by hand is kept (role_source = 'manual').
//      A role that came from a group the person has since left is withdrawn (role_source =
//      'directory_group'): the account is switched off and they can no longer sign in as staff.
//    * An Admin may pre-authorise someone (account with no directory id yet); it is linked by email.
//
//  Client sign-in (audience "client", the client portal)
//    * Any directory user may sign in (or only members of AD_GROUP_CLIENTS when that is set).
//    * The account starts as an unverified client; the profile and Admin verification steps are unchanged.
//
//  Fields the directory owns (name, email, directory id) are refreshed on every sign-in. Fields the
//  application owns (user type, region, department, PERSAL number, profile) are only filled when empty.

const { DirectoryError } = require('./errors');
const { STAFF_ROLE_PRIORITY } = require('./config');
const roles = require('./roleMapper');

const lower = (s) => String(s || '').trim().toLowerCase();

function displayNames(profile, email) {
    let first = String(profile.firstName || '').trim();
    let last  = String(profile.lastName  || '').trim();
    if ((!first || !last) && profile.displayName) {
        const parts = String(profile.displayName).trim().split(/\s+/);
        if (!first) first = parts[0] || '';
        if (!last)  last  = parts.slice(1).join(' ');
    }
    return { first: first || email.split('@')[0], last: last || '-' };
}

async function resolveDepartment(q, value) {
    const v = String(value || '').trim();
    if (!v) return null;
    const { rows } = await q.query(
        `SELECT name FROM department WHERE lower(name) = lower($1) OR lower(code) = lower($1) LIMIT 1`, [v]
    );
    return rows[0]?.name || null;
}

async function findIdentity(c, table, source, profile, email) {
    const byId = await c.query(
        `SELECT * FROM ${table} WHERE auth_source = $1 AND external_id = $2 FOR UPDATE`, [source, profile.externalId]
    );
    if (byId.rows[0]) return byId.rows[0];

    const byEmail = await c.query(
        `SELECT * FROM ${table} WHERE lower(email) = $1 ORDER BY 1 LIMIT 1 FOR UPDATE`, [email]
    );
    const row = byEmail.rows[0];
    if (!row) return null;

    // Same directory, different person: someone else already owns this email. Never take it over.
    if (row.external_id && row.auth_source === source && row.external_id !== profile.externalId) {
        throw new DirectoryError('ACCOUNT_CONFLICT',
            'Your email address is already linked to a different directory account. Please contact an administrator.');
    }
    return row;
}

async function emailTakenByAnother(c, table, idCol, email, id) {
    const { rows } = await c.query(`SELECT 1 FROM ${table} WHERE lower(email) = $1 AND ${idCol} <> $2 LIMIT 1`, [email, id]);
    return rows.length > 0;
}

// ── staff ────────────────────────────────────────────────────────────────────

async function provisionStaff(profile, ctx) {
    const { cfg, db, audit } = ctx;
    const source = cfg.provider;
    const email = lower(profile.email || profile.upn);
    const staffRole = roles.resolveStaffRole(profile.groups, cfg);
    const inSuperGroup = roles.isInSuperAdminGroup(profile.groups, cfg);
    const department = await resolveDepartment(db, profile.department);
    const { first, last } = displayNames(profile, email);

    const c = await db.connect();
    let denied = false;
    let result;
    try {
        await c.query('BEGIN');
        let row = await findIdentity(c, 'operational_user', source, profile, email);

        if (!staffRole) {
            const activeManual = row && !row.is_deleted && row.role_source === 'manual';
            if (!activeManual) {
                if (row && !row.is_deleted && row.role_source === 'directory_group') {
                    await c.query(
                        `UPDATE operational_user SET is_deleted = true, deleted_at = NOW(), updated_at = NOW() WHERE op_user_id = $1`,
                        [row.op_user_id]
                    );
                    await audit.log(c, {
                        actorId: row.op_user_id, actorType: 'System', action: 'DIRECTORY_STAFF_ACCESS_REVOKED',
                        entityType: 'operational_user', entityId: row.op_user_id,
                        oldValue: { user_role: row.user_role }, newValue: { reason: 'no longer in a mapped directory group' },
                    });
                }
                denied = true;
            }
        }

        if (!denied) {
            const newRole = staffRole || row.user_role;
            const roleSource = staffRole ? 'directory_group' : row.role_source;

            let isSuper = row ? row.is_super_admin : false;
            if (cfg.groups.superAdmin.length > 0) {
                if (inSuperGroup) isSuper = true;
                else if (roleSource === 'directory_group') isSuper = false;
            }

            if (!row) {
                const ins = await c.query(
                    `INSERT INTO operational_user
                         (first_name, last_name, email, user_role, department_id, password_hash, must_change_password,
                          is_super_admin, auth_source, external_id, directory_upn, directory_synced_at, role_source)
                     VALUES ($1,$2,$3,$4,$5,NULL,false,$6,$7,$8,$9,NOW(),'directory_group')
                     RETURNING *`,
                    [first, last, email, newRole, department, isSuper, source, profile.externalId, profile.upn || null]
                );
                row = ins.rows[0];
                await audit.log(c, {
                    actorId: row.op_user_id, actorType: 'System', action: 'DIRECTORY_STAFF_PROVISIONED',
                    entityType: 'operational_user', entityId: row.op_user_id,
                    newValue: { email, user_role: newRole, source },
                });
            } else {
                const wasLinked = !!row.external_id && row.auth_source === source;
                const keepEmail = email !== lower(row.email) && await emailTakenByAnother(c, 'operational_user', 'op_user_id', email, row.op_user_id);
                const upd = await c.query(
                    `UPDATE operational_user
                        SET first_name = $1, last_name = $2, email = $3, user_role = $4, role_source = $5,
                            department_id = COALESCE(NULLIF(department_id, ''), $6),
                            is_super_admin = $7, auth_source = $8, external_id = $9, directory_upn = $10,
                            directory_synced_at = NOW(), password_hash = NULL, must_change_password = false,
                            is_deleted = false, deleted_at = NULL, updated_at = NOW()
                      WHERE op_user_id = $11
                      RETURNING *`,
                    [first, last, keepEmail ? row.email : email, newRole, roleSource, department, isSuper,
                     source, profile.externalId, profile.upn || null, row.op_user_id]
                );
                const before = row;
                row = upd.rows[0];

                if (!wasLinked) {
                    await audit.log(c, {
                        actorId: row.op_user_id, actorType: 'System', action: 'DIRECTORY_ACCOUNT_LINKED',
                        entityType: 'operational_user', entityId: row.op_user_id,
                        oldValue: { auth_source: before.auth_source }, newValue: { auth_source: source, user_role: row.user_role },
                    });
                }
                if (before.user_role !== row.user_role || before.is_deleted) {
                    await audit.log(c, {
                        actorId: row.op_user_id, actorType: 'System', action: 'DIRECTORY_ROLE_CHANGED',
                        entityType: 'operational_user', entityId: row.op_user_id,
                        oldValue: { user_role: before.user_role, is_deleted: before.is_deleted }, newValue: { user_role: row.user_role },
                    });
                }
            }
            result = row;
        }

        await c.query('COMMIT');
    } catch (err) {
        await c.query('ROLLBACK');
        throw err;
    } finally {
        c.release();
    }

    if (denied) {
        const hasStaffGroups = STAFF_ROLE_PRIORITY.some((role) => cfg.groups[role].length > 0);
        throw new DirectoryError('NO_STAFF_ACCESS', hasStaffGroups
            ? 'Your account does not have staff access to this system. Ask an administrator to add you to a staff group.'
            : 'Your account has not been given staff access. Ask an administrator to authorise it.');
    }
    return result;
}

// ── clients ──────────────────────────────────────────────────────────────────

async function provisionClient(profile, ctx) {
    const { cfg, db, audit, email: mailer } = ctx;
    const source = cfg.provider;

    if (!roles.isClientAllowed(profile.groups, cfg)) {
        throw new DirectoryError('NOT_ALLOWED', 'Your account is not permitted to use the client portal. Please contact an administrator.');
    }

    const email = lower(profile.email || profile.upn);
    const department = await resolveDepartment(db, profile.department);
    const userType = roles.resolveUserType(profile.groups, cfg);
    const { first, last } = displayNames(profile, email);
    const phone = profile.phone || null;
    const persal = profile.employeeId ? String(profile.employeeId).trim() : null;

    const c = await db.connect();
    let row, created = false, deactivated = false;
    try {
        await c.query('BEGIN');
        row = await findIdentity(c, 'client_user', source, profile, email);

        if (row && row.registration_status === 'Deactivated') {
            deactivated = true;
        } else {
            let persalToUse = persal;
            if (persalToUse) {
                const clash = await c.query(
                    `SELECT 1 FROM client_user WHERE persal_id = $1 AND client_user_id <> $2 LIMIT 1`, [persalToUse, row?.client_user_id || 0]
                );
                if (clash.rows.length > 0) persalToUse = null;
            }

            if (!row) {
                const ins = await c.query(
                    `INSERT INTO client_user
                         (first_name, last_name, email, phone_number, persal_id, department_id, user_type, password_hash,
                          registration_status, auth_source, external_id, directory_upn, directory_synced_at)
                     VALUES ($1,$2,$3,$4,$5,$6,$7,NULL,'Pending',$8,$9,$10,NOW())
                     RETURNING *`,
                    [first, last, email, phone, persalToUse, department, userType, source, profile.externalId, profile.upn || null]
                );
                row = ins.rows[0];
                created = true;
                await audit.log(c, {
                    actorId: row.client_user_id, actorType: 'System', action: 'DIRECTORY_CLIENT_PROVISIONED',
                    entityType: 'client_user', entityId: row.client_user_id, newValue: { email, user_type: userType, source },
                });
            } else {
                const wasLinked = !!row.external_id && row.auth_source === source;
                const keepEmail = email !== lower(row.email) && await emailTakenByAnother(c, 'client_user', 'client_user_id', email, row.client_user_id);
                const upd = await c.query(
                    `UPDATE client_user
                        SET first_name = $1, last_name = $2, email = $3,
                            phone_number  = COALESCE(NULLIF(phone_number, ''), $4),
                            department_id = COALESCE(NULLIF(department_id, ''), $5),
                            persal_id     = COALESCE(persal_id, $6),
                            auth_source = $7, external_id = $8, directory_upn = $9, directory_synced_at = NOW(),
                            password_hash = NULL, updated_at = NOW()
                      WHERE client_user_id = $10
                      RETURNING *`,
                    [first, last, keepEmail ? row.email : email, phone, department, persalToUse,
                     source, profile.externalId, profile.upn || null, row.client_user_id]
                );
                const before = row;
                row = upd.rows[0];
                if (!wasLinked) {
                    await audit.log(c, {
                        actorId: row.client_user_id, actorType: 'System', action: 'DIRECTORY_ACCOUNT_LINKED',
                        entityType: 'client_user', entityId: row.client_user_id,
                        oldValue: { auth_source: before.auth_source }, newValue: { auth_source: source },
                    });
                }
            }
        }
        await c.query('COMMIT');
    } catch (err) {
        await c.query('ROLLBACK');
        throw err;
    } finally {
        c.release();
    }

    if (deactivated) {
        throw new DirectoryError('ACCOUNT_DEACTIVATED', 'This account has been deactivated. Please contact an administrator.');
    }
    if (created && mailer) mailer.sendWelcomeClient(row.email, row.first_name).catch(() => {});
    return row;
}

// ── sessions ─────────────────────────────────────────────────────────────────

const publicUser = (row) => {
    const user = { ...row };
    delete user.password_hash;
    delete user.external_id;
    return user;
};

async function openSession(type, row, tokens) {
    const user = publicUser(row);
    if (type === 'Operational') {
        user.name = `${row.first_name} ${row.last_name}`.trim();
        return {
            user,
            accessToken: tokens.generateAccessToken(row.op_user_id, 'Operational', row.user_role, row.department_id || null, false, row.has_global_access || false),
            refreshToken: await tokens.generateRefreshToken(row.op_user_id, 'Operational'),
        };
    }
    return {
        user,
        accessToken: tokens.generateAccessToken(row.client_user_id, 'Client', null, row.department_id || null),
        refreshToken: await tokens.generateRefreshToken(row.client_user_id, 'Client'),
    };
}

// Provision (create or update) the person for this audience and return the account row.
async function provision(profile, audience, ctx) {
    if (!profile?.externalId) throw new DirectoryError('DIRECTORY_UNAVAILABLE', 'The directory did not return an account id.');
    if (!lower(profile.email || profile.upn)) {
        throw new DirectoryError('NO_EMAIL', 'Your directory account has no email address. Please contact an administrator.');
    }
    const run = () => (audience === 'staff' ? provisionStaff(profile, ctx) : provisionClient(profile, ctx));
    try {
        return await run();
    } catch (err) {
        // Two first sign-ins at the same moment: the loser hits the unique index. Look again.
        if (err.code === '23505') return run();
        throw err;
    }
}

module.exports = { provision, openSession, publicUser, displayNames };
