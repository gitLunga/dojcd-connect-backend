const authService = require('../services/authService');

class AuthController {
    async register(req, res) {
        try {
            const user = await authService.registerUser(req.body);
            res.status(201).json({
                message: 'Registration successful',
                user
            });
        } catch (error) {
            res.status(400).json({ error: error.message });
        }
    }
}

module.exports = new AuthController();
