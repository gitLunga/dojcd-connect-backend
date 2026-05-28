const jwt    = require('jsonwebtoken');
const crypto = require('crypto');
const db     = require('../config/db');

const ACCESS_SECRET   = process.env.JWT_SECRET;
const ACCESS_TTL      = '15m';
const REFRESH_TTL_MS  = 7 * 24 * 60 * 60 * 1000; // 7 days

if (!ACCESS_SECRET) {
    throw new Error('JWT_SECRET environment variable is not set');
}

// ── Access token ──────────────────────────────────────────────────────────────

function generateAccessToken(userId, userType, role = null, departmentId = null) {
    return jwt.sign({ userId, userType, role, departmentId }, ACCESS_SECRET, { expiresIn: ACCESS_TTL });
}

function verifyAccessToken(token) {
    return jwt.verify(token, ACCESS_SECRET);
}

// ── Refresh token ─────────────────────────────────────────────────────────────
// Stored as SHA-256(rawToken) in the DB; the raw 40-byte hex is returned to
// the client and never persisted.

function _hashToken(raw) {
    return crypto.createHash('sha256').update(raw).digest('hex');
}

async function generateRefreshToken(userId, userType) {
    const rawToken = crypto.randomBytes(40).toString('hex');
    const tokenHash = _hashToken(rawToken);
    const expiresAt = new Date(Date.now() + REFRESH_TTL_MS);

    await db.query(
        `INSERT INTO refresh_token (user_id, user_type, token_hash, expires_at)
         VALUES ($1, $2, $3, $4)`,
        [userId, userType, tokenHash, expiresAt]
    );

    return rawToken;
}

async function refreshTokens(rawToken) {
    const tokenHash = _hashToken(rawToken);

    const result = await db.query(
        `SELECT * FROM refresh_token WHERE token_hash = $1`,
        [tokenHash]
    );

    if (result.rows.length === 0) throw new Error('Invalid refresh token');

    const stored = result.rows[0];

    if (stored.revoked_at)                    throw new Error('Refresh token has been revoked');
    if (new Date(stored.expires_at) < new Date()) throw new Error('Refresh token has expired');

    // Rotate: revoke the old token atomically with issuing the new one
    await db.query(
        `UPDATE refresh_token SET revoked_at = NOW() WHERE token_hash = $1`,
        [tokenHash]
    );

    const { user_id: userId, user_type: userType } = stored;
    let role = null;
    let departmentId = null;

    if (userType === 'Operational') {
        const userResult = await db.query(
            `SELECT user_role, department_id FROM operational_user WHERE op_user_id = $1 AND is_deleted = false`,
            [userId]
        );
        if (userResult.rows.length > 0) {
            role         = userResult.rows[0].user_role;
            departmentId = userResult.rows[0].department_id || null;
        }
    } else {
        const userResult = await db.query(
            `SELECT department_id FROM client_user WHERE client_user_id = $1`,
            [userId]
        );
        if (userResult.rows.length > 0) departmentId = userResult.rows[0].department_id || null;
    }

    const accessToken  = generateAccessToken(userId, userType, role, departmentId);
    const refreshToken = await generateRefreshToken(userId, userType);

    return { accessToken, refreshToken };
}

async function revokeRefreshToken(rawToken) {
    const tokenHash = _hashToken(rawToken);
    await db.query(
        `UPDATE refresh_token
         SET revoked_at = NOW()
         WHERE token_hash = $1 AND revoked_at IS NULL`,
        [tokenHash]
    );
}

module.exports = {
    generateAccessToken,
    verifyAccessToken,
    generateRefreshToken,
    refreshTokens,
    revokeRefreshToken,
};
