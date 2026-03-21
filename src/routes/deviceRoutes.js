// routes/deviceRoutes.js
const express = require('express');
const router = express.Router();
const DeviceController = require('../controllers/deviceController');

// Initialize controller
const deviceController = new DeviceController();

// Device routes
router.get('/devices', deviceController.getAllDevices);
router.get('/devices/search', deviceController.searchDevices);
router.get('/devices/status/:status', deviceController.getDevicesByStatus);
router.get('/devices/stats/summary', deviceController.getDeviceStatistics);
router.get('/devices/:id', deviceController.getDeviceById);

router.post('/devices', deviceController.createDevice);
router.put('/devices/:id', deviceController.updateDevice);
router.delete('/devices/:id', deviceController.deleteDevice);

module.exports = router;