const express       = require('express');
const router        = express.Router();
const pdfController = require('../controllers/pdfController');
const authenticate  = require('../middleware/authenticate');
const requireRoles  = require('../middleware/authorize');

router.use(authenticate);

// Allocation letter — visible to Admin, Manager, Finance, Approver
router.get(
    '/allocation-letter/:applicationId',
    requireRoles('Admin', 'Manager', 'Finance', 'Approver'),
    (req, res) => pdfController.allocationLetter(req, res)
);

// Contract summary — visible to Admin, Finance
router.get(
    '/contract/:contractId',
    requireRoles('Admin', 'Finance'),
    (req, res) => pdfController.contractSummary(req, res)
);

// Order confirmation — visible to Admin, Finance
router.get(
    '/order/:orderId',
    requireRoles('Admin', 'Finance'),
    (req, res) => pdfController.orderConfirmation(req, res)
);

module.exports = router;
