// Orchestrates directory sign-in: picks the provider, provisions the person, opens a session.
// The routes call this; it never touches Express.

const crypto = require('crypto');
const { DirectoryError } = require('./errors');
const { STAFF_ROLE_PRIORITY } = require('./config');
const { createPkce } = require('./entraProvider');
const roles = require('./roleMapper');
const users = require('./directoryUsers');
const { createAttemptLimiter } = require('../utils/attemptLimiter');

const STATE_TTL_MINUTES  = 10;   // how long a person may spend on Microsoft's sign-in page
const TICKET_TTL_SECONDS = 120;  // how long the front-end has to swap the ticket for tokens

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const AUDIENCES = ['staff', 'client'];

function createDirectoryAuth({ cfg, provider, db, audit, tokens, email: mailer, localAuth }) {
    const limiter = createAttemptLimiter(cfg.loginRateLimit);
    const ctx = { cfg, db, audit, email: mailer };

    const requireProvider = (name) => {
        if (cfg.provider !== name || !provider) {
            throw new DirectoryError('NOT_CONFIGURED', `This server is not set up for ${name === 'ldap' ? 'domain' : 'Microsoft'} sign-in.`);
        }
    };

    const sessionType = (audience) => (audience === 'staff' ? 'Operational' : 'Client');

    // ── on-premises AD: the person types domain credentials into our form ───────────────────────

    async function passwordSignIn({ username, password, audience = 'client', ip = null }) {
        requireProvider('ldap');
        if (!AUDIENCES.includes(audience)) throw new DirectoryError('BAD_REQUEST', 'Unknown sign-in audience.');

        const typed = String(username || '').trim();
        const key = `${typed.toLowerCase()}|${ip || ''}`;
        limiter.check(key);

        // A client who registered here with a password may use it; a wrong one falls through to the directory.
        if (audience === 'client') {
            const local = await tryLocalClient(typed, password, ip);
            if (local) {
                limiter.clear(key);
                await audit.logLoginAttempt(typed, ip, true);
                return local;
            }
        }

        let profile;
        try {
            profile = await provider.authenticate(typed, password);
        } catch (err) {
            if (err instanceof DirectoryError && err.code !== 'DIRECTORY_UNAVAILABLE') {
                if (err.code === 'INVALID_CREDENTIALS') limiter.fail(key);
                await audit.logLoginAttempt(typed, ip, false);
            }
            throw err;
        }

        let row;
        try {
            row = await users.provision(profile, audience, ctx);
        } catch (err) {
            await audit.logLoginAttempt(typed, ip, false);   // right password, but no access here: still worth a trace
            throw err;
        }

        limiter.clear(key);
        await audit.logLoginAttempt(typed, ip, true);
        return users.openSession(sessionType(audience), row, tokens);
    }

    // ── Entra ID: the browser goes to Microsoft and comes back with a code ──────────────────────

    // Only front-end addresses on the allow-list may receive the person back (no open redirect).
    function checkRedirect(redirect) {
        let target;
        try { target = new URL(redirect); } catch (_) { throw new DirectoryError('BAD_REQUEST', 'A valid redirect address is required.'); }
        // Compare scheme + host + path, not URL.origin: for app links such as dojcdconnect://auth/callback the
        // origin is the string "null" for EVERY such address, which would let any other app scheme through.
        const same = (a, b) => a.protocol === b.protocol && a.host === b.host && a.pathname === b.pathname;
        const allowed = cfg.allowedRedirects.some((entry) => { try { return same(target, new URL(entry)); } catch (_) { return false; } });
        if (!allowed) throw new DirectoryError('BAD_REQUEST', 'That redirect address is not allowed.');
        target.hash = '';
        return target.toString();
    }

    async function startEntraLogin({ audience, redirect }) {
        requireProvider('entra');
        if (!AUDIENCES.includes(audience)) throw new DirectoryError('BAD_REQUEST', 'Unknown sign-in audience.');
        const back = checkRedirect(redirect);

        const { verifier, challenge } = createPkce();
        const state = crypto.randomBytes(32).toString('base64url');
        const nonce = crypto.randomBytes(16).toString('hex');

        await db.query(`DELETE FROM directory_login_state WHERE expires_at < NOW()`);
        await db.query(
            `INSERT INTO directory_login_state (state_hash, code_verifier, nonce, audience, redirect_uri, expires_at)
             VALUES ($1, $2, $3, $4, $5, NOW() + ($6 || ' minutes')::interval)`,
            [sha256(state), verifier, nonce, audience, back, String(STATE_TTL_MINUTES)]
        );
        return provider.buildAuthorizeUrl({ state, nonce, challenge });
    }

    // Microsoft sends the browser here. Always answers with where to send the browser next.
    async function finishEntraLogin({ code, state, error, errorDescription, ip = null }) {
        requireProvider('entra');

        // The state row is single-use: deleting it as we read it stops a replayed callback.
        const found = state
            ? await db.query(`DELETE FROM directory_login_state WHERE state_hash = $1 AND expires_at > NOW() RETURNING *`, [sha256(String(state))])
            : { rows: [] };
        const login = found.rows[0];
        if (!login) throw new DirectoryError('BAD_REQUEST', 'This sign-in has expired or was already used. Please start again.');

        const back = (params) => {
            const url = new URL(login.redirect_uri);
            Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
            return url.toString();
        };

        if (error) {
            // e.g. the person closed the Microsoft page (access_denied) or conditional access refused them.
            return { redirectTo: back({ error: 'SIGN_IN_CANCELLED', error_description: errorDescription ? String(errorDescription).slice(0, 200) : 'Microsoft sign-in was not completed.' }) };
        }

        let who = '';
        try {
            const profile = await provider.completeSignIn({ code, verifier: login.code_verifier, nonce: login.nonce });
            who = profile.email || profile.upn || '';
            const row = await users.provision(profile, login.audience, ctx);

            const type = sessionType(login.audience);
            const ticket = crypto.randomBytes(32).toString('base64url');
            await db.query(`DELETE FROM directory_login_ticket WHERE expires_at < NOW()`);
            await db.query(
                `INSERT INTO directory_login_ticket (ticket_hash, user_id, user_type, expires_at)
                 VALUES ($1, $2, $3, NOW() + ($4 || ' seconds')::interval)`,
                [sha256(ticket), type === 'Operational' ? row.op_user_id : row.client_user_id, type, String(TICKET_TTL_SECONDS)]
            );
            await audit.logLoginAttempt(who, ip, true);
            return { redirectTo: back({ ticket }) };
        } catch (err) {
            if (!(err instanceof DirectoryError)) throw err;
            if (err.code !== 'DIRECTORY_UNAVAILABLE') await audit.logLoginAttempt(who || 'unknown', ip, false);
            return { redirectTo: back({ error: err.code, error_description: err.message }) };
        }
    }

    // The front-end swaps the one-time ticket for the same session payload a password login returns.
    async function exchangeTicket(ticket) {
        const { rows } = await db.query(
            `UPDATE directory_login_ticket SET used_at = NOW()
              WHERE ticket_hash = $1 AND used_at IS NULL AND expires_at > NOW()
              RETURNING user_id, user_type`,
            [sha256(String(ticket || ''))]
        );
        if (!rows[0]) throw new DirectoryError('INVALID_CREDENTIALS', 'This sign-in link has expired. Please sign in again.');

        const { user_id: id, user_type: type } = rows[0];
        const account = type === 'Operational'
            ? await db.query(`SELECT * FROM operational_user WHERE op_user_id = $1 AND is_deleted = false`, [id])
            : await db.query(`SELECT * FROM client_user WHERE client_user_id = $1 AND registration_status <> 'Deactivated'`, [id]);
        if (!account.rows[0]) throw new DirectoryError('ACCOUNT_DEACTIVATED', 'This account is no longer active.');

        return users.openSession(type, account.rows[0], tokens);
    }

    // ── clients who keep their own password (AUTH_ALLOW_CLIENT_REGISTRATION=true) ──────────────

    const hybrid = () => cfg.allowClientRegistration && !!localAuth;

    // A client portal sign-in with the email and password of an account registered here. Returns a session, or
    // null when there is no such account or the password is wrong, so the caller carries on with the directory.
    // Throws only for an account an Admin switched off.
    async function tryLocalClient(typed, password, ip) {
        if (!hybrid()) return null;
        return localAuth.loginLocalClientIfPresent({ email: typed, password }, ip);
    }

    // Entra mode, client portal: the email + password form is for clients who registered here. Everyone else
    // uses the Microsoft button.
    async function localClientSignIn({ username, password, ip = null }) {
        if (!hybrid()) throw new DirectoryError('BAD_REQUEST', 'Sign in with your Microsoft account.');
        const typed = String(username || '').trim();
        const key = `${typed.toLowerCase()}|${ip || ''}`;
        limiter.check(key);

        const session = await tryLocalClient(typed, password, ip);
        if (session) {
            limiter.clear(key);
            await audit.logLoginAttempt(typed, ip, true);
            return session;
        }
        limiter.fail(key);
        await audit.logLoginAttempt(typed, ip, false);
        throw new DirectoryError('INVALID_CREDENTIALS',
            'Invalid email or password. If you have an organisation account, choose "Sign in with Microsoft".');
    }

    // Before a client registers with a password: refuse addresses that belong to an organisation account, who
    // must use the organisation sign-in. If the directory cannot be asked, registration waits rather than guess.
    async function assertEmailNotInDirectory(email) {
        if (!provider?.emailExists) return;
        const address = String(email || '').trim();
        if (!address) return;
        let exists;
        try {
            exists = await provider.emailExists(address);
        } catch (err) {
            if (err instanceof DirectoryError) {
                throw new DirectoryError('REGISTRATION_UNAVAILABLE', 'Registration is not available right now. Please try again in a few minutes.');
            }
            throw err;
        }
        if (exists) {
            throw new DirectoryError('USE_DIRECTORY_SIGN_IN',
                'This email address belongs to an organisation account. Please sign in with your organisation account instead of registering.');
        }
    }

    // ── sync: pull staff and clients in from the directory ──────────────────────────────────────

    const SCOPES = ['staff', 'clients', 'all'];
    const lower = (s) => String(s || '').trim().toLowerCase();

    // Staff: creates or updates people in the role groups and switches off group-granted staff accounts whose
    // person has left every group. `people` is filled with everyone found, keyed by directory id.
    async function syncStaff({ dryRun, force, result, people }) {
        const roleGroups = STAFF_ROLE_PRIORITY.flatMap((role) => cfg.groups[role].map((group) => ({ role, group })));
        if (roleGroups.length === 0) {
            throw new DirectoryError('NOT_CONFIGURED', 'No staff groups are configured (AD_GROUP_ADMIN, AD_GROUP_MANAGER, AD_GROUP_FINANCE ...).');
        }

        for (const { group } of roleGroups) {
            for (const member of await provider.listGroupMembers(group)) {
                const known = people.get(member.externalId);
                if (known) known.groups = [...new Set([...known.groups, ...member.groups, group])];
                else people.set(member.externalId, { ...member, groups: [...new Set([...member.groups, group])] });
            }
        }

        const existing = await db.query(
            `SELECT op_user_id, email, external_id, role_source, is_deleted FROM operational_user WHERE auth_source = $1`, [cfg.provider]
        );
        const byExternal = new Map(existing.rows.filter((r) => r.external_id).map((r) => [r.external_id, r]));
        const byEmail = new Map(existing.rows.map((r) => [String(r.email).toLowerCase(), r]));

        const stale = existing.rows.filter((r) => r.role_source === 'directory_group' && !r.is_deleted && r.external_id && !people.has(r.external_id));
        if (people.size === 0 && stale.length > 0 && !force) {
            throw new DirectoryError('BAD_REQUEST',
                'The directory returned no members for the staff groups, so every group-managed staff account would be switched off. ' +
                'Check the group names and the connection, or repeat with force to do it anyway.');
        }

        for (const profile of people.values()) {
            const known = byExternal.get(profile.externalId) || byEmail.get(String(profile.email || profile.upn).toLowerCase());
            if (known) result.updated++; else result.created++;
            if (dryRun) continue;
            try {
                await users.provision(profile, 'staff', ctx);
            } catch (err) {
                result.errors.push({ account: profile.email || profile.upn, message: err.message });
            }
        }

        for (const row of stale) {
            result.revoked++;
            if (dryRun) continue;
            const c = await db.connect();
            try {
                await c.query('BEGIN');
                await c.query(`UPDATE operational_user SET is_deleted = true, deleted_at = NOW(), updated_at = NOW() WHERE op_user_id = $1`, [row.op_user_id]);
                await audit.log(c, {
                    actorId: row.op_user_id, actorType: 'System', action: 'DIRECTORY_STAFF_ACCESS_REVOKED',
                    entityType: 'operational_user', entityId: row.op_user_id, newValue: { reason: 'no longer in a mapped directory group (sync)' },
                });
                await c.query('COMMIT');
            } catch (err) {
                await c.query('ROLLBACK');
                result.errors.push({ account: row.email, message: err.message });
            } finally {
                c.release();
            }
        }
    }

    // The ids of everyone who holds a staff role, found without touching the staff accounts.
    async function staffIdsOf(people) {
        if (people.size > 0) return new Set(people.keys());
        const ids = new Set();
        for (const role of STAFF_ROLE_PRIORITY) {
            for (const group of cfg.groups[role]) (await provider.listGroupMemberIds(group)).forEach((id) => ids.add(id));
        }
        return ids;
    }

    // Clients: with AD_GROUP_CLIENTS set, its members; otherwise every enabled person in the directory except the
    // people who hold a staff role. They arrive as unverified clients, exactly as if they had signed in once:
    // they still complete their profile and an Admin verifies them. No welcome emails are sent for an import.
    async function syncClients({ dryRun, result, people }) {
        const everyone = cfg.groups.clients.length === 0;
        const summary = {
            source: everyone ? 'everyone' : 'clients group',
            found: 0, created: 0, linked: 0, updated: 0,
            skippedStaff: 0, skippedDeactivated: 0, skippedNoEmail: 0,
        };
        result.clients = summary;

        const candidates = new Map();
        if (everyone) {
            for (const profile of await provider.listUsers()) candidates.set(profile.externalId, profile);
        } else {
            for (const group of cfg.groups.clients) {
                for (const member of await provider.listGroupMembers(group)) {
                    const known = candidates.get(member.externalId);
                    candidates.set(member.externalId, {
                        ...(known || member), groups: [...new Set([...(known?.groups || []), ...member.groups, group])],
                    });
                }
            }
        }
        summary.found = candidates.size;

        const staffIds = everyone ? await staffIdsOf(people) : new Set();
        const magistrateIds = new Set();
        for (const group of cfg.groups.magistrates) (await provider.listGroupMemberIds(group)).forEach((id) => magistrateIds.add(id));

        const existing = await db.query(`SELECT client_user_id, email, external_id, auth_source, registration_status FROM client_user`);
        const byExternal = new Map(existing.rows.filter((r) => r.external_id && r.auth_source === cfg.provider).map((r) => [r.external_id, r]));
        const byEmail = new Map(existing.rows.map((r) => [lower(r.email), r]));

        // No welcome email for each person in a bulk import.
        const quietCtx = { ...ctx, email: null };

        for (const profile of candidates.values()) {
            const email = lower(profile.email || profile.upn);
            if (!email) { summary.skippedNoEmail++; continue; }
            if (staffIds.has(profile.externalId)) { summary.skippedStaff++; continue; }

            const row = byExternal.get(profile.externalId) || byEmail.get(email);
            if (row && row.registration_status === 'Deactivated') { summary.skippedDeactivated++; continue; }
            if (row && row.external_id && row.auth_source === cfg.provider && row.external_id !== profile.externalId) {
                result.errors.push({ account: email, message: 'This email is already linked to a different directory account.' });
                continue;
            }

            if (!row) summary.created++;
            else if (row.external_id && row.auth_source === cfg.provider) summary.updated++;
            else summary.linked++;
            if (dryRun) continue;

            const groups = magistrateIds.has(profile.externalId) ? [...new Set([...profile.groups, ...cfg.groups.magistrates])] : profile.groups;
            try {
                await users.provision({ ...profile, groups }, 'client', quietCtx);
                result.clientsProvisioned++;
            } catch (err) {
                result.errors.push({ account: email, message: err.message });
            }
        }
    }

    // scope: 'staff', 'clients' or 'all'. Left out, it does what it always did: staff, and clients too when
    // AD_GROUP_CLIENTS is set. Nothing changes in dryRun, but every count is reported.
    async function syncDirectory({ dryRun = false, force = false, scope } = {}) {
        if (!provider) throw new DirectoryError('NOT_CONFIGURED', 'Directory sync needs AUTH_PROVIDER=ldap or entra.');
        if (scope !== undefined && !SCOPES.includes(scope)) {
            throw new DirectoryError('BAD_REQUEST', `scope must be one of ${SCOPES.join(', ')}.`);
        }
        const wantStaff = scope !== 'clients';
        const wantClients = scope === 'clients' || scope === 'all' || (scope === undefined && cfg.groups.clients.length > 0);

        const result = {
            dryRun, scope: scope || 'default', created: 0, updated: 0, revoked: 0, errors: [], clientsProvisioned: 0, clients: null,
        };
        const people = new Map();   // directory id -> staff profile with every group it was found through

        if (wantStaff) await syncStaff({ dryRun, force, result, people });
        if (wantClients) await syncClients({ dryRun, result, people });
        return result;
    }

    return {
        passwordSignIn, startEntraLogin, finishEntraLogin, exchangeTicket, syncDirectory,
        localClientSignIn, assertEmailNotInDirectory,
    };
}

module.exports = { createDirectoryAuth, roles };
