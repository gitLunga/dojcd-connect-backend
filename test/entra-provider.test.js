const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { loadDirectoryConfig, validateDirectoryConfig } = require('../src/directory/config');
const { createEntraProvider, createPkce } = require('../src/directory/entraProvider');
const { startMockEntra, person, TENANT, CLIENT_ID, SECRET, REDIRECT } = require('./helpers/mockEntra');

const quiet = { error() {} };

const env = (mock, over = {}) => ({
    AUTH_PROVIDER: 'entra', ENTRA_TENANT_ID: TENANT, ENTRA_CLIENT_ID: CLIENT_ID, ENTRA_CLIENT_SECRET: SECRET,
    ENTRA_REDIRECT_URI: REDIRECT, ENTRA_AUTHORITY_HOST: mock.url, ENTRA_GRAPH_HOST: mock.url,
    AUTH_ALLOWED_REDIRECTS: 'https://admin.example.test/auth/callback', AD_GROUP_ADMIN: 'DOJCD-Admins', ...over,
});
const provider = (mock, over, deps) => createEntraProvider(loadDirectoryConfig(env(mock, over)), { log: quiet, ...deps });

// Plays the browser: starts a sign-in, lets "Microsoft" authenticate the person, returns what the callback would carry.
function browser(mock, user, { token = {}, nonce = `n-${crypto.randomUUID()}`, verifier } = {}) {
    const pkce = createPkce();
    const code = mock.issueCode(user, { nonce, challenge: pkce.challenge, ...token });
    return { code, nonce, verifier: verifier ?? pkce.verifier };
}

const withMock = (fn, opts) => async () => {
    const mock = await startMockEntra(opts);
    try { await fn(mock); } finally { await mock.close(); }
};

test('the authorize URL carries state, nonce and an S256 PKCE challenge', withMock(async (mock) => {
    const p = provider(mock);
    const { verifier, challenge } = createPkce();
    assert.equal(challenge, crypto.createHash('sha256').update(verifier).digest('base64url'));

    const url = new URL(p.buildAuthorizeUrl({ state: 'st', nonce: 'no', challenge }));
    assert.equal(url.pathname, `/${TENANT}/oauth2/v2.0/authorize`);
    const q = Object.fromEntries(url.searchParams);
    assert.deepEqual(
        { ...q, scope: q.scope.split(' ').sort() },
        {
            client_id: CLIENT_ID, response_type: 'code', redirect_uri: REDIRECT, response_mode: 'query',
            scope: ['User.Read', 'email', 'openid', 'profile'], state: 'st', nonce: 'no',
            code_challenge: challenge, code_challenge_method: 'S256', prompt: 'select_account',
        },
    );
}));

test('a valid sign-in returns the profile and every group, across Graph pages', withMock(async (mock) => {
    const groups = ['a', 'b', 'c', 'd', 'e'].map((x, i) => ({ id: `0000000${i}-0000-4000-8000-000000000000`, displayName: `Group ${x}` }));
    groups.push({ id: 'bbbbbbbb-0000-4000-8000-000000000000', displayName: 'DOJCD-Admins' });
    const { code, nonce, verifier } = browser(mock, person({ groups }));

    const profile = await provider(mock).completeSignIn({ code, verifier, nonce });

    assert.equal(profile.externalId, 'aaaaaaaa-1111-4222-8333-444444444444');
    assert.equal(profile.upn, 'jane.mokoena@dojcd.onmicrosoft.com');
    assert.equal(profile.email, 'jane.mokoena@dojcd.gov.za');
    assert.equal(profile.firstName, 'Jane');
    assert.equal(profile.lastName, 'Mokoena');
    assert.equal(profile.department, 'DoJ&CD Gauteng');
    assert.equal(profile.employeeId, '12345678');
    assert.equal(profile.phone, '0821234567');
    for (const g of groups) { assert.ok(profile.groups.includes(g.id)); assert.ok(profile.groups.includes(g.displayName)); }
    assert.equal(profile.groups.length, groups.length * 2, 'all pages were read');
}));

test('the token request uses the client secret, the redirect URI and the PKCE verifier', withMock(async (mock) => {
    const { code, nonce, verifier } = browser(mock, person());
    await provider(mock).completeSignIn({ code, verifier, nonce });
    const req = mock.tokenRequests[0];
    assert.equal(req.grant_type, 'authorization_code');
    assert.equal(req.client_secret, SECRET);
    assert.equal(req.redirect_uri, REDIRECT);
    assert.equal(req.code_verifier, verifier);
}));

test('ID tokens that fail verification are all refused', withMock(async (mock) => {
    const p = provider(mock);
    const bad = {
        'wrong nonce':        { token: { nonce: 'attacker-nonce' }, expectNonce: 'my-nonce' },
        'no nonce':           { token: { noNonce: true } },
        'wrong audience':     { token: { aud: 'some-other-app' } },
        'wrong issuer':       { token: { iss: 'https://login.example.test/other-tenant/v2.0' } },
        'expired':            { token: { expired: true } },
        'signed by a rogue key': { token: { signWith: 'rogue' } },
    };
    for (const [name, spec] of Object.entries(bad)) {
        const nonce = spec.expectNonce || 'my-nonce';
        const { code, verifier } = browser(mock, person(), { nonce, token: { nonce, ...spec.token } });
        await assert.rejects(p.completeSignIn({ code, verifier, nonce }), { code: 'INVALID_CREDENTIALS' }, name);
    }
}));

