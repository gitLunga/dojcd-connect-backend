const authService = require('../services/authService');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

// ─── Multer storage config ────────────────────────────────────────────────────
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const uploadDir = 'uploads/invoices/';
        if (!fs.existsSync(uploadDir)) {
            fs.mkdirSync(uploadDir, { recursive: true });
        }
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        const timestamp = Date.now();
        const randomString = Math.random().toString(36).substr(2, 9);
        const extension = path.extname(file.originalname);
        const safeName = file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_');
        cb(null, `invoice_${timestamp}_${randomString}_${safeName}`);
    }
});

const upload = multer({
    storage,
    limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
    fileFilter: (req, file, cb) => {
        const allowedTypes = [
            'application/pdf',
            'image/jpeg', 'image/jpg', 'image/png',
            'application/msword',
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            'application/vnd.ms-excel',
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        ];

        if (allowedTypes.includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error('Invalid file type. Please upload a PDF, image, Word, or Excel file.'));
        }
    }
});

// ─── Utility: success response ────────────────────────────────────────────────
function ok(res, message, data = null, statusCode = 200) {
    return res.status(statusCode).json({
        success: true,
        message,
        ...(data || {}),  // Spreads {user: ...} to top level
        timestamp: new Date().toISOString()
    });
}

// ─── Utility: error response ──────────────────────────────────────────────────
function fail(res, message, statusCode = 400) {
    return res.status(statusCode).json({
        success: false,
        message,
        data: null,
        timestamp: new Date().toISOString()
    });
}

class AuthController {

    // ─── REGISTER CLIENT ──────────────────────────────────────────────────────

    async register(req, res) {
        try {
            const userData = req.body;
            const user = await authService.registerUser(userData);

            return ok(
                res,
                `Welcome, ${user.first_name}! Your registration was submitted successfully. Please complete your profile to proceed.`,
                { user },
                201
            );
        } catch (error) {
            console.error('❌ Registration error:', error.message);
            console.error('Error details:', {
                statusCode: error.statusCode,
                message: error.message,
                isDuplicate: error.message?.includes('already exists')
            });

            // PRIMARY: Check for statusCode property set by authService
            if (error.statusCode === 409) {
                console.log('✅ Returning 409 Conflict');
                return res.status(409).json({
                    success: false,
                    message: error.message,
                    timestamp: new Date().toISOString()
                });
            }

            // FALLBACK: Check message for duplicate/validation errors
            if (error.message.includes('already exists') || error.message.includes('duplicate')) {
                console.log('✅ Returning 409 Conflict (from message check)');
                return res.status(409).json({
                    success: false,
                    message: error.message,
                    timestamp: new Date().toISOString()
                });
            }

            // DEFAULT: All other errors are 400 (bad request)
            return fail(res, error.message, 400);
        }
    }

    // ─── COMPLETE PROFILE ─────────────────────────────────────────────────────

    async completeProfile(req, res) {
        try {
            const { clientUserId } = req.params;
            const profileData = req.body;
            const files = req.files;

            if (!files || !files.invoice_file) {
                return fail(res, 'Please upload your invoice file to continue.', 400);
            }

            if (!files.id_document || !files.payslip_document) {
                return fail(res, 'Please upload both your ID document and payslip to continue.', 400);
            }

            const result = await authService.completeProfile(
                parseInt(clientUserId),
                profileData,
                files
            );

            return ok(res, result.message, {
                user: result.user,
                documents: result.documents
            });

        } catch (error) {
            console.error('❌ Complete profile error:', error);
            const status = error.message.includes('Please') ? 400 : 500;
            return fail(res, error.message, status);
        }
    }

    // ─── REGISTER OPERATIONAL ─────────────────────────────────────────────────

    async registerOperational(req, res) {
        try {
            const user = await authService.registerOperationalUser(req.body);
            return ok(
                res,
                `Operational account created successfully for ${user.first_name} ${user.last_name}.`,
                { user },
                201
            );
        } catch (error) {
            console.error('❌ Operational registration error:', error.message);

            // Check for duplicates first
            if (error.statusCode === 409 || error.message.includes('already exists')) {
                return res.status(409).json({
                    success: false,
                    message: error.message,
                    timestamp: new Date().toISOString()
                });
            }

            // Then check for invalid role
            const status = error.message.includes('valid role') ? 400 : 400;
            return fail(res, error.message, status);
        }
    }

    // ─── LOGIN ────────────────────────────────────────────────────────────────

    async loginClient(req, res) {
        try {
            const user = await authService.loginClientUser(req.body);
            return ok(res, `Welcome back, ${user.first_name}!`, { user });
        } catch (error) {
            return fail(res, error.message, 401);
        }
    }

    async loginOperational(req, res) {
        try {
            const user = await authService.loginOperationalUser(req.body);
            return ok(res, `Welcome back, ${user.first_name}!`, { user });
        } catch (error) {
            return fail(res, error.message, 401);
        }
    }

    async login(req, res) {
        try {
            const user = await authService.loginUser(req.body);
            return ok(res, `Welcome back, ${user.first_name}!`, { user });
        } catch (error) {
            return fail(res, error.message, 401);
        }
    }
}

module.exports = new AuthController();