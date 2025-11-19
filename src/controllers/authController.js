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

    async registerOperational(req, res) {
        try {
            const user = await authService.registerOperationalUser(req.body);
            res.status(201).json({
                success: true,
                message: 'Operational user registration successful',
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
    async loginClient(req, res) {
        try {
            const user = await authService.loginClientUser(req.body);
            res.status(200).json({
                success: true,
                message: 'Login successful',
                data: {
                    user: user
                },
                timestamp: new Date().toISOString()
            });
        } catch (error) {
            res.status(401).json({
                success: false,
                message: error.message,
                data: null,
                timestamp: new Date().toISOString()
            });
        }
    }

    // Login for Operational Users
    async loginOperational(req, res) {
        try {
            const user = await authService.loginOperationalUser(req.body);
            res.status(200).json({
                success: true,
                message: 'Operational user login successful',
                data: {
                    user: user
                },
                timestamp: new Date().toISOString()
            });
        } catch (error) {
            res.status(401).json({
                success: false,
                message: error.message,
                data: null,
                timestamp: new Date().toISOString()
            });
        }
    }

    // Generic login (tries both user types)
    async login(req, res) {
        try {
            const user = await authService.loginUser(req.body);
            res.status(200).json({
                success: true,
                message: 'Login successful',
                data: {
                    user: user
                },
                timestamp: new Date().toISOString()
            });
        } catch (error) {
            res.status(401).json({
                success: false,
                message: error.message,
                data: null,
                timestamp: new Date().toISOString()
            });
        }
    }

}

module.exports = new AuthController();