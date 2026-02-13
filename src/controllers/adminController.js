const adminService = require('../services/adminService');
const path = require('path');
const fs = require('fs');

class AdminController {

    //Sphelele
    async getAllUsers(req, res) {
        try {
            const users = await adminService.getAllUsers();
            return res.status(200).json({
                success: true,
                message: 'All registered users fetched successfully',
                data: users,
            });
        } catch (error) {
            console.error('❌ getAllUsers controller error:', error);
            return res.status(500).json({
                success: false,
                message: 'Failed to fetch registered users',
            });
        }
    }

    // Get all client users
    async getAllClientUsers(req, res) {
        try {
            const users = await adminService.getAllClientUsers();
            res.status(200).json({
                success: true,
                message: 'Client users retrieved successfully',
                data: {
                    users: users
                },
                timestamp: new Date().toISOString()
            });
        } catch (error) {
            res.status(500).json({
                success: false,
                message: error.message,
                data: null,
                timestamp: new Date().toISOString()
            });
        }
    }

    // Get client user by ID
    async getClientUserById(req, res) {
        try {
            const { id } = req.params;
            const user = await adminService.getClientUserById(id);

            res.status(200).json({
                success: true,
                message: 'Client user retrieved successfully',
                data: {
                    user: user
                },
                timestamp: new Date().toISOString()
            });
        } catch (error) {
            res.status(404).json({
                success: false,
                message: error.message,
                data: null,
                timestamp: new Date().toISOString()
            });
        }
    }

    // NEW METHOD: Download invoice
    async downloadInvoice(req, res) {
        try {
            const { id } = req.params;
            await adminService.downloadInvoice(id, res);
            // Note: The response is handled by the downloadInvoice method
            // No need to send JSON response here
        } catch (error) {
            console.error('Invoice download error:', error);

            // If headers haven't been sent yet, send error JSON
            if (!res.headersSent) {
                res.status(404).json({
                    success: false,
                    message: error.message,
                    data: null,
                    timestamp: new Date().toISOString()
                });
            } else {
                // If headers were sent, end the response
                res.end();
            }
        }
    }

    // NEW METHOD: View invoice (inline in browser)
    async viewInvoice(req, res) {
        try {
            const { id } = req.params;
            const invoiceInfo = await adminService.getClientInvoice(id);

            // Set headers for inline viewing
            res.setHeader('Content-Disposition', `inline; filename="${invoiceInfo.fileName}"`);
            res.setHeader('Content-Type', invoiceInfo.mimeType);

            // Stream the file
            const fileStream = fs.createReadStream(invoiceInfo.filePath);
            fileStream.pipe(res);

            fileStream.on('error', (error) => {
                console.error('File stream error:', error);
                if (!res.headersSent) {
                    res.status(500).json({
                        success: false,
                        message: 'Error streaming file',
                        data: null
                    });
                }
            });

        } catch (error) {
            console.error('Invoice view error:', error);
            if (!res.headersSent) {
                res.status(404).json({
                    success: false,
                    message: error.message,
                    data: null,
                    timestamp: new Date().toISOString()
                });
            }
        }
    }

    // NEW METHOD: Get invoice info (metadata only)
    async getInvoiceInfo(req, res) {
        try {
            const { id } = req.params;
            const result = await adminService.getClientUserById(id);

            if (!result.invoice_path) {
                return res.status(404).json({
                    success: false,
                    message: 'No invoice found for this user',
                    data: null
                });
            }

            const invoicePath = result.invoice_path;
            const fullPath = path.join(__dirname, '..', invoicePath);

            // Get file stats
            const stats = fs.statSync(fullPath);

            res.status(200).json({
                success: true,
                message: 'Invoice info retrieved successfully',
                data: {
                    file_name: path.basename(invoicePath),
                    file_path: invoicePath,
                    file_size: stats.size,
                    uploaded_date: stats.mtime,
                    mime_type: adminService.getMimeType(fullPath)
                }
            });

        } catch (error) {
            res.status(404).json({
                success: false,
                message: error.message,
                data: null
            });
        }
    }


    // Get all operational users
    async getAllOperationalUsers(req, res) {
        try {
            const users = await adminService.getAllOperationalUsers();
            res.status(200).json({
                success: true,
                message: 'Operational users retrieved successfully',
                data: {
                    users: users
                },
                timestamp: new Date().toISOString()
            });
        } catch (error) {
            res.status(500).json({
                success: false,
                message: error.message,
                data: null,
                timestamp: new Date().toISOString()
            });
        }
    }

