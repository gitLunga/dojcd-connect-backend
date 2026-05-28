const RULES = [
    { test: p => p.length >= 8,          message: 'At least 8 characters' },
    { test: p => /[A-Z]/.test(p),        message: 'At least one uppercase letter' },
    { test: p => /[a-z]/.test(p),        message: 'At least one lowercase letter' },
    { test: p => /[0-9]/.test(p),        message: 'At least one number' },
    { test: p => /[^A-Za-z0-9]/.test(p), message: 'At least one special character (e.g. @, #, $, !)' },
];

function validate(password) {
    if (typeof password !== 'string' || !password) {
        return { valid: false, errors: ['Password is required'] };
    }
    const errors = RULES.filter(r => !r.test(password)).map(r => r.message);
    return { valid: errors.length === 0, errors };
}

// Throws with a formatted message if the password does not meet policy.
function enforce(password) {
    const { valid, errors } = validate(password);
    if (!valid) throw new Error(`Password does not meet requirements: ${errors.join('; ')}`);
}

module.exports = { validate, enforce };
