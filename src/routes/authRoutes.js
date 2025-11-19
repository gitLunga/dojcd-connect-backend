const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');

router.post('/register', (req, res) => authController.register(req, res));
router.post('/register-operational', (req, res) => authController.registerOperational(req, res));

module.exports = router;