    // Get operational user by ID
    async getOperationalUserById(req, res) {
        try {
            const { id } = req.params;
            const user = await adminService.getOperationalUserById(id);

            res.status(200).json({
                success: true,
                message: 'Operational user retrieved successfully',
                data: {
                    user: user
                },
                timestamp: new Date().toISOString()
            });
        } catch (error) {
            res.status(404).json({
                success: false,
                message: error.message,
                data: null,
                timestamp: new Date().toISOString()
            });
        }
    }
    // Update user registration status
    async updateUserStatus(req, res) {
        try {
            const { id } = req.params;
            const { status, notes } = req.body;


            const normalizedStatus = status.charAt(0).toUpperCase() + status.slice(1).toLowerCase();

            // Validate status
            const validStatuses = ['Pending', 'Verified', 'Rejected', 'Profile_Completed'];
            if (!validStatuses.includes(normalizedStatus)) {
                return res.status(400).json({
                    success: false,
                    message: `Invalid status: "${status}". Must be one of: ${validStatuses.join(', ')}`,
                    data: null,
                    timestamp: new Date().toISOString()
                });
            }


            const updatedUser = await adminService.updateUserRegistrationStatus(id, normalizedStatus, notes);

            res.status(200).json({
                success: true,
                message: 'User status updated successfully',
                data: {
                    user: updatedUser
                },
                timestamp: new Date().toISOString()
            });
        } catch (error) {
            res.status(404).json({
                success: false,
                message: error.message,
                data: null,
                timestamp: new Date().toISOString()
            });
        }
    }

    // Get user statistics
    async getStatistics(req, res) {
        try {
            const statistics = await adminService.getUserStatistics();
            res.status(200).json({
                success: true,
                message: 'Statistics retrieved successfully',
                data: {
                    statistics: statistics
                },
                timestamp: new Date().toISOString()
            });
        } catch (error) {
            res.status(500).json({
                success: false,
                message: error.message,
                data: null,
                timestamp: new Date().toISOString()
            });
        }
    }

    // Get recent registrations
    async getRecentRegistrations(req, res) {
        try {
            const registrations = await adminService.getRecentRegistrations();
            res.status(200).json({
                success: true,
                message: 'Recent registrations retrieved successfully',
                data: {
                    registrations: registrations
                },
                timestamp: new Date().toISOString()
            });
        } catch (error) {
            res.status(500).json({
                success: false,
                message: error.message,
                data: null,
                timestamp: new Date().toISOString()
            });
        }
    }

    // Search users
    async searchUsers(req, res) {
        try {
            const { query } = req.query;

            if (!query || query.trim().length < 2) {
                return res.status(400).json({
                    success: false,
                    message: 'Search query must be at least 2 characters',
                    data: null,
                    timestamp: new Date().toISOString()
                });
            }

            const users = await adminService.searchUsers(query.trim());
            res.status(200).json({
                success: true,
                message: 'Search results retrieved successfully',
                data: {
                    users: users,
                    count: users.length
                },
                timestamp: new Date().toISOString()
            });
        } catch (error) {
            res.status(500).json({
                success: false,
                message: error.message,
                data: null,
                timestamp: new Date().toISOString()
            });
        }
    }

    // Get user activity summary
    async getActivitySummary(req, res) {
        try {
            const activity = await adminService.getUserActivitySummary();
            res.status(200).json({
                success: true,
                message: 'Activity summary retrieved successfully',
                data: {
                    activity: activity
                },
                timestamp: new Date().toISOString()
            });
        } catch (error) {
            res.status(500).json({
                success: false,
                message: error.message,
                data: null,
                timestamp: new Date().toISOString()
            });
        }
    }

    // Get dashboard data (combined stats)
    async getDashboardData(req, res) {
        try {
            const [statistics, recentRegistrations, activitySummary] = await Promise.all([
                adminService.getUserStatistics(),
                adminService.getRecentRegistrations(),
                adminService.getUserActivitySummary()
            ]);

            res.status(200).json({
                success: true,
                message: 'Dashboard data retrieved successfully',
                data: {
                    statistics: statistics,
                    recent_registrations: recentRegistrations,
                    activity_summary: activitySummary
                },
                timestamp: new Date().toISOString()
            });
        } catch (error) {
            res.status(500).json({
                success: false,
                message: error.message,
                data: null,
                timestamp: new Date().toISOString()
            });
        }
    }
    // Add these methods to your existing AdminController class

// Get enhanced statistics
    async getEnhancedStatistics(req, res) {
        try {
            const statistics = await adminService.getEnhancedStatistics();
            res.status(200).json({
                success: true,
                message: 'Enhanced statistics retrieved successfully',
                data: {
                    statistics: statistics
                },
                timestamp: new Date().toISOString()
            });
        } catch (error) {
            res.status(500).json({
                success: false,
                message: error.message,
                data: null,
                timestamp: new Date().toISOString()
            });
        }
    }

// Get dashboard metrics
    async getDashboardMetrics(req, res) {
        try {
            const metrics = await adminService.getDashboardMetrics();
            res.status(200).json({
                success: true,
                message: 'Dashboard metrics retrieved successfully',
                data: {
                    metrics: metrics
                },
                timestamp: new Date().toISOString()
            });
        } catch (error) {
            res.status(500).json({
                success: false,
                message: error.message,
                data: null,
                timestamp: new Date().toISOString()
            });
        }
    }

// Get performance statistics
    async getPerformanceStats(req, res) {
        try {
            const stats = await adminService.getPerformanceStats();
            res.status(200).json({
                success: true,
                message: 'Performance statistics retrieved successfully',
                data: {
                    stats: stats
                },
                timestamp: new Date().toISOString()
            });
        } catch (error) {
            res.status(500).json({
                success: false,
                message: error.message,
                data: null,
                timestamp: new Date().toISOString()
            });
        }
    }

    //DOCUMENTS
    async getAllUserDocuments(req, res) {
        try {
            const { id } = req.params;
            const documents = await adminService.getAllUserDocuments(id);

            res.status(200).json({
                success: true,
                message: 'User documents retrieved successfully',
                data: {
                    user_id: id,
                    documents: documents
                },
                timestamp: new Date().toISOString()
            });
        } catch (error) {
            res.status(404).json({
                success: false,
                message: error.message,
                data: null,
                timestamp: new Date().toISOString()
            });
        }
    }

// Download ANY document
    async downloadDocument(req, res) {
        try {
            const { id } = req.params; // document ID
            const docInfo = await adminService.downloadUserDocument(id);

            res.setHeader('Content-Disposition', `attachment; filename="${docInfo.fileName}"`);
            res.setHeader('Content-Type', docInfo.mimeType);

            const fileStream = fs.createReadStream(docInfo.filePath);
            fileStream.pipe(res);

            fileStream.on('error', (error) => {
                if (!res.headersSent) {
                    res.status(500).json({
                        success: false,
                        message: 'Error streaming file',
                        data: null
                    });
                }
            });

        } catch (error) {
            if (!res.headersSent) {
                res.status(404).json({
                    success: false,
                    message: error.message,
                    data: null,
                    timestamp: new Date().toISOString()
                });
            }
        }
    }

// View ANY document inline
    async viewDocument(req, res) {
        try {
            const { id } = req.params;
            const docInfo = await adminService.viewUserDocument(id);

            res.setHeader('Content-Disposition', `inline; filename="${docInfo.fileName}"`);
            res.setHeader('Content-Type', docInfo.mimeType);

            const fileStream = fs.createReadStream(docInfo.filePath);
            fileStream.pipe(res);

            fileStream.on('error', (error) => {
                if (!res.headersSent) {
                    res.status(500).json({
                        success: false,
                        message: 'Error streaming file',
                        data: null
                    });
                }
            });

        } catch (error) {
            if (!res.headersSent) {
                res.status(404).json({
                    success: false,
                    message: error.message,
                    data: null,
                    timestamp: new Date().toISOString()
                });
            }
        }
    }

// Update document status
    async updateDocumentStatus(req, res) {
        try {
            const { id } = req.params;
            const { status, notes } = req.body;

            const updatedDoc = await adminService.updateDocumentStatus(id, status, notes);

            res.status(200).json({
                success: true,
                message: 'Document status updated successfully',
                data: {
                    document: updatedDoc
                },
                timestamp: new Date().toISOString()
            });
        } catch (error) {
            res.status(404).json({
                success: false,
                message: error.message,
                data: null,
                timestamp: new Date().toISOString()
            });
        }
    }


}

module.exports = new AdminController();