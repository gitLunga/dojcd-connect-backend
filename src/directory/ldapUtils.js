// Small helpers for talking to Active Directory over LDAP. Pure functions, no I/O.

// RFC 4515 filter escaping. Without it a username like  *)(objectClass=*  rewrites the search.
function escapeFilterValue(value) {
    return String(value).replace(/[\\*()\0]/g, (ch) => `\\${ch.charCodeAt(0).toString(16).padStart(2, '0')}`);
}

// AD's objectGUID is 16 bytes in Microsoft's mixed-endian layout: the first three fields are
// little-endian, the last two are as-is.
function guidFromBuffer(buf) {
    if (!Buffer.isBuffer(buf) || buf.length !== 16) return null;
    const hex = (start, end, reverse) => {
        const part = buf.subarray(start, end);
        return Buffer.from(reverse ? [...part].reverse() : part).toString('hex');
    };
    return [hex(0, 4, true), hex(4, 6, true), hex(6, 8, true), hex(8, 10), hex(10, 16)].join('-');
}

// Active Directory explains a failed bind in the message: "... AcceptSecurityContext error, data 775, v4563".
function adSubCode(err) {
    const m = /data\s+([0-9a-f]{3})/i.exec(String(err?.message || ''));
    return m ? m[1].toLowerCase() : null;
}

// Someone may type EXAMPLE\jsmith; the directory knows the part after the backslash.
function normaliseUsername(raw) {
    let name = String(raw || '').trim();
    if (name.includes('\\')) name = name.split('\\').pop();
    return name;
}

const asArray = (v) => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);
const asString = (v) => {
    const first = asArray(v)[0];
    return first === undefined ? '' : Buffer.isBuffer(first) ? first.toString('utf8') : String(first);
};

// "CN=DOJCD Admins,OU=Groups,DC=x" -> "DOJCD Admins" (first RDN value, with \, escapes undone).
function cnFromDn(dn) {
    const m = /^cn=((?:\\.|[^,])+)/i.exec(String(dn || '').trim());
    return m ? m[1].replace(/\\(.)/g, '$1') : '';
}

const UF_ACCOUNTDISABLE = 0x2;
const isDisabled = (userAccountControl) => (parseInt(asString(userAccountControl), 10) & UF_ACCOUNTDISABLE) !== 0;

module.exports = { escapeFilterValue, guidFromBuffer, adSubCode, normaliseUsername, asArray, asString, cnFromDn, isDisabled };
