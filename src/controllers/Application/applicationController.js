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
    },

    //// controllers/applicationController.js - Add these updated methods

    // Get all applications (Admin)
    getAllApplications: async (req, res) => {
        try {
            // Extract filters from query parameters
            const filters = {
                status: req.query.status,
                device_id: req.query.device_id,
                user_id: req.query.user_id,
                user_type: req.query.user_type,
                region: req.query.region,
                start_date: req.query.start_date,
                end_date: req.query.end_date,
                limit: req.query.limit || 50,
                offset: req.query.offset || 0
            };

            const result = await applicationService.getAllApplications(filters);

            res.json({
                success: true,
                ...result
            });

        } catch (error) {
            console.error('Get all applications error:', error);
            res.status(500).json({
                success: false,
                message: 'Failed to fetch applications'
            });
        }
    },

    // Update application status (Admin)
    updateApplicationStatus: async (req, res) => {
        try {
            const { applicationId } = req.params;
            const {
                status,
                rejection_reason,
                notes,
                approver_id,
                is_admin = false
            } = req.body;

            // Validate required fields
            if (!status) {
                return res.status(400).json({
                    success: false,
                    message: 'status is required'
                });
            }

            // Validate status matches database enum
            const validStatuses = ['Pending', 'Approved', 'Rejected', 'Cancelled'];
            if (!validStatuses.includes(status)) {
                return res.status(400).json({
                    success: false,
                    message: `Invalid status. Must be one of: ${validStatuses.join(', ')}`
                });
            }

            // Check if approver ID is required for approval
            if (status === 'Approved' && !approver_id) {
                return res.status(400).json({
                    success: false,
                    message: 'approver_id is required for approval'
                });
            }

            // Check if rejection reason is required
            if (status === 'Rejected' && !rejection_reason) {
                return res.status(400).json({
                    success: false,
                    message: 'rejection_reason is required for rejected applications'
                });
            }

            const result = await applicationService.updateApplicationStatus(
                parseInt(applicationId),
                {
                    status,
                    rejection_reason,
                    notes,
                    is_admin
                },
                approver_id ? parseInt(approver_id) : null
            );

            if (result.success) {
                res.json(result);
            } else {
                res.status(400).json(result);
            }

        } catch (error) {
            console.error('Update application status error:', error);
            res.status(500).json({
                success: false,
                message: error.message || 'Failed to update application status'
            });
        }
    },

    // Get application statistics (Admin)
    getApplicationStatistics: async (req, res) => {
        try {
            const filters = {
                start_date: req.query.start_date,
                end_date: req.query.end_date,
                region: req.query.region
            };

            const result = await applicationService.getApplicationStatistics(filters);

            res.json({
                success: true,
                ...result
            });

        } catch (error) {
            console.error('Get application statistics error:', error);
            res.status(500).json({
                success: false,
                message: 'Failed to fetch application statistics'
            });
        }
    },

    // Get application details (Admin version - more details)
    getAdminApplicationDetails: async (req, res) => {
        try {
            const { applicationId } = req.params;
            console.log('First ID: ',applicationId)
            const id = parseInt(applicationId);
            console.log('Parsed applicationId:', id);

            const application = await applicationService.getAdminApplicationDetails(id);


            res.json({
                success: true,
                data: application
            });

        } catch (error) {
            console.error('Get admin application details error:', error);
            res.status(404).json({
                success: false,
                message: error.message
            });
        }
    }




};

module.exports = applicationController;