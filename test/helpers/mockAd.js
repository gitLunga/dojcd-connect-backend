// A small in-process LDAP server that behaves like the parts of Active Directory we rely on:
// simple binds with AD-style failure codes, user and group searches, objectGUID as 16 raw bytes,
// userAccountControl, and nested group membership (the LDAP_MATCHING_RULE_IN_CHAIN rule).
//
// It is a test double, not a real domain controller: the real thing is only ever checked by
// pointing the backend at one (see docs/directory-sign-in.md).

const ldap = require('ldapjs');
const Attribute = ldap.Attribute;

const BASE = 'DC=example,DC=local';
const SERVICE_DN = `CN=svc-dojcd,OU=Service,${BASE}`;
const IN_CHAIN = '1.2.840.113556.1.4.1941';

// 11223344-5566-7788-99aa-bbccddeeff00 in Microsoft's mixed-endian byte order.
const guidBytes = (guid) => {
    const h = guid.replace(/-/g, '');
    const b = Buffer.from(h, 'hex');
    return Buffer.concat([Buffer.from(b.subarray(0, 4)).reverse(), Buffer.from(b.subarray(4, 6)).reverse(),
        Buffer.from(b.subarray(6, 8)).reverse(), b.subarray(8, 16)]);
};


// AD explains a failed bind inside the message ("... data 775 ..."): ldapjs 3 sends it as diagnosticMessage.
const adFail = (res, next, sub) => {
    res.diagnosticMessage = `80090308: LdapErr: DSID-0C090447, comment: AcceptSecurityContext error, data ${sub}, v4563`;
    res.end(ldap.LDAP_INVALID_CREDENTIALS);
    return next();
};

const unescapeFilter = (s) => s.replace(/\\([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));

function startMockAd({ users = [], groups = [], servicePassword = 'service-secret', allowAnonymous = false } = {}) {
    const searches = [];                 // every filter the server received, for assertions
    const server = ldap.createServer();
    const lc = (s) => String(s).toLowerCase();

    const userByDn = (dn) => users.find((u) => lc(u.dn) === lc(dn));

    // Groups a DN belongs to, directly or through other groups.
    const groupsOf = (dn, seen = new Set()) => {
        const out = [];
        for (const g of groups) {
            if (g.members.map(lc).includes(lc(dn)) && !seen.has(lc(g.dn))) {
                seen.add(lc(g.dn));
                out.push(g, ...groupsOf(g.dn, seen));
            }
        }
        return out;
    };

    server.bind('', (req, res, next) => {
        const dn = req.dn.toString();
        const pw = req.credentials;
        const ok = () => { res.end(); return next(); };

        if (dn === '' && pw === '') return allowAnonymous ? ok() : adFail(res, next, '52e');
        if (lc(dn) === lc(SERVICE_DN)) return pw === servicePassword ? ok() : adFail(res, next, '52e');

        const u = userByDn(dn);
        if (!u) return adFail(res, next, '525');
        if (u.bindError) return adFail(res, next, u.bindError);
        if (u.password !== pw) return adFail(res, next, '52e');
        if (u.uac && (parseInt(u.uac, 10) & 2)) return adFail(res, next, '533');
        return ok();
    });

    server.search(BASE, (req, res, next) => {
        searches.push(req.filter.toString());                  // as received: what an injection would show up in
        const filter = unescapeFilter(req.filter.toString());  // for our own pattern matching below

        // ldapjs drops attributes whose lower-cased name is not in the (case-preserved) requested list, which
        // would hide sAMAccountName / objectGUID. Real AD returns them in canonical case, so build the
        // entry ourselves and skip that filter.
        const send = (entry) => res.send(res.createSearchEntry({
            objectName: entry.dn,
            attributes: Object.entries(entry.attributes).map(([type, v]) => new Attribute({ type, values: [].concat(v).filter((x) => x !== '') })),
        }));

        const userEntry = (u) => ({
            dn: u.dn,
            attributes: {
                objectClass: ['top', 'person', 'user'], objectCategory: 'person',
                sAMAccountName: u.sam, userPrincipalName: u.upn, mail: u.mail,
                givenName: u.given, sn: u.sn, displayName: `${u.given} ${u.sn}`,
                telephoneNumber: u.phone || '', mobile: u.mobile || '', department: u.department || '',
                employeeID: u.employeeId || '', userAccountControl: u.uac || '512',
                objectGUID: guidBytes(u.guid),
                memberOf: groups.filter((g) => g.members.map(lc).includes(lc(u.dn))).map((g) => g.dn),
            },
        });

        // Groups containing a user, through any depth:  (member:1.2.840.113556.1.4.1941:=<dn>)
        const chainMember = new RegExp(`member:${IN_CHAIN.replace(/\./g, '\\.')}:=(.+?)\\)\\)?$`).exec(filter);
        if (/objectClass=group/.test(filter) && chainMember && !/memberOf:/.test(filter)) {
            groupsOf(chainMember[1]).forEach((g) => send({ dn: g.dn, attributes: { objectClass: ['top', 'group'], cn: g.cn, sAMAccountName: g.cn } }));
            return res.end(), next();
        }

        // A group looked up by name:  (&(objectClass=group)(|(cn=X)(sAMAccountName=X)))
        const byName = /\(cn=([^)]*)\)/.exec(filter);
        if (/objectClass=group/.test(filter) && byName) {
            groups.filter((g) => lc(g.cn) === lc(byName[1])).forEach((g) => send({ dn: g.dn, attributes: { objectClass: ['top', 'group'], cn: g.cn } }));
            return res.end(), next();
        }

        // Members of a group, nested:  (memberOf:1.2.840.113556.1.4.1941:=<group dn>)
        const memberOfChain = new RegExp(`memberOf:${IN_CHAIN.replace(/\./g, '\\.')}:=(.+?)\\)\\)$`).exec(filter);
        if (memberOfChain) {
            users.filter((u) => groupsOf(u.dn).some((g) => lc(g.dn) === lc(memberOfChain[1]))).forEach((u) => send(userEntry(u)));
            return res.end(), next();
        }

        // Ordinary user lookup: the filter's own matcher over each user's attributes.
        // AD compares values case-insensitively, so lower-case both sides.
        const matcher = ldap.parseFilter(req.filter.toString().toLowerCase());
        const lowered = (attrs) => Object.fromEntries(Object.entries(attrs).map(([k, v]) => [k, Array.isArray(v) ? v.map((x) => (typeof x === 'string' ? x.toLowerCase() : x)) : (typeof v === 'string' ? v.toLowerCase() : v)]));
        users.forEach((u) => {
            const e = userEntry(u);
            if (matcher.matches(lowered(e.attributes), false)) send(e);
        });
        res.end();
        return next();
    });

    server.unbind((req, res) => res.end());

    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            resolve({
                url: `ldap://127.0.0.1:${port}`,
                searches,
                close: () => new Promise((r) => server.close(r)),
            });
        });
    });
}

const user = (over) => ({
    dn: `CN=${over.given} ${over.sn},OU=Staff,${BASE}`,
    sam: over.sam, upn: `${over.sam}@example.local`, mail: `${over.sam}@dojcd.gov.za`,
    password: 'Correct-Horse-9', guid: '11223344-5566-7788-99aa-bbccddeeff00', ...over,
});

module.exports = { startMockAd, user, guidBytes, BASE, SERVICE_DN };
