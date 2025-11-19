const express = require('express');
const router = express.Router();
const authController = require('../controllers/authController');

router.post('/register', (req, res) => authController.register(req, res));

module.exports = router;
