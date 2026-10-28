// Microsoft Entra ID (Azure AD) sign-in: OpenID Connect authorization-code flow with PKCE, run by
// the server (a "confidential client") so the client secret and the tokens never reach a browser.
//
//   1. buildAuthorizeUrl  -> the browser goes to Microsoft and signs in (with MFA, conditional access...)
//   2. Microsoft redirects back to the API with ?code=
//   3. completeSignIn     -> the server swaps the code for tokens, VERIFIES the ID token (signature, issuer,
//                            audience, expiry, nonce) and reads the person's profile and groups from Microsoft Graph
//
// Only the delegated permission User.Read is needed for sign-in (granted by the person, no admin consent).
// The optional directory sync additionally uses application permissions (see docs/directory-sign-in.md).

const crypto = require('crypto');
const { createRemoteJWKSet, jwtVerify } = require('jose');
const { DirectoryError } = require('./errors');

const SIGN_IN_SCOPES = 'openid profile email User.Read';
const PROFILE_FIELDS = 'id,displayName,givenName,surname,mail,userPrincipalName,mobilePhone,businessPhones,department,employeeId,accountEnabled';
const HTTP_TIMEOUT_MS = 10000;
const MAX_PAGES = 20;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// PKCE (RFC 7636), S256.
function createPkce() {
    const verifier = crypto.randomBytes(48).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    return { verifier, challenge };
}

function createEntraProvider(cfg, { fetchImpl = globalThis.fetch, log = console } = {}) {
    const e = cfg.entra;
    const needsGroups = Object.values(cfg.groups).some((list) => list.length > 0);

    const authority = `${e.authorityHost}/${encodeURIComponent(e.tenantId)}`;
    const endpoints = {
        authorize: `${authority}/oauth2/v2.0/authorize`,
        token:     `${authority}/oauth2/v2.0/token`,
        jwks:      `${authority}/discovery/v2.0/keys`,
        issuer:    `${authority}/v2.0`,
        graph:     `${e.graphHost}/v1.0`,
    };

    let keySet;   // fetched lazily and cached (with key rotation) by jose
    const keys = () => (keySet ||= createRemoteJWKSet(new URL(endpoints.jwks), { timeoutDuration: HTTP_TIMEOUT_MS }));

    function unavailable(err) {
        log.error(`Entra ID unavailable: ${err?.message || err}`);
        return new DirectoryError('DIRECTORY_UNAVAILABLE', 'Microsoft sign-in is not available right now. Please try again in a few minutes.');
    }

    async function http(url, options = {}) {
        try {
            return await fetchImpl(url, { ...options, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
        } catch (err) {
            throw unavailable(err);
        }
    }

    async function postToken(params) {
        const res = await http(endpoints.token, {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ client_id: e.clientId, client_secret: e.clientSecret, ...params }),
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
            // An expired, reused or tampered code (or a wrong PKCE verifier) is the person's problem; anything else is ours.
            if (body.error === 'invalid_grant') {
                throw new DirectoryError('INVALID_CREDENTIALS', 'Your sign-in expired or was already used. Please sign in again.');
            }
            throw unavailable(new Error(`token endpoint ${res.status} ${body.error || ''} ${body.error_description || ''}`.trim()));
        }
        return body;
    }

    async function graph(token, pathOrUrl) {
        const url = pathOrUrl.startsWith('http') ? pathOrUrl : `${endpoints.graph}${pathOrUrl}`;
        const res = await http(url, { headers: { authorization: `Bearer ${token}` } });
        if (!res.ok) throw unavailable(new Error(`Graph ${res.status} for ${url.split('?')[0]}`));
        return res.json();
    }

    async function graphPages(token, path) {
        const items = [];
        let next = path;
        for (let page = 0; next && page < MAX_PAGES; page++) {
            const body = await graph(token, next);
            items.push(...(body.value || []));
            next = body['@odata.nextLink'];
        }
        return items;
    }

    const toProfile = (g = {}, claims = {}, groups = []) => {
        const upn = g.userPrincipalName || claims.preferred_username || claims.upn || '';
        return {
            externalId: claims.oid || g.id,
            upn,
            email: g.mail || claims.email || upn,
            firstName: g.givenName || claims.given_name || '',
            lastName: g.surname || claims.family_name || '',
            displayName: g.displayName || claims.name || '',
            phone: g.mobilePhone || (g.businessPhones || [])[0] || '',
            department: g.department || '',
            employeeId: g.employeeId || '',
            groups,
        };
    };

    // The URL to send the browser to. `state` and `nonce` come from the caller, who stores them.
    function buildAuthorizeUrl({ state, nonce, challenge }) {
        const url = new URL(endpoints.authorize);
        url.search = new URLSearchParams({
            client_id: e.clientId,
            response_type: 'code',
            redirect_uri: e.redirectUri,
            response_mode: 'query',
            scope: SIGN_IN_SCOPES,
            state,
            nonce,
            code_challenge: challenge,
            code_challenge_method: 'S256',
            prompt: 'select_account',
        }).toString();
        return url.toString();
    }

    async function verifyIdToken(idToken, nonce) {
        let payload;
        try {
            ({ payload } = await jwtVerify(idToken, keys(), {
                issuer: endpoints.issuer, audience: e.clientId, algorithms: ['RS256'], clockTolerance: 60,
            }));
        } catch (err) {
            // Failing to FETCH Microsoft's signing keys is an outage; a bad signature, issuer, audience or expiry is not.
            if (['ERR_JWKS_TIMEOUT', 'ERR_JOSE_GENERIC'].includes(err?.code)) throw unavailable(err);
            log.error(`Entra ID token rejected: ${err?.code || err?.message}`);
            throw new DirectoryError('INVALID_CREDENTIALS', 'Microsoft sign-in could not be verified. Please try again.');
        }
        if (!payload.nonce || payload.nonce !== nonce) {
            throw new DirectoryError('INVALID_CREDENTIALS', 'Microsoft sign-in could not be verified. Please try again.');
        }
        if (!payload.oid) throw new DirectoryError('DIRECTORY_UNAVAILABLE', 'Microsoft did not return an account id.');
        return payload;
    }

    // Swap the code for tokens, verify the ID token, and return the person's directory profile.
    async function completeSignIn({ code, verifier, nonce }) {
        if (!code || !verifier || !nonce) throw new DirectoryError('BAD_REQUEST', 'The sign-in could not be completed. Please start again.');

        const tokens = await postToken({
            grant_type: 'authorization_code', code, redirect_uri: e.redirectUri, code_verifier: verifier, scope: SIGN_IN_SCOPES,
        });
        const claims = await verifyIdToken(tokens.id_token, nonce);

        let me = {};
        try {
            me = await graph(tokens.access_token, `/me?$select=${PROFILE_FIELDS}`);
        } catch (err) {
            log.error(`Graph profile unavailable, using ID token claims: ${err.message}`);   // names/email are in the token anyway
        }

        let groups = [];
        if (needsGroups) {
            // Always ask Graph: it also covers the "too many groups" case where the ID token carries no groups.
            try {
                const found = await graphPages(tokens.access_token, '/me/transitiveMemberOf/microsoft.graph.group?$select=id,displayName&$top=999');
                groups = found.flatMap((g) => [g.id, g.displayName]).filter(Boolean);
            } catch (err) {
                const fromToken = Array.isArray(claims.groups) && !claims._claim_names ? claims.groups : null;
                if (!fromToken) throw err;                // without groups we cannot decide roles: refuse rather than guess
                groups = fromToken;
            }
        }
        return toProfile(me, claims, groups);
    }

    // ── directory sync (application permissions: GroupMember.Read.All + User.Read.All) ──────────

    async function appToken() {
        const body = await postToken({ grant_type: 'client_credentials', scope: `${e.graphHost}/.default` });
        return body.access_token;
    }

    // Everyone in the group, including through nested groups. `group` is an object id or a display name.
    async function listGroupMembers(group) {
        const token = await appToken();

        let groupId = group;
        if (!GUID.test(group)) {
            const filter = encodeURIComponent(`displayName eq '${String(group).replace(/'/g, "''")}'`);
            const found = await graphPages(token, `/groups?$filter=${filter}&$select=id`);
            if (found.length === 0) return [];
            groupId = found[0].id;
        }

        const members = await graphPages(
            token, `/groups/${encodeURIComponent(groupId)}/transitiveMembers/microsoft.graph.user?$select=${PROFILE_FIELDS}&$top=999`,
        );
        return members.filter((u) => u.accountEnabled !== false).map((u) => toProfile(u, { oid: u.id }, [group]));
    }

    // Just the object ids of the people in a group (the sync uses them to decide who is a magistrate, who is staff).
    async function listGroupMemberIds(group) {
        return (await listGroupMembers(group)).map((p) => p.externalId);
    }

    // Every enabled member of the organisation (guests are left out; they can still sign in themselves).
    async function listUsers() {
        const token = await appToken();
        const filter = encodeURIComponent('accountEnabled eq true');
        const users = await graphPages(token, `/users?$filter=${filter}&$select=${PROFILE_FIELDS},userType&$top=999`);
        return users
            .filter((u) => u.userType !== 'Guest' && (u.mail || u.userPrincipalName))
            .map((u) => toProfile(u, { oid: u.id }, []));
    }

    // Does the directory already know this email address? Needs the User.Read.All application permission.
    async function emailExists(email) {
        const token = await appToken();
        const value = String(email).trim().replace(/'/g, "''");
        const filter = encodeURIComponent(`mail eq '${value}' or userPrincipalName eq '${value}'`);
        const found = await graphPages(token, `/users?$filter=${filter}&$select=id&$top=1`);
        return found.length > 0;
    }

    return { name: 'entra', endpoints, buildAuthorizeUrl, completeSignIn, listGroupMembers, listGroupMemberIds, listUsers, emailExists };
}

module.exports = { createEntraProvider, createPkce, SIGN_IN_SCOPES, GUID };
