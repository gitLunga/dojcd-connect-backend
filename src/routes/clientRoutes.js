const express      = require('express');
const router       = express.Router();
const authenticate = require('../middleware/authenticate');
const db           = require('../config/db');

function requireClient(req, res, next) {
    if (req.user.userType !== 'Client') {
        return res.status(403).json({ success: false, message: 'Client access only.', data: null });
    }
    next();
}

router.use(authenticate);
router.use(requireClient);

router.get('/me', async (req, res) => {
    try {
        const result = await db.query(
            `SELECT client_user_id, title, first_name, last_name, email, phone_number,
                    region, persal_id, department_id, user_type, network_provider,
                    contract_duration_months, contract_end_date, registration_status,
                    created_at, updated_at
             FROM client_user
             WHERE client_user_id = $1`,
            [req.user.userId]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Profile not found.', data: null });
        }
        return res.json({ success: true, data: result.rows[0] });
    } catch (err) {
        console.error('GET /client/me error:', err);
        return res.status(500).json({ success: false, message: 'Failed to fetch profile.', data: null });
    }
});

router.patch('/me', async (req, res) => {
    try {
        const { title, first_name, last_name, phone_number } = req.body;

        if (!first_name?.trim() || !last_name?.trim()) {
            return res.status(400).json({ success: false, message: 'first_name and last_name are required.', data: null });
        }

        const result = await db.query(
            `UPDATE client_user
             SET title        = COALESCE($1, title),
                 first_name   = $2,
                 last_name    = $3,
                 phone_number = $4,
                 updated_at   = CURRENT_TIMESTAMP
             WHERE client_user_id = $5
             RETURNING client_user_id, title, first_name, last_name, email, phone_number,
                       region, persal_id, department_id, user_type, network_provider,
                       contract_duration_months, contract_end_date, registration_status,
                       created_at, updated_at`,
            [title || null, first_name.trim(), last_name.trim(), phone_number || null, req.user.userId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Profile not found.', data: null });
        }

        return res.json({ success: true, message: 'Profile updated successfully.', data: result.rows[0] });
    } catch (err) {
        console.error('PATCH /client/me error:', err);
        return res.status(500).json({ success: false, message: 'Failed to update profile.', data: null });
    }
});

module.exports = router;
