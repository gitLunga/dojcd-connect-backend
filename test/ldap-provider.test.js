const test = require('node:test');
const assert = require('node:assert/strict');

const { loadDirectoryConfig } = require('../src/directory/config');
const { createLdapProvider } = require('../src/directory/ldapProvider');
const { guidFromBuffer, escapeFilterValue, normaliseUsername, cnFromDn } = require('../src/directory/ldapUtils');
const { startMockAd, user, guidBytes, BASE } = require('./helpers/mockAd');

const quiet = { error() {} };   // the provider logs directory outages; keep test output clean

const config = (url, over = {}) => loadDirectoryConfig({
    AUTH_PROVIDER: 'ldap', LDAP_URL: url, LDAP_ALLOW_INSECURE: 'true',
    LDAP_BIND_DN: `CN=svc-dojcd,OU=Service,${BASE}`, LDAP_BIND_PASSWORD: 'service-secret', LDAP_BASE_DN: BASE,
    ...over,
});

const staffGroup = { dn: `CN=DOJCD-Managers,OU=Groups,${BASE}`, cn: 'DOJCD-Managers' };
const gauteng    = { dn: `CN=Gauteng Staff,OU=Groups,${BASE}`,    cn: 'Gauteng Staff' };

function directory() {
    const jane = user({ given: 'Jane', sn: 'Mokoena', sam: 'jmokoena', employeeId: '12345678', department: 'DoJ&CD Gauteng', mobile: '0821234567' });
    const locked = user({ given: 'Lee', sn: 'Locked', sam: 'llocked', guid: 'aaaaaaaa-0000-4000-8000-000000000001', bindError: '775' });
    const expired = user({ given: 'Eve', sn: 'Expired', sam: 'eexpired', guid: 'aaaaaaaa-0000-4000-8000-000000000002', bindError: '532' });
    const disabled = user({ given: 'Dan', sn: 'Disabled', sam: 'ddisabled', guid: 'aaaaaaaa-0000-4000-8000-000000000003', uac: '514' });
    return {
        users: [jane, locked, expired, disabled],
        // Jane is in Gauteng Staff, which is itself a member of DOJCD-Managers: she is a manager only through nesting.
        groups: [
            { ...gauteng, members: [jane.dn] },
            { ...staffGroup, members: [gauteng.dn] },
        ],
        jane,
    };
}

test('guidFromBuffer reads Microsoft mixed-endian GUIDs', () => {
    assert.equal(guidFromBuffer(guidBytes('11223344-5566-7788-99aa-bbccddeeff00')), '11223344-5566-7788-99aa-bbccddeeff00');
    assert.equal(guidFromBuffer(Buffer.from('short')), null);
    assert.equal(guidFromBuffer('not a buffer'), null);
});

test('filter values are escaped so a username cannot rewrite the search', () => {
    assert.equal(escapeFilterValue('a*)(uid=*'), 'a\\2a\\29\\28uid=\\2a');
    assert.equal(escapeFilterValue('back\\slash'), 'back\\5cslash');
    assert.equal(normaliseUsername('  EXAMPLE\\jsmith '), 'jsmith');
    assert.equal(cnFromDn('CN=Doe\\, John,OU=x,DC=y'), 'Doe, John');
});

test('a correct password returns the profile, with nested groups', async () => {
    const dir = directory();
    const ad = await startMockAd(dir);
    try {
        const provider = createLdapProvider(config(ad.url), { log: quiet });
        const profile = await provider.authenticate('jmokoena', 'Correct-Horse-9');

        assert.equal(profile.externalId, '11223344-5566-7788-99aa-bbccddeeff00');
        assert.equal(profile.email, 'jmokoena@dojcd.gov.za');
        assert.equal(profile.upn, 'jmokoena@example.local');
        assert.equal(profile.firstName, 'Jane');
        assert.equal(profile.lastName, 'Mokoena');
        assert.equal(profile.phone, '0821234567');
        assert.equal(profile.department, 'DoJ&CD Gauteng');
        assert.equal(profile.employeeId, '12345678');
        assert.ok(profile.groups.includes('Gauteng Staff'));
        assert.ok(profile.groups.includes('DOJCD-Managers'), 'nested membership must be followed');
        assert.ok(profile.groups.includes(staffGroup.dn), 'full DNs are offered too');
    } finally { await ad.close(); }
});

test('sign-in works with the UPN, the email, or DOMAIN\\user', async () => {
    const dir = directory();
    const ad = await startMockAd(dir);
    try {
        const provider = createLdapProvider(config(ad.url), { log: quiet });
        for (const who of ['jmokoena@example.local', 'jmokoena@dojcd.gov.za', 'EXAMPLE\\jmokoena', 'JMOKOENA']) {
            const profile = await provider.authenticate(who, 'Correct-Horse-9');
            assert.equal(profile.username, 'jmokoena', who);
        }
    } finally { await ad.close(); }
});

