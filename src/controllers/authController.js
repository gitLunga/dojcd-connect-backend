const authService = require('../services/authService');
const multer = require('multer');

// ── Memory storage: files land in req.file.buffer, then go to Supabase ──────
// Render's disk is ephemeral — never write user files there.


class AuthController {
    async register(req, res) {
        try {
            const userData = req.body;

            console.log('📥 Register user data:', userData);

            // IMPORTANT: Do NOT pass invoiceFile here
            const user = await authService.registerUser(userData);

            return res.status(201).json({
                success: true,
                message: 'Registration successful',
                user
            });

        } catch (error) {
            console.error('Registration error:', error);
            return res.status(400).json({
                success: false,
                message: error.message
            });
        }
    }


    async completeProfile(req, res) {
        try {
            const {clientUserId} = req.params;
            const profileData = req.body;
            const files = req.files; // Files are already processed by route middleware

            console.log('📁 Files received from middleware:', Object.keys(files || {}));
            console.log('📝 Profile data:', profileData);

            // Check required files
            if (!files || !files.invoice_file) {
                return res.status(400).json({
                    success: false,
                    message: 'Invoice file is required'
                });
            }

            if (!files.id_document || !files.payslip_document) {
                return res.status(400).json({
                    success: false,
                    message: 'ID document and Payslip are required'
                });
            }

            const result = await authService.completeProfile(
                parseInt(clientUserId),
                profileData,
                files
            );

            res.status(200).json({
                success: true,
                message: result.message,
                data: {
                    user: result.user,
                    documents: result.documents
                }
            });

        } catch (error) {
            console.error('Complete profile error:', error);
            res.status(500).json({
                success: false,
                message: error.message || 'Internal server error'
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