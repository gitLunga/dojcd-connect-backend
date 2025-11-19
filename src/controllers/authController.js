const authService = require('../services/authService');

class AuthController {
    async register(req, res) {
        try {
            const user = await authService.registerUser(req.body);
            res.status(201).json({
                success: true,
                message: 'Registration successful',
                data: {
                    user: user
                },
                timestamp: new Date().toISOString()
            });
        } catch (error) {
            res.status(400).json({
                success: false,
                message: error.message,
                data: null,
                timestamp: new Date().toISOString()
            });
        }
    }
}

module.exports = new AuthController();