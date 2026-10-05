const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { assertJwtSecret } = require('../src/config/secrets');

const STRONG = 'a'.repeat(32);

describe('assertJwtSecret', () => {
    it('throws when the secret is missing, in any environment', () => {
        assert.throws(() => assertJwtSecret(undefined, 'development'), /JWT_SECRET environment variable is not set/);
        assert.throws(() => assertJwtSecret('', 'production'), /not set/);
    });

    it('refuses a short secret in production and says how to fix it', () => {
        assert.throws(
            () => assertJwtSecret('secret', 'production'),
            (err) => /only 6 characters/.test(err.message) && /openssl rand -hex 32/.test(err.message)
        );
    });

    it('accepts a 32+ character secret in production', () => {
        assert.equal(assertJwtSecret(STRONG, 'production'), STRONG);
    });

    it('only warns about a short secret outside production', () => {
        const warnings = [];
        const original = console.warn;
        console.warn = (m) => warnings.push(m);
        try {
            assert.equal(assertJwtSecret('short', 'development'), 'short');
        } finally {
            console.warn = original;
        }
        assert.equal(warnings.length, 1);
        assert.match(warnings[0], /only 5 characters/);
    });
});
