// Short-lived, tamper-proof links to files served by /api/files.
//
// Browsers cannot attach an Authorization header to <img src>, <iframe src> or
// window.open(), so the authenticated endpoints (e.g. GET /api/admin/documents/:id/view)
// authorise the caller and then hand back one of these links. /api/files only
// serves a file when the link's signature matches and it has not expired.
//
// link = /api/files/<path>?exp=<unix seconds>&sig=<base64url HMAC-SHA256(path \n exp)>

const crypto = require('crypto');

const DEFAULT_TTL_SECONDS = 15 * 60;

function ttlSeconds() {
    const configured = parseInt(process.env.FILE_URL_TTL_SECONDS, 10);
    return configured > 0 ? configured : DEFAULT_TTL_SECONDS;
}

let warnedWeakSecret = false;

function key() {
    const secret = process.env.FILE_URL_SECRET || process.env.JWT_SECRET;
    if (!secret) throw new Error('FILE_URL_SECRET or JWT_SECRET must be set to sign file URLs');
    if (secret.length < 32 && !warnedWeakSecret) {
        warnedWeakSecret = true;
        console.warn('⚠️  The secret used to sign file links is shorter than 32 characters — links can be forged. ' +
                     'Set FILE_URL_SECRET (and JWT_SECRET) to a long random value, e.g. `openssl rand -hex 32`.');
    }
    // Domain separation: the key used here can never double as the JWT signing key.
    return crypto.createHmac('sha256', secret).update('dojcd:file-url:v1').digest();
}

function mac(storagePath, exp) {
    return crypto.createHmac('sha256', key()).update(`${storagePath}\n${exp}`).digest('base64url');
}

// Returns the query params to append to a file link for `storagePath`.
function sign(storagePath, now = Date.now()) {
    const exp = Math.floor(now / 1000) + ttlSeconds();
    return { exp, sig: mac(storagePath, exp) };
}

// True only if `sig` was issued for exactly this path + expiry and has not expired.
function verify(storagePath, exp, sig, now = Date.now()) {
    if (typeof sig !== 'string' || !/^\d+$/.test(String(exp))) return false;
    if (Number(exp) * 1000 < now) return false;

    const expected = Buffer.from(mac(storagePath, exp));
    const given    = Buffer.from(sig);
    return expected.length === given.length && crypto.timingSafeEqual(expected, given);
}

module.exports = { sign, verify };
