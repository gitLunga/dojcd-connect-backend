const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');
const multer = require('multer');
const path = require('path');
const fs = require('fs');


const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        const uploadDir = path.join(__dirname, '../uploads/temp');

        // Create temp directory if it doesn't exist
        if (!fs.existsSync(uploadDir)) {
            fs.mkdirSync(uploadDir, { recursive: true });
        }

        cb(null, uploadDir);
    },
    filename: function (req, file, cb) {
        // Generate unique filename
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        const ext = path.extname(file.originalname);
        cb(null, file.fieldname + '-' + uniqueSuffix + ext);
    }
});

// File filter for invoice uploads
const fileFilter = (req, file, cb) => {
    const allowedTypes = [
        'application/pdf',
        'image/jpeg',
        'image/jpg',
        'image/png',
        'application/msword',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    ];

    if (allowedTypes.includes(file.mimetype)) {
        cb(null, true);
    } else {
        cb(new Error('Invalid file type. Only PDF, JPG, PNG, DOC, DOCX are allowed.'), false);
    }
};

const upload = multer({
    storage: storage,
    fileFilter: fileFilter,
    limits: {
        fileSize: 10 * 1024 * 1024, // 10MB per file
        files: 4 // Maximum 4 files (invoice + 3 docs)
    }
});

// Define upload fields for complete profile
const completeProfileUpload = upload.fields([
    { name: 'invoice_file', maxCount: 1 },
    { name: 'id_document', maxCount: 1 },
    { name: 'payslip_document', maxCount: 1 },
    { name: 'residence_document', maxCount: 1 }
]);

router.get('/test', (req, res) => {
    res.status(200).json({
        success: true,
        message: 'Backend is connected and working!',
        timestamp: new Date().toISOString()
    });
});

//registration routes
router.post('/register', (req, res) => authController.register(req, res));
// router.post(
//     '/complete-profile/:clientUserId',
//     (req, res) => authController.completeProfile(req, res)
// );

router.post(
    '/complete-profile/:clientUserId',
    (req, res, next) => {
        completeProfileUpload(req, res, (err) => {
            if (err) {
                return res.status(400).json({
                    success: false,
                    message: err.message
                });
            }
            next();
        });
    },
    (req, res) => authController.completeProfile(req, res)
);

router.post('/register-operational', (req, res) => authController.registerOperational(req, res));

// Login routes
router.post('/login', (req, res) => authController.login(req, res)); // Generic login
router.post('/login-client', (req, res) => authController.loginClient(req, res)); // Client only
router.post('/login-operational', (req, res) => authController.loginOperational(req, res));

module.exports = router;
