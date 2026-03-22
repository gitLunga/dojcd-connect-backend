// controllers/deviceController.js
const deviceService = require('../services/deviceService');

class DeviceController {
    constructor() {
        this.deviceService = deviceService;
    }

    // Get all devices
    getAllDevices = async (req, res) => {
        try {
            const filters = {
                status: req.query.status,
                manufacturer: req.query.manufacturer,
                min_price: req.query.min_price,
                max_price: req.query.max_price,
                limit: req.query.limit,
                offset: req.query.offset
            };

            const result = await this.deviceService.getAllDevices(filters);
            res.json(result);
        } catch (error) {
            res.status(500).json({
                success: false,
                message: error.message
            });
        }
    };

    // Get single device by ID
    getDeviceById = async (req, res) => {
        try {
            const device = await this.deviceService.getDeviceById(req.params.id);
            res.json({
                success: true,
                data: device
            });
        } catch (error) {
            const status = error.message.includes('not found') ? 404 : 500;
            res.status(status).json({
                success: false,
                message: error.message
            });
        }
    };

    // Search devices
    searchDevices = async (req, res) => {
        try {
            const devices = await this.deviceService.searchDevices(req.query.q);
            res.json({
                success: true,
                data: devices
            });
        } catch (error) {
            res.status(500).json({
                success: false,
                message: error.message
            });
        }
    };

    // Get devices by status
    getDevicesByStatus = async (req, res) => {
        try {
            const devices = await this.deviceService.getDevicesByStatus(req.params.status);
            res.json({
                success: true,
                data: devices
            });
        } catch (error) {
            const status = error.message.includes('Invalid status') ? 400 : 500;
            res.status(status).json({
                success: false,
                message: error.message
            });
        }
    };

    // Create new device
    createDevice = async (req, res) => {
        try {
            const result = await this.deviceService.createDevice(req.body);

            if (!result.success) {
                return res.status(400).json(result);
            }

            res.status(201).json(result);
        } catch (error) {
            res.status(500).json({
                success: false,
                message: error.message
            });
        }
    };

    // Update device
    updateDevice = async (req, res) => {
        try {
            const result = await this.deviceService.updateDevice(req.params.id, req.body);

            if (!result.success) {
                const status = result.message.includes('not found') ? 404 : 400;
                return res.status(status).json(result);
            }

            res.json(result);
        } catch (error) {
            res.status(500).json({
                success: false,
                message: error.message
            });
        }
    };

    // Delete device
    deleteDevice = async (req, res) => {
        try {
            const result = await this.deviceService.deleteDevice(req.params.id);

            if (!result.success) {
                const status = result.message.includes('not found') ? 404 : 400;
                return res.status(status).json(result);
            }

            res.json(result);
        } catch (error) {
            res.status(500).json({
                success: false,
                message: error.message
            });
        }
    };

    // Get device statistics
    // Get device statistics
    getDeviceStatistics = async (req, res) => {
        try {
            const result = await this.deviceService.getDeviceStatistics();

            // ✅ Fix: service already returns { success, data }, don't wrap again
            if (!result.success) {
                return res.status(500).json(result);
            }

            res.json(result);
        } catch (error) {
            res.status(500).json({
                success: false,
                message: 'Error fetching device statistics',
                error: error.message
            });
        }
    };
}

module.exports = DeviceController;