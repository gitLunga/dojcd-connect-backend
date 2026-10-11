// Counts failed sign-ins per key (username + IP) in a sliding window and refuses further attempts once
// the limit is reached. Directory sign-in forwards passwords to the domain controller, so without this
// anyone could hammer an account and trip the domain's lockout policy for the real owner.
//
// In memory: it resets on restart and is per process. That is enough to blunt guessing from one place;
// the domain controller's own lockout policy remains the real defence.

const { DirectoryError } = require('../directory/errors');

function createAttemptLimiter({ maxFailures = 8, windowMs = 10 * 60 * 1000, now = Date.now } = {}) {
    const failures = new Map();   // key -> timestamps of recent failures

    const recent = (key) => {
        const cutoff = now() - windowMs;
        const list = (failures.get(key) || []).filter((t) => t > cutoff);
        if (list.length > 0) failures.set(key, list); else failures.delete(key);
        return list;
    };

    const sweep = () => { for (const key of failures.keys()) recent(key); };

    return {
        check(key) {
            if (recent(key).length >= maxFailures) {
                const minutes = Math.ceil(windowMs / 60000);
                throw new DirectoryError('TOO_MANY_ATTEMPTS',
                    `Too many failed sign-in attempts. Please wait up to ${minutes} minutes and try again.`);
            }
        },
        fail(key) {
            if (failures.size > 10000) sweep();      // keep memory bounded under a flood of distinct keys
            failures.set(key, [...recent(key), now()]);
        },
        clear(key) { failures.delete(key); },
    };
}

module.exports = { createAttemptLimiter };
