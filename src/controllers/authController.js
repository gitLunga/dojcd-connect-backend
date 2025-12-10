const authService = require('../services/authService');
const multer = require('multer');
const path = require('path'); // Add this
const fs = require('fs'); // Add this

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const uploadDir = 'uploads/invoices/'; // Save directly to invoices folder
        // Ensure directory exists
        if (!fs.existsSync(uploadDir)) {
            fs.mkdirSync(uploadDir, { recursive: true });
        }
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        // Generate unique filename
        const timestamp = Date.now();
        const randomString = Math.random().toString(36).substr(2, 9);
        const extension = path.extname(file.originalname);
        const safeName = file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_');
        const filename = `invoice_${timestamp}_${randomString}_${safeName}`;
        cb(null, filename);
    }
});

const upload = multer({
    storage: storage, // Use diskStorage
    limits: {
        fileSize: 10 * 1024 * 1024, // 10MB limit
    },
    fileFilter: (req, file, cb) => {
        // Accept common file types
        const allowedTypes = [
            'application/pdf',
            'image/jpeg', 'image/jpg', 'image/png',
            'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        ];

        if (allowedTypes.includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error('Invalid file type. Allowed: PDF, Images, Word, Excel'));
        }
    }
});



class AuthController {
    async register(req, res) {
        try {
            // Use multer middleware to handle the file upload
            upload.single('invoice_file')(req, res, async (err) => {
                if (err) {
                    return res.status(400).json({
                        success: false,
                        message: err.message
                    });
                }

                try {
                    // Extract user data from form fields
                    const userData = req.body;
                    const invoiceFile = req.file; // This is the uploaded file

                    console.log('Received user data:', userData);
                    console.log('Received file:', invoiceFile ? invoiceFile.originalname : 'No file');

                    // IMPORTANT: Call service with both parameters
                    const user = await authService.registerUser(userData, invoiceFile);

                    res.status(201).json({
                        success: true,
                        message: 'Registration successful',
                        user: user
                    });
                } catch (error) {
                    console.error('Registration error:', error);
                    res.status(400).json({
                        success: false,
                        message: error.message
                    });
                }
            });
        } catch (error) {
            console.error('Controller error:', error);
            res.status(500).json({
                success: false,
                message: 'Internal server error'
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