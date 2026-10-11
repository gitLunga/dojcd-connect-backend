// A stand-in for Microsoft Entra ID: the token endpoint, the signing keys and the slice of Microsoft Graph
// that the backend uses. It signs real RS256 ID tokens and enforces PKCE and the client secret, so the
// provider's verification is exercised for real. It is a test double, not Microsoft: the real thing is
// only checked by pointing the backend at a tenant (see docs/directory-sign-in.md).

const http = require('node:http');
const crypto = require('node:crypto');
const { generateKeyPair, exportJWK, SignJWT } = require('jose');

const TENANT = '11111111-2222-4333-8444-555555555555';
const CLIENT_ID = '99999999-8888-4777-8666-555555555555';
const SECRET = 'entra-client-secret';
const REDIRECT = 'https://api.example.test/api/auth/entra/callback';

const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
const readForm = (req) => new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => resolve(Object.fromEntries(new URLSearchParams(raw))));
});

async function startMockEntra({ pageSize = 2 } = {}) {
    const good = await generateKeyPair('RS256');
    const rogue = await generateKeyPair('RS256');          // a key Microsoft does not publish
    const jwk = { ...(await exportJWK(good.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };

    const codes = new Map();            // authorization code -> what the browser sign-in produced
    const accessTokens = new Map();     // access token -> user
    const mock = { codes, failGraph: false, failGroups: false, failKeys: false, tokenRequests: [], users: [], groupMembers: {} };
    let base = '';

    const issuer = () => `${base}/${TENANT}/v2.0`;

    async function idToken(user, { nonce, aud = CLIENT_ID, iss = issuer(), expired = false, signWith = 'good', noNonce = false, tid = TENANT, extra = {} }) {
        const now = Math.floor(Date.now() / 1000);
        const jwt = new SignJWT({
            oid: user.oid, tid, preferred_username: user.upn, name: user.displayName, email: user.mail,
            given_name: user.givenName, family_name: user.surname, ...(noNonce ? {} : { nonce }), ...extra,
        })
            .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
            .setIssuer(iss).setAudience(aud).setSubject(`sub-${user.oid}`)
            .setIssuedAt(expired ? now - 7200 : now).setExpirationTime(expired ? now - 3600 : now + 3600);
        return jwt.sign(signWith === 'rogue' ? rogue.privateKey : good.privateKey);
    }

    const graphUser = (u) => ({
        id: u.oid, displayName: u.displayName, givenName: u.givenName, surname: u.surname, mail: u.mail,
        userPrincipalName: u.upn, mobilePhone: u.mobilePhone || null, businessPhones: [], department: u.department || null,
        employeeId: u.employeeId || null, accountEnabled: u.accountEnabled !== false,
    });

    const page = (items, req, res, path) => {
        const url = new URL(req.url, base);
        const n = parseInt(url.searchParams.get('page') || '0', 10);
        const slice = items.slice(n * pageSize, (n + 1) * pageSize);
        const more = (n + 1) * pageSize < items.length;
        json(res, 200, { value: slice, ...(more ? { '@odata.nextLink': `${base}${path}?page=${n + 1}` } : {}) });
    };

    const server = http.createServer(async (req, res) => {
        const url = new URL(req.url, base || 'http://localhost');
        const bearer = (req.headers.authorization || '').replace(/^Bearer /, '');

        if (url.pathname === `/${TENANT}/discovery/v2.0/keys`) {
            return mock.failKeys ? json(res, 500, {}) : json(res, 200, { keys: [jwk] });
        }

        if (url.pathname === `/${TENANT}/oauth2/v2.0/token` && req.method === 'POST') {
            const f = await readForm(req);
            mock.tokenRequests.push(f);
            if (f.client_id !== CLIENT_ID || f.client_secret !== SECRET) return json(res, 401, { error: 'invalid_client' });

            if (f.grant_type === 'client_credentials') {
                accessTokens.set('app-token', { app: true });
                return json(res, 200, { access_token: 'app-token', token_type: 'Bearer' });
            }

            const entry = codes.get(f.code);
            if (!entry || entry.used || f.redirect_uri !== REDIRECT) return json(res, 400, { error: 'invalid_grant' });
            const challenge = crypto.createHash('sha256').update(f.code_verifier || '').digest('base64url');
            if (challenge !== entry.challenge) return json(res, 400, { error: 'invalid_grant', error_description: 'PKCE verification failed' });
            entry.used = true;

            const access = `access-${crypto.randomBytes(8).toString('hex')}`;
            accessTokens.set(access, entry.user);
            return json(res, 200, { token_type: 'Bearer', access_token: access, id_token: await idToken(entry.user, entry) });
        }

        // ── Microsoft Graph ──
        if (url.pathname.startsWith('/v1.0/')) {
            const who = accessTokens.get(bearer);
            if (!who) return json(res, 401, { error: { code: 'InvalidAuthenticationToken' } });
            if (mock.failGraph) return json(res, 503, { error: { code: 'ServiceUnavailable' } });

            if (url.pathname === '/v1.0/me') return json(res, 200, graphUser(who));
            if (url.pathname === '/v1.0/me/transitiveMemberOf/microsoft.graph.group') {
                if (mock.failGroups) return json(res, 503, {});
                return page((who.groups || []).map((g) => ({ '@odata.type': '#microsoft.graph.group', ...g })), req, res, url.pathname);
            }
            if (url.pathname === '/v1.0/groups') {
                const m = /displayName eq '(.*)'/.exec(url.searchParams.get('$filter') || '');
                const name = m ? m[1].replace(/''/g, "'") : '';
                const found = Object.values(mock.groupMembers).filter((g) => g.displayName === name).map((g) => ({ id: g.id }));
                return json(res, 200, { value: found });
            }
            const members = /^\/v1\.0\/groups\/([^/]+)\/transitiveMembers\/microsoft\.graph\.user$/.exec(url.pathname);
            if (members) {
                const g = mock.groupMembers[decodeURIComponent(members[1])];
                return page((g?.members || []).map(graphUser), req, res, url.pathname);
            }
        }
        json(res, 404, { error: 'not_found' });
    });

    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;

    // What Microsoft does after the person signs in: hand the browser a one-time code.
    mock.issueCode = (user, { nonce, challenge, ...options }) => {
        const code = `code-${crypto.randomBytes(8).toString('hex')}`;
        codes.set(code, { user, nonce, challenge, ...options });
        return code;
    };
    mock.url = base;
    mock.close = () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); });
    return mock;
}

const person = (over = {}) => ({
    oid: 'aaaaaaaa-1111-4222-8333-444444444444', upn: 'jane.mokoena@dojcd.onmicrosoft.com', mail: 'jane.mokoena@dojcd.gov.za',
    givenName: 'Jane', surname: 'Mokoena', displayName: 'Jane Mokoena', department: 'DoJ&CD Gauteng', employeeId: '12345678',
    mobilePhone: '0821234567', groups: [], ...over,
});

module.exports = { startMockEntra, person, TENANT, CLIENT_ID, SECRET, REDIRECT };
