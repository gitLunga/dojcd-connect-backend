const db  = require('../config/db');
const bcrypt = require('bcrypt');

class ProfileController {

    async getMyProfile(req, res) {
        try {
            const { userId } = req.user;
            const result = await db.query(
                `SELECT op_user_id, title, first_name, last_name, email,
                        user_role, department_id, is_super_admin,
                        must_change_password, created_at, updated_at
                 FROM operational_user
                 WHERE op_user_id = $1 AND is_deleted = false`,
                [userId]
            );
            if (result.rows.length === 0) {
                return res.status(404).json({ success: false, message: 'Profile not found.' });
            }
            return res.status(200).json({ success: true, data: result.rows[0] });
        } catch (err) {
            console.error('getMyProfile error:', err);
            return res.status(500).json({ success: false, message: 'Failed to fetch profile.' });
        }
    }

    async updateMyProfile(req, res) {
        try {
            const { userId } = req.user;
            const { title, first_name, last_name, email } = req.body;

            if (!first_name?.trim() || !last_name?.trim() || !email?.trim()) {
                return res.status(400).json({ success: false, message: 'first_name, last_name and email are required.' });
            }

            // Block duplicate email (allow same user to keep theirs)
            if (email) {
                const emailCheck = await db.query(
                    `SELECT op_user_id FROM operational_user WHERE email = $1 AND op_user_id <> $2 AND is_deleted = false`,
                    [email.trim().toLowerCase(), userId]
                );
                if (emailCheck.rows.length > 0) {
                    return res.status(409).json({ success: false, message: 'That email address is already in use.' });
                }
            }

            const result = await db.query(
                `UPDATE operational_user
                 SET title      = COALESCE($1, title),
                     first_name = $2,
                     last_name  = $3,
                     email      = $4,
                     updated_at = NOW()
                 WHERE op_user_id = $5 AND is_deleted = false
                 RETURNING op_user_id, title, first_name, last_name, email, user_role, department_id, is_super_admin`,
                [title?.trim() || null, first_name.trim(), last_name.trim(), email.trim().toLowerCase(), userId]
            );

            if (result.rows.length === 0) {
                return res.status(404).json({ success: false, message: 'User not found.' });
            }

            return res.status(200).json({
                success: true,
                message: 'Profile updated successfully.',
                data: result.rows[0],
            });
        } catch (err) {
            console.error('updateMyProfile error:', err);
            return res.status(500).json({ success: false, message: 'Failed to update profile.' });
        }
    }
}

module.exports = new ProfileController();
