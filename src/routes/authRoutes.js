const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');
const adminController = require('../controllers/adminController');



router.get('/test', (req, res) => {
    res.status(200).json({
        success: true,
        message: 'Backend is connected and working!',
        timestamp: new Date().toISOString()
    });
});

//registration routes
router.post('/register', (req, res) => authController.register(req, res));
router.post('/register-operational', (req, res) => authController.registerOperational(req, res));

// Login routes
router.post('/login', (req, res) => authController.login(req, res)); // Generic login
router.post('/login-client', (req, res) => authController.loginClient(req, res)); // Client only
router.post('/login-operational', (req, res) => authController.loginOperational(req, res));

// GET /api/admin/users
router.get('/users', (req, res) => adminController.getAllUsers(req, res));

module.exports = router;
