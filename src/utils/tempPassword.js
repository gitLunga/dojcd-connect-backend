// Random one-time passwords for accounts created by an administrator.
//
// Always satisfies utils/passwordPolicy (length, upper, lower, digit, special) and avoids
// look-alike characters (0/O, 1/l/I) because the password is read from an email or screen.

const crypto = require('crypto');

const UPPER   = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const LOWER   = 'abcdefghijkmnopqrstuvwxyz';
const DIGITS  = '23456789';
const SPECIAL = '@#$%&*!?';
const ALL     = UPPER + LOWER + DIGITS + SPECIAL;

const pick = (set) => set[crypto.randomInt(set.length)];

function generateTempPassword(length = 14) {
    if (length < 8) throw new Error('Temporary passwords must be at least 8 characters');

    const chars = [pick(UPPER), pick(LOWER), pick(DIGITS), pick(SPECIAL)];
    while (chars.length < length) chars.push(pick(ALL));

    // Fisher–Yates shuffle with a CSPRNG so the guaranteed characters are not always first.
    for (let i = chars.length - 1; i > 0; i--) {
        const j = crypto.randomInt(i + 1);
        [chars[i], chars[j]] = [chars[j], chars[i]];
    }
    return chars.join('');
}

module.exports = { generateTempPassword };