test('a code can be used once, and only with the verifier it was started with', withMock(async (mock) => {
    const p = provider(mock);
    const first = browser(mock, person());
    await p.completeSignIn(first);
    await assert.rejects(p.completeSignIn(first), { code: 'INVALID_CREDENTIALS' }, 'replayed code');

    const stolen = browser(mock, person());
    await assert.rejects(p.completeSignIn({ ...stolen, verifier: createPkce().verifier }), { code: 'INVALID_CREDENTIALS' }, 'wrong PKCE verifier');
    await assert.rejects(p.completeSignIn({ code: 'made-up', verifier: 'x', nonce: 'y' }), { code: 'INVALID_CREDENTIALS' });
    await assert.rejects(p.completeSignIn({}), { code: 'BAD_REQUEST' });
}));

test('when Graph is down and roles need groups, sign-in is refused; with no group settings it still works from the token', withMock(async (mock) => {
    mock.failGroups = true;
    const needing = browser(mock, person());
    await assert.rejects(provider(mock).completeSignIn(needing), { code: 'DIRECTORY_UNAVAILABLE', status: 503 });

    const noGroupSettings = { ...env(mock) }; delete noGroupSettings.AD_GROUP_ADMIN;
    const plain = browser(mock, person());
    const profile = await createEntraProvider(loadDirectoryConfig(noGroupSettings), { log: quiet }).completeSignIn(plain);
    assert.equal(profile.email, 'jane.mokoena@dojcd.gov.za');
    assert.deepEqual(profile.groups, []);
}));

test('Graph being down for the profile falls back to the verified token claims', withMock(async (mock) => {
    mock.failGraph = true;
    const claimsGroups = ['bbbbbbbb-0000-4000-8000-000000000000'];
    const { code, nonce, verifier } = browser(mock, person(), { token: { extra: { groups: claimsGroups } } });
    const profile = await provider(mock).completeSignIn({ code, verifier, nonce });
    assert.equal(profile.upn, 'jane.mokoena@dojcd.onmicrosoft.com');
    assert.equal(profile.firstName, 'Jane');
    assert.deepEqual(profile.groups, claimsGroups);
}));

test('the "too many groups" overage marker is never trusted: groups come from Graph', withMock(async (mock) => {
    mock.failGroups = true;
    const overage = { _claim_names: { groups: 'src1' }, groups: ['forged-group-id'] };
    const { code, nonce, verifier } = browser(mock, person(), { token: { extra: overage } });
    await assert.rejects(provider(mock).completeSignIn({ code, verifier, nonce }), { code: 'DIRECTORY_UNAVAILABLE' });
}));

test('the signing keys being unreachable is an outage, not a bad password', withMock(async (mock) => {
    mock.failKeys = true;
    const { code, nonce, verifier } = browser(mock, person());
    await assert.rejects(provider(mock).completeSignIn({ code, verifier, nonce }), { code: 'DIRECTORY_UNAVAILABLE' });
}));

test('listGroupMembers resolves a display name, reads every page and skips disabled accounts', withMock(async (mock) => {
    const members = ['one', 'two', 'three'].map((n, i) => person({ oid: `0000000${i}-0000-4000-8000-00000000000${i}`, upn: `${n}@x.test`, mail: `${n}@x.test`, givenName: n }));
    members.push(person({ oid: 'dddddddd-0000-4000-8000-000000000000', upn: 'off@x.test', accountEnabled: false }));
    mock.groupMembers['cccccccc-0000-4000-8000-000000000000'] = { id: 'cccccccc-0000-4000-8000-000000000000', displayName: 'DOJCD-Managers', members };

    const p = provider(mock);
    const byName = await p.listGroupMembers('DOJCD-Managers');
    assert.deepEqual(byName.map((m) => m.firstName), ['one', 'two', 'three']);
    assert.deepEqual(byName[0].groups, ['DOJCD-Managers']);

    const byId = await p.listGroupMembers('cccccccc-0000-4000-8000-000000000000');
    assert.equal(byId.length, 3);
    assert.deepEqual(await p.listGroupMembers('No Such Group'), []);
    assert.equal(mock.tokenRequests.at(-1).grant_type, 'client_credentials');
}), { pageSize: 2 });

test('a wrong client secret is our configuration problem, not the person\'s', withMock(async (mock) => {
    const p = provider(mock, { ENTRA_CLIENT_SECRET: 'wrong' });
    await assert.rejects(p.listGroupMembers('x'), { code: 'DIRECTORY_UNAVAILABLE' });
    await assert.rejects(p.completeSignIn(browser(mock, person())), { code: 'DIRECTORY_UNAVAILABLE' });
}));

test('entra settings must be complete and use the tenant GUID', () => {
    const problems = (over) => validateDirectoryConfig(loadDirectoryConfig({ AUTH_PROVIDER: 'entra', ...over }));
    assert.equal(problems({}).length, 5);
    assert.ok(problems({
        ENTRA_TENANT_ID: 'contoso.onmicrosoft.com', ENTRA_CLIENT_ID: 'c', ENTRA_CLIENT_SECRET: 's', ENTRA_REDIRECT_URI: 'r', AUTH_ALLOWED_REDIRECTS: 'x',
    }).some((p) => p.includes('tenant GUID')));
    assert.deepEqual(problems({
        ENTRA_TENANT_ID: TENANT, ENTRA_CLIENT_ID: 'c', ENTRA_CLIENT_SECRET: 's', ENTRA_REDIRECT_URI: 'r', AUTH_ALLOWED_REDIRECTS: 'x',
    }), []);
});