test('a wrong password, an unknown user and an empty password are all refused the same way', async () => {
    const ad = await startMockAd({ ...directory(), allowAnonymous: true });   // anonymous binds would succeed
    try {
        const provider = createLdapProvider(config(ad.url), { log: quiet });
        for (const [who, pw] of [['jmokoena', 'wrong'], ['nobody', 'Correct-Horse-9'], ['jmokoena', ''], ['', 'x'], ['jmokoena', undefined]]) {
            await assert.rejects(provider.authenticate(who, pw), { code: 'INVALID_CREDENTIALS', status: 401, message: 'Invalid username or password.' }, `${who}/${pw}`);
        }
    } finally { await ad.close(); }
});

test('locked and expired accounts get a specific message, and only after the password was right', async () => {
    const ad = await startMockAd(directory());
    try {
        const provider = createLdapProvider(config(ad.url), { log: quiet });
        await assert.rejects(provider.authenticate('llocked', 'Correct-Horse-9'), { code: 'ACCOUNT_LOCKED' });
        await assert.rejects(provider.authenticate('eexpired', 'Correct-Horse-9'), { code: 'PASSWORD_EXPIRED' });
    } finally { await ad.close(); }
});

test('a disabled account is refused without revealing that it exists to someone with the wrong password', async () => {
    const ad = await startMockAd(directory());
    try {
        const provider = createLdapProvider(config(ad.url), { log: quiet });
        await assert.rejects(provider.authenticate('ddisabled', 'Correct-Horse-9'), { code: 'ACCOUNT_DISABLED' });
        await assert.rejects(provider.authenticate('ddisabled', 'guess'), { code: 'INVALID_CREDENTIALS' });
    } finally { await ad.close(); }
});

test('a username cannot inject LDAP filter syntax', async () => {
    const ad = await startMockAd(directory());
    try {
        const provider = createLdapProvider(config(ad.url), { log: quiet });
        for (const evil of ['*', 'jmokoena)(objectClass=*', '*)(sAMAccountName=*']) {
            await assert.rejects(provider.authenticate(evil, 'Correct-Horse-9'), { code: 'INVALID_CREDENTIALS' }, evil);
        }
        // If escaping failed, the evil text would have become extra clauses in the filter.
        const clauses = ad.searches.filter((f) => /\(objectClass=\*\)|\(sAMAccountName=\*\)/.test(f));
        assert.deepEqual(clauses, [], 'the injected clauses must stay inside the escaped value');
        assert.ok(ad.searches.some((f) => f.includes('\\2a')), 'the wildcard arrived escaped');
    } finally { await ad.close(); }
});

test('the wrong service-account password and an unreachable server both report the directory as unavailable', async () => {
    const ad = await startMockAd(directory());
    try {
        const badService = createLdapProvider(config(ad.url, { LDAP_BIND_PASSWORD: 'nope' }), { log: quiet });
        await assert.rejects(badService.authenticate('jmokoena', 'Correct-Horse-9'), { code: 'DIRECTORY_UNAVAILABLE', status: 503 });
    } finally { await ad.close(); }

    const down = createLdapProvider(config('ldap://127.0.0.1:1', { LDAP_TIMEOUT_MS: '1500' }), { log: quiet });
    await assert.rejects(down.authenticate('jmokoena', 'Correct-Horse-9'), { code: 'DIRECTORY_UNAVAILABLE' });
});

test('direct memberOf is used when nested lookups are switched off', async () => {
    const ad = await startMockAd(directory());
    try {
        const provider = createLdapProvider(config(ad.url, { LDAP_NESTED_GROUPS: 'false' }), { log: quiet });
        const profile = await provider.authenticate('jmokoena', 'Correct-Horse-9');
        assert.ok(profile.groups.includes('Gauteng Staff'));
        assert.ok(!profile.groups.includes('DOJCD-Managers'), 'only direct groups without the nested rule');
    } finally { await ad.close(); }
});

test('listGroupMembers finds nested members by group name and skips disabled accounts', async () => {
    const dir = directory();
    dir.groups[0].members.push(dir.users[3].dn);           // the disabled user is also in Gauteng Staff
    const ad = await startMockAd(dir);
    try {
        const provider = createLdapProvider(config(ad.url), { log: quiet });
        const members = await provider.listGroupMembers('DOJCD-Managers');
        assert.deepEqual(members.map((m) => m.username), ['jmokoena']);
        assert.deepEqual(await provider.listGroupMembers('No-Such-Group'), []);
    } finally { await ad.close(); }
});
