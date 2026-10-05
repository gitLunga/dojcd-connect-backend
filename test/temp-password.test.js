const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { generateTempPassword } = require('../src/utils/tempPassword');
const passwordPolicy = require('../src/utils/passwordPolicy');

describe('generateTempPassword', () => {
    it('always satisfies the password policy', () => {
        for (let i = 0; i < 500; i++) {
            const pw = generateTempPassword();
            const { valid, errors } = passwordPolicy.validate(pw);
            assert.ok(valid, `${pw}: ${errors.join('; ')}`);
        }
    });

    it('avoids look-alike characters because it is read from an email', () => {
        for (let i = 0; i < 200; i++) assert.doesNotMatch(generateTempPassword(40), /[0O1lI]/);
    });

    it('is random, not derived from anything', () => {
        const seen = new Set(Array.from({ length: 200 }, () => generateTempPassword()));
        assert.equal(seen.size, 200);
    });

    it('honours the requested length and refuses weak lengths', () => {
        assert.equal(generateTempPassword(20).length, 20);
        assert.throws(() => generateTempPassword(7), /at least 8/);
    });
});
