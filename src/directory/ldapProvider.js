// On-premises Active Directory over LDAP(S).
//
// Sign-in works in three steps, none of which ever stores or logs the person's password:
//   1. bind with the read-only service account and find the person's entry (by sAMAccountName, UPN or mail)
//   2. bind AS that person with the password they typed: the domain controller decides if it is right
//      (and applies the domain's lockout, expiry and disabled-account rules)
//   3. with the service account, read their groups (including nested ones) so roles can be mapped
//
// The domain controller is the only thing that ever sees the password.

const fs = require('fs');
const { Client, InvalidCredentialsError } = require('ldapts');
const { DirectoryError } = require('./errors');
const {
    escapeFilterValue, guidFromBuffer, adSubCode, normaliseUsername, asArray, asString, cnFromDn, isDisabled,
} = require('./ldapUtils');

const IN_CHAIN = '1.2.840.113556.1.4.1941';   // LDAP_MATCHING_RULE_IN_CHAIN: follows nested group membership
const PAGE_SIZE = 500;

const USER_ATTRIBUTES = [
    'sAMAccountName', 'userPrincipalName', 'mail', 'givenName', 'sn', 'displayName',
    'telephoneNumber', 'mobile', 'department', 'title', 'userAccountControl', 'objectGUID', 'memberOf',
];

const BIND_FAILURES = {
    '52e': ['INVALID_CREDENTIALS', 'Invalid username or password.'],
    '525': ['INVALID_CREDENTIALS', 'Invalid username or password.'],
    '530': ['ACCOUNT_DISABLED',    'Your account is not allowed to sign in at this time.'],
    '531': ['ACCOUNT_DISABLED',    'Your account is not allowed to sign in from this location.'],
    '532': ['PASSWORD_EXPIRED',    'Your password has expired. Change it on your Windows account, then sign in again.'],
    '533': ['ACCOUNT_DISABLED',    'Your account is disabled. Please contact the service desk.'],
    '701': ['ACCOUNT_DISABLED',    'Your account has expired. Please contact the service desk.'],
    '773': ['PASSWORD_EXPIRED',    'You must change your password on your Windows account before signing in.'],
    '775': ['ACCOUNT_LOCKED',      'Your account is locked. Please try again later or contact the service desk.'],
};

