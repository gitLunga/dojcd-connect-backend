const authService   = require('../services/authService');
const tokenService  = require('../services/tokenService');

class AuthController {

    async register(req, res) {
        try {
            const { user, accessToken, refreshToken } = await authService.registerUser(req.body);
            return res.status(201).json({
                success: true,
                message: 'Registration successful',
                data: { user, accessToken, refreshToken },
                timestamp: new Date().toISOString(),
            });
        } catch (error) {
            console.error('Registration error:', error);
            return res.status(400).json({
                success: false,
                message: error.message,
                data: null,
                timestamp: new Date().toISOString(),
            });
        }
    }

    async completeProfile(req, res) {
        try {
            const clientUserId = parseInt(req.params.clientUserId);
            const files = req.files;

            // Ensure the token owner matches the URL param (prevents IDOR)
            if (req.user.userId !== clientUserId) {
                return res.status(403).json({
                    success: false,
                    message: 'You can only complete your own profile.',
                    data: null,
                });
            }

            if (!files?.invoice_file) {
                return res.status(400).json({ success: false, message: 'Invoice file is required' });
            }
            if (!files.id_document || !files.payslip_document) {
                return res.status(400).json({ success: false, message: 'ID document and Payslip are required' });
            }

            const result = await authService.completeProfile(clientUserId, req.body, files);

            return res.status(200).json({
                success: true,
                message: result.message,
                data: { user: result.user, documents: result.documents },
                timestamp: new Date().toISOString(),
            });
        } catch (error) {
            console.error('Complete profile error:', error);
            return res.status(500).json({
                success: false,
                message: error.message || 'Internal server error',
                data: null,
                timestamp: new Date().toISOString(),
            });
        }
    }

    async registerOperational(req, res) {
        try {
            const user = await authService.registerOperationalUser(req.body);
            return res.status(201).json({
                success: true,
                message: 'Operational user registration successful',
                data: { user },
                timestamp: new Date().toISOString(),
            });
        } catch (error) {
            return res.status(400).json({
                success: false,
                message: error.message,
                data: null,
                timestamp: new Date().toISOString(),
            });
        }
    }

    async loginClient(req, res) {
        try {
            const { user, accessToken, refreshToken } = await authService.loginClientUser(req.body);
            return res.status(200).json({
                success: true,
                message: 'Login successful',
                data: { user, accessToken, refreshToken },
                timestamp: new Date().toISOString(),
            });
        } catch (error) {
            return res.status(401).json({
                success: false,
                message: error.message,
                data: null,
                timestamp: new Date().toISOString(),
            });
        }
    }

    async loginOperational(req, res) {
        try {
            const { user, accessToken, refreshToken } = await authService.loginOperationalUser(req.body);
            return res.status(200).json({
                success: true,
                message: 'Operational user login successful',
                data: { user, accessToken, refreshToken },
                timestamp: new Date().toISOString(),
            });
        } catch (error) {
            return res.status(401).json({
                success: false,
                message: error.message,
                data: null,
                timestamp: new Date().toISOString(),
            });
        }
    }

    async login(req, res) {
        try {
            const { user, accessToken, refreshToken } = await authService.loginUser(req.body);
            return res.status(200).json({
                success: true,
                message: 'Login successful',
                data: { user, accessToken, refreshToken },
                timestamp: new Date().toISOString(),
            });
        } catch (error) {
            return res.status(401).json({
                success: false,
                message: error.message,
                data: null,
                timestamp: new Date().toISOString(),
            });
        }
    }

    // POST /api/auth/refresh
    // Body: { refreshToken: "<raw token>" }
    async refresh(req, res) {
        const { refreshToken } = req.body;
        if (!refreshToken) {
            return res.status(400).json({
                success: false,
                message: 'Refresh token is required.',
                data: null,
            });
        }
        try {
            const tokens = await tokenService.refreshTokens(refreshToken);
            return res.status(200).json({
                success: true,
                message: 'Token refreshed.',
                data: tokens,
                timestamp: new Date().toISOString(),
            });
        } catch (error) {
            return res.status(401).json({
                success: false,
                message: error.message,
                data: null,
                timestamp: new Date().toISOString(),
            });
        }
    }

    // POST /api/auth/logout
    // Body: { refreshToken: "<raw token>" }
    // Requires authenticate middleware (access token in Authorization header)
    async logout(req, res) {
        const { refreshToken } = req.body;
        if (refreshToken) {
            try {
                await tokenService.revokeRefreshToken(refreshToken);
            } catch (_) {
                // Revocation failure is non-fatal — token may already be expired
            }
        }
        return res.status(200).json({
            success: true,
            message: 'Logged out successfully.',
            data: null,
            timestamp: new Date().toISOString(),
        });
    }
}

module.exports = new AuthController();
