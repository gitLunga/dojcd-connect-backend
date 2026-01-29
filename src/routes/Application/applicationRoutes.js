// routes/applications.js
const express = require('express');
const router = express.Router();
const applicationController = require('../../controllers/Application/applicationController');

// Device catalog (SIM is bundled with device)
router.get('/devices', applicationController.getAvailableDevices);
router.get('/devices/:deviceId', applicationController.getDeviceDetails);

// Application management
router.post('/applications', applicationController.submitApplication);
router.get('/users/:clientUserId/applications', applicationController.getUserApplications);
router.get('/users/:clientUserId/applications/:applicationId', applicationController.getApplicationDetails);
router.put('/users/:clientUserId/applications/:applicationId/cancel', applicationController.cancelApplication);
router.get('/users/:clientUserId/applications/summary', applicationController.getApplicationSummary);
router.get('/users/:clientUserId/eligibility', applicationController.checkEligibility);

module.exports = router;