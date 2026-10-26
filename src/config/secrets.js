// Startup validation for signing secrets.
//
// A short JWT secret lets anyone brute-force it offline from a single token and then
// mint tokens for any user, including Admin. In production we refuse to start with one.

const MIN_JWT_SECRET_LENGTH = 32;

function assertJwtSecret(secret = process.env.JWT_SECRET, nodeEnv = process.env.NODE_ENV) {
    if (!secret) {
        throw new Error('JWT_SECRET environment variable is not set');
    }

    if (secret.length < MIN_JWT_SECRET_LENGTH) {
        const problem = `JWT_SECRET is only ${secret.length} characters; use at least ${MIN_JWT_SECRET_LENGTH}. ` +
                        'Generate one with: openssl rand -hex 32  (changing it signs everyone out).';
        if (nodeEnv === 'production') throw new Error(problem);
        console.warn(`⚠️  ${problem}`);
    }

    return secret;
}

module.exports = { assertJwtSecret, MIN_JWT_SECRET_LENGTH };