function createLdapProvider(cfg, { ClientClass = Client, readFile = fs.readFileSync, log = console } = {}) {
    const l = cfg.ldap;

    const tlsOptions = { rejectUnauthorized: l.rejectUnauthorized };
    if (l.caFile) tlsOptions.ca = [readFile(l.caFile)];

    async function connect() {
        // Passing tlsOptions to the constructor makes ldapts speak TLS even on ldap://, so only ldaps:// gets them;
        // StartTLS receives its options in the call below.
        const options = { url: l.url, timeout: l.timeoutMs, connectTimeout: l.timeoutMs };
        if (/^ldaps:/i.test(l.url)) options.tlsOptions = tlsOptions;
        const client = new ClientClass(options);
        try {
            if (l.startTls && /^ldap:/i.test(l.url)) await client.startTLS(tlsOptions);
        } catch (err) {
            await safeUnbind(client);
            throw unavailable(err);
        }
        return client;
    }

    const safeUnbind = async (client) => { try { await client.unbind(); } catch (_) { /* connection already closed */ } };

    function unavailable(err) {
        log.error(`LDAP directory unavailable: ${err?.message || err}`);
        return new DirectoryError('DIRECTORY_UNAVAILABLE', 'The directory could not be reached. Please try again in a few minutes.');
    }

    async function bindServiceAccount(client) {
        try {
            await client.bind(l.bindDn, l.bindPassword);
        } catch (err) {
            // Wrong service-account credentials are our configuration problem, not the person's.
            log.error(`LDAP service-account bind failed: ${err?.message || err}`);
            throw new DirectoryError('DIRECTORY_UNAVAILABLE', 'The directory could not be reached. Please try again in a few minutes.');
        }
    }

    // `paged` asks the server for the answer in pages: AD refuses to return more than 1000 entries in one go.
    async function search(client, base, filter, attributes, { paged = false } = {}) {
        try {
            const { searchEntries } = await client.search(base, {
                scope: 'sub', filter, attributes, explicitBufferAttributes: ['objectGUID'],
                ...(paged ? { paged: { pageSize: PAGE_SIZE } } : {}),
            });
            return searchEntries;
        } catch (err) {
            throw unavailable(err);
        }
    }

    async function findUser(client, username) {
        const filter = l.userFilter.split('{{username}}').join(escapeFilterValue(username));
        const entries = await search(client, l.baseDn, filter, USER_ATTRIBUTES);
        if (entries.length > 1) {
            throw new DirectoryError('INVALID_CREDENTIALS', 'Invalid username or password.');   // ambiguous: refuse rather than guess
        }
        return entries[0] || null;
    }

    async function groupNames(client, entry) {
        const names = new Set();
        const add = (...values) => values.filter(Boolean).forEach((v) => names.add(v));

        if (l.nestedGroups) {
            const groups = await search(
                client, l.groupBaseDn, `(&(objectClass=group)(member:${IN_CHAIN}:=${escapeFilterValue(entry.dn)}))`,
                ['cn', 'sAMAccountName'],
            );
            groups.forEach((g) => add(g.dn, asString(g.cn), asString(g.sAMAccountName)));
        } else {
            asArray(entry.memberOf).map(asString).forEach((dn) => add(dn, cnFromDn(dn)));
        }
        return [...names];
    }

    function toProfile(entry, groups) {
        const externalId = guidFromBuffer(Buffer.isBuffer(entry.objectGUID) ? entry.objectGUID : asArray(entry.objectGUID)[0]);
        if (!externalId) {
            throw new DirectoryError('DIRECTORY_UNAVAILABLE', 'The directory did not return an account id (objectGUID).');
        }
        const upn = asString(entry.userPrincipalName);
        return {
            externalId,
            upn,
            email: asString(entry.mail) || upn,
            firstName: asString(entry.givenName),
            lastName: asString(entry.sn),
            displayName: asString(entry.displayName),
            phone: asString(entry.mobile) || asString(entry.telephoneNumber),
            department: asString(entry.department),
            employeeId: asString(entry[l.persalAttribute]),
            username: asString(entry.sAMAccountName),
            groups,
        };
    }

    // Verifies the password and returns the person's directory profile.
    async function authenticate(rawUsername, password) {
        const username = normaliseUsername(rawUsername);
        // An empty password makes many LDAP servers treat the bind as ANONYMOUS and succeed. Never let it through.
        if (!username || typeof password !== 'string' || password.length === 0) {
            throw new DirectoryError('INVALID_CREDENTIALS', 'Invalid username or password.');
        }

        const svc = await connect();
        try {
            await bindServiceAccount(svc);

            const entry = await findUser(svc, username);
            if (!entry) throw new DirectoryError('INVALID_CREDENTIALS', 'Invalid username or password.');

            const userClient = await connect();
            try {
                await userClient.bind(entry.dn, password);
            } catch (err) {
                if (err instanceof InvalidCredentialsError || err?.code === 49) {
                    const [code, message] = BIND_FAILURES[adSubCode(err)] || BIND_FAILURES['52e'];
                    throw new DirectoryError(code, message);
                }
                throw unavailable(err);
            } finally {
                await safeUnbind(userClient);
            }

            // Reached only with a correct password, so these answers cannot be used to probe for accounts.
            if (isDisabled(entry.userAccountControl)) {
                throw new DirectoryError('ACCOUNT_DISABLED', 'Your account is disabled. Please contact the service desk.');
            }

            return toProfile(entry, await groupNames(svc, entry));
        } finally {
            await safeUnbind(svc);
        }
    }

    // The DN of a group given as a DN, CN or sAMAccountName (null when no such group exists).
    async function resolveGroupDn(svc, group) {
        if (group.includes('=')) return group;
        const e = escapeFilterValue(group);
        const found = await search(svc, l.groupBaseDn, `(&(objectClass=group)(|(cn=${e})(sAMAccountName=${e})))`, ['cn']);
        return found.length === 0 ? null : found[0].dn;
    }

    // Enabled people in the group, directly or through nested groups.
    async function enabledMembers(svc, group) {
        const groupDn = await resolveGroupDn(svc, group);
        if (!groupDn) return [];
        const members = await search(
            svc, l.baseDn,
            `(&(objectCategory=person)(objectClass=user)(memberOf:${IN_CHAIN}:=${escapeFilterValue(groupDn)}))`,
            USER_ATTRIBUTES, { paged: true },
        );
        return members.filter((entry) => !isDisabled(entry.userAccountControl));
    }

    // Everyone (directly or through nested groups) in the named group: used by the directory sync.
    // `group` is a group DN, CN or sAMAccountName.
    async function listGroupMembers(group) {
        const svc = await connect();
        try {
            await bindServiceAccount(svc);
            const profiles = [];
            for (const entry of await enabledMembers(svc, group)) {
                profiles.push(toProfile(entry, await groupNames(svc, entry)));
            }
            return profiles;
        } finally {
            await safeUnbind(svc);
        }
    }

    // Just the directory ids of the people in a group: one search, no per-person group lookups.
    async function listGroupMemberIds(group) {
        const svc = await connect();
        try {
            await bindServiceAccount(svc);
            return (await enabledMembers(svc, group)).map((entry) => toProfile(entry, []).externalId);
        } finally {
            await safeUnbind(svc);
        }
    }

    // Every enabled person who has an email address or a UPN (what the client sync imports when no clients group
    // is configured). LDAP_SYNC_BASE_DN narrows where to look; LDAP_SYNC_FILTER leaves out service accounts.
    // Their groups are not looked up here: the sync asks for the few groups it needs with listGroupMemberIds.
    async function listUsers() {
        const svc = await connect();
        try {
            await bindServiceAccount(svc);
            const base = '(&(objectCategory=person)(objectClass=user)(|(mail=*)(userPrincipalName=*)))';
            const filter = l.syncFilter ? `(&${base}${l.syncFilter})` : base;
            const entries = await search(svc, l.syncBaseDn, filter, USER_ATTRIBUTES, { paged: true });

            const profiles = [];
            for (const entry of entries) {
                if (isDisabled(entry.userAccountControl)) continue;
                try {
                    profiles.push(toProfile(entry, []));
                } catch (err) {
                    log.error(`LDAP sync skipped ${entry.dn}: ${err.message}`);   // an entry with no objectGUID must not stop the rest
                }
            }
            return profiles;
        } finally {
            await safeUnbind(svc);
        }
    }

    // Does the directory already know this email address? Used to stop someone registering a separate password
    // account for an address that belongs to an organisation account.
    async function emailExists(email) {
        const svc = await connect();
        try {
            await bindServiceAccount(svc);
            const e = escapeFilterValue(String(email).trim());
            const found = await search(
                svc, l.baseDn, `(&(objectCategory=person)(objectClass=user)(|(mail=${e})(userPrincipalName=${e})))`, ['objectGUID'],
            );
            return found.length > 0;
        } finally {
            await safeUnbind(svc);
        }
    }

    return { name: 'ldap', authenticate, listGroupMembers, listGroupMemberIds, listUsers, emailExists };
}

module.exports = { createLdapProvider, BIND_FAILURES };
