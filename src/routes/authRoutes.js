const express      = require('express');
const router       = express.Router();
const multer       = require('multer');
const authController  = require('../controllers/authController');
const authenticate    = require('../middleware/authenticate');
const requireRoles    = require('../middleware/authorize');

const upload = multer({
    storage: multer.memoryStorage(),
    fileFilter: (req, file, cb) => {
        const allowed = [
            'application/pdf',
            'image/jpeg', 'image/jpg', 'image/png',
            'application/msword',
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        ];
        allowed.includes(file.mimetype) ? cb(null, true) : cb(new Error('Invalid file type. Only PDF, JPG, PNG, DOC, DOCX are allowed.'), false);
    },
    limits: { fileSize: 10 * 1024 * 1024, files: 4 },
});

const completeProfileUpload = upload.fields([
    { name: 'invoice_file',       maxCount: 1 },
    { name: 'id_document',        maxCount: 1 },
    { name: 'payslip_document',   maxCount: 1 },
    { name: 'residence_document', maxCount: 1 },
]);

// ── Public ────────────────────────────────────────────────────────────────────
router.get('/test', (req, res) => res.status(200).json({ success: true, message: 'Auth router OK' }));

router.post('/register',   (req, res) => authController.register(req, res));
router.post('/login',      (req, res) => authController.login(req, res));
router.post('/login-client',      (req, res) => authController.loginClient(req, res));
router.post('/login-operational', (req, res) => authController.loginOperational(req, res));

// Refresh access token — authenticated by the refresh token itself (no Bearer header needed)
router.post('/refresh',         (req, res) => authController.refresh(req, res));

// Forgot / reset password — public
router.post('/forgot-password', (req, res) => authController.forgotPassword(req, res));
router.post('/reset-password',  (req, res) => authController.resetPassword(req, res));

// ── Requires valid access token ───────────────────────────────────────────────

// Complete profile — the registered client uses the token returned by /register
router.post(
    '/complete-profile/:clientUserId',
    authenticate,
    requireRoles('Client'),
    (req, res, next) => {
        completeProfileUpload(req, res, (err) => {
            if (err) return res.status(400).json({ success: false, message: err.message });
            next();
        });
    },
    (req, res) => authController.completeProfile(req, res)
);

// Register a new operational user — Admin only
router.post(
    '/register-operational',
    authenticate,
    requireRoles('Admin'),
    (req, res) => authController.registerOperational(req, res)
);

// Change password — any authenticated user
router.post('/change-password', authenticate, (req, res) => authController.changePassword(req, res));

// Logout — invalidates the supplied refresh token
router.post('/logout', authenticate, (req, res) => authController.logout(req, res));

module.exports = router;
