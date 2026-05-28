const express        = require('express');
const router         = express.Router();
const DeviceController = require('../controllers/deviceController');
const authenticate   = require('../middleware/authenticate');
const requireRoles   = require('../middleware/authorize');

const deviceController = new DeviceController();

router.use(authenticate);

// Read-only — any authenticated user (clients browse, admins manage)
router.get('/devices',               deviceController.getAllDevices);
router.get('/devices/search',        deviceController.searchDevices);
router.get('/devices/status/:status', deviceController.getDevicesByStatus);
router.get('/devices/stats/summary', deviceController.getDeviceStatistics);
router.get('/devices/:id',           deviceController.getDeviceById);

// Inventory — Admin only
router.get('/devices/inventory',       requireRoles('Admin'), deviceController.getInventory);
router.patch('/devices/:id/stock',     requireRoles('Admin'), deviceController.updateStock);

// Mutations — Admin only
router.post('/devices',    requireRoles('Admin'), deviceController.createDevice);
router.put('/devices/:id', requireRoles('Admin'), deviceController.updateDevice);
router.delete('/devices/:id', requireRoles('Admin'), deviceController.deleteDevice);

module.exports = router;
