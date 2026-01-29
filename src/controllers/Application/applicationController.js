// controllers/applicationController.js
const express = require('express');
const router = express.Router();
const applicationService = require('../../services/Application/applicationService.js');

const applicationController = {
    // Get available devices
    getAvailableDevices: async (req, res) => {
        try {
            const devices = await applicationService.getAvailableDevices();
            res.json({
                success: true,
                data: devices,
                count: devices.length
            });
        } catch (error) {
            console.error('Get devices error:', error);
            res.status(500).json({
                success: false,
                message: 'Failed to fetch devices'
            });
        }
    },

    // Get device details
    getDeviceDetails: async (req, res) => {
        try {
            const { deviceId } = req.params;
            const device = await applicationService.getDeviceById(parseInt(deviceId));

            res.json({
                success: true,
                data: device
            });
        } catch (error) {
            console.error('Get device details error:', error);
            res.status(404).json({
                success: false,
                message: error.message
            });
        }
    },

    // Submit application
    submitApplication: async (req, res) => {
        try {
            const { client_user_id, device_id } = req.body;

            // Validate required fields
            if (!client_user_id || !device_id) {
                return res.status(400).json({
                    success: false,
                    message: 'client_user_id and device_id are required'
                });
            }

            const result = await applicationService.submitApplication(
                parseInt(client_user_id),
                parseInt(device_id)
            );

            if (result.success) {
                res.status(201).json(result);
            } else {
                res.status(400).json(result);
            }

        } catch (error) {
            console.error('Submit application error:', error);
            res.status(500).json({
                success: false,
                message: 'Internal server error'
            });
        }
    },

    // Get user applications
    getUserApplications: async (req, res) => {
        try {
            const { clientUserId } = req.params;

            if (!clientUserId) {
                return res.status(400).json({
                    success: false,
                    message: 'clientUserId is required'
                });
            }

            const applications = await applicationService.getUserApplications(parseInt(clientUserId));

            res.json({
                success: true,
                data: applications,
                count: applications.length
            });

        } catch (error) {
            console.error('Get user applications error:', error);
            res.status(500).json({
                success: false,
                message: 'Failed to fetch applications'
            });
        }
    },

    // Get application details
    getApplicationDetails: async (req, res) => {
        try {
            const { clientUserId, applicationId } = req.params;

            const application = await applicationService.getApplicationDetails(
                parseInt(applicationId),
                parseInt(clientUserId)
            );

            res.json({
                success: true,
                data: application
            });

        } catch (error) {
            console.error('Get application details error:', error);
            res.status(404).json({
                success: false,
                message: error.message
            });
        }
    },

    // Cancel application
    cancelApplication: async (req, res) => {
        try {
            const { clientUserId, applicationId } = req.params;

            const result = await applicationService.cancelApplication(
                parseInt(applicationId),
                parseInt(clientUserId)
            );

            if (result.success) {
                res.json(result);
            } else {
                res.status(400).json(result);
            }

        } catch (error) {
            console.error('Cancel application error:', error);
            res.status(500).json({
                success: false,
                message: 'Internal server error'
            });
        }
    },

    // Get application summary
    getApplicationSummary: async (req, res) => {
        try {
            const { clientUserId } = req.params;

            const summary = await applicationService.getApplicationSummary(parseInt(clientUserId));

            res.json({
                success: true,
                data: summary
            });

        } catch (error) {
            console.error('Get application summary error:', error);
            res.status(500).json({
                success: false,
                message: 'Failed to fetch summary'
            });
        }
    },

    // Check user eligibility
    checkEligibility: async (req, res) => {
        try {
            const { clientUserId } = req.params;

            const eligibility = await applicationService.checkUserEligibility(parseInt(clientUserId));

            res.json({
                success: true,
                data: eligibility
            });

        } catch (error) {
            console.error('Check eligibility error:', error);
            res.status(500).json({
                success: false,
                message: 'Failed to check eligibility'
            });
        }
    }
};

module.exports = applicationController;