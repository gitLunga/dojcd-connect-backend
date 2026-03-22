const adminService = require('../services/adminService');
const path = require('path');

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
            const {id} = req.params;
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
            const {id} = req.params;
            const signedUrl = await adminService.getInvoiceSignedUrl(parseInt(id));
            const meta = await adminService.getClientInvoice(parseInt(id));
            res.status(200).json({
                success: true,
                message: 'Download URL generated',
                url: signedUrl,
                fileName: meta.fileName,
                mimeType: meta.mimeType,
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

    // NEW METHOD: View invoice (inline in browser)
    async viewInvoice(req, res) {
        try {
            const {id} = req.params;
            const signedUrl = await adminService.getInvoiceSignedUrl(parseInt(id));
            const meta = await adminService.getClientInvoice(parseInt(id));
            res.status(200).json({
                success: true,
                message: 'Invoice URL generated',
                url: signedUrl,
                fileName: meta.fileName,
                mimeType: meta.mimeType,
            });
        } catch (error) {
            const isLegacy = error.message.includes('before cloud storage');
            res.status(isLegacy ? 410 : 404).json({
                success: false,
                legacy: isLegacy,
                message: error.message,
                data: null,
            });
        }
    }

    // NEW METHOD: Get invoice info (metadata only)
    async getInvoiceInfo(req, res) {
        try {
            const {id} = req.params;
            const result = await adminService.getClientUserById(id);

            if (!result.invoice_path) {
                return res.status(404).json({
                    success: false,
                    message: 'No invoice found for this user',
                    data: null
                });
            }

            const invoicePath = result.invoice_path;
            res.status(200).json({
                success: true,
                message: 'Invoice info retrieved successfully',
                data: {
                    file_name: path.basename(invoicePath),
                    file_size: null,
                    uploaded_date: result.updated_at || result.created_at,
                    mime_type: adminService.getMimeType(invoicePath),
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
            const {id} = req.params;
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
            const {id} = req.params;
            const {status, notes} = req.body;


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
            const {query} = req.query;

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
            const {id} = req.params;
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
            const {id} = req.params;
            const docId = parseInt(id);
            const signedUrl = await adminService.getDocumentSignedUrl(docId);
            const docInfo = await adminService.downloadUserDocument(docId);
            res.status(200).json({
                success: true,
                message: 'Download URL generated',
                url: signedUrl,
                fileName: docInfo.fileName,
                mimeType: docInfo.mimeType,
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

// View ANY document inline
    async viewDocument(req, res) {
        try {
            const {id} = req.params;
            const docId = parseInt(id);
            const signedUrl = await adminService.getDocumentSignedUrl(docId);
            const docInfo = await adminService.viewUserDocument(docId);
            res.status(200).json({
                success: true,
                message: 'Document URL generated',
                url: signedUrl,
                fileName: docInfo.fileName,
                mimeType: docInfo.mimeType,
            });
        } catch (error) {
            const isLegacy = error.message.includes('before cloud storage');
            res.status(isLegacy ? 410 : 404).json({
                success: false,
                legacy: isLegacy,
                message: error.message,
                data: null,
            });
        }
    }

// Update document status
    async updateDocumentStatus(req, res) {
        try {
            const {id} = req.params;
            const {status, notes} = req.body;

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

    // Returns a signed Supabase URL — frontend opens this directly, no blob proxying
    async getDocumentSignedUrl(req, res) {
        try {
            const {id} = req.params;
            const signedUrl = await adminService.getDocumentSignedUrl(parseInt(id));
            res.status(200).json({success: true, message: 'Signed URL generated', data: {url: signedUrl}});
        } catch (error) {
            res.status(404).json({success: false, message: error.message, data: null});
        }
    }

    async getInvoiceSignedUrl(req, res) {
        try {
            const {id} = req.params;
            const signedUrl = await adminService.getInvoiceSignedUrl(parseInt(id));
            res.status(200).json({success: true, message: 'Signed URL generated', data: {url: signedUrl}});
        } catch (error) {
            res.status(404).json({success: false, message: error.message, data: null});
        }
    }

    // ── CREATE OPERATIONAL USER ──────────────────────────────────────────────────
    async createOperationalUser(req, res) {
        try {
            const { first_name, last_name, email, user_role } = req.body;

            // Basic validation
            if (!first_name?.trim() || !last_name?.trim() || !email?.trim() || !user_role) {
                return res.status(400).json({
                    success: false,
                    message: 'First name, last name, email, and role are required.',
                    data: null,
                    timestamp: new Date().toISOString()
                });
            }

            if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
                return res.status(400).json({
                    success: false,
                    message: 'Please provide a valid email address.',
                    data: null,
                    timestamp: new Date().toISOString()
                });
            }

            const validRoles = ['Admin', 'Manager', 'Support'];
            if (!validRoles.includes(user_role)) {
                return res.status(400).json({
                    success: false,
                    message: `Invalid role. Must be one of: ${validRoles.join(', ')}.`,
                    data: null,
                    timestamp: new Date().toISOString()
                });
            }

            const { user, defaultPassword } = await adminService.createOperationalUser(req.body);

            return res.status(201).json({
                success: true,
                message: `${user.first_name} ${user.last_name} has been added as a ${user.user_role}.`,
                data: { user, default_password: defaultPassword, },
                timestamp: new Date().toISOString()
            });
        } catch (error) {
            const isDuplicate = error.message.includes('already exists');
            return res.status(isDuplicate ? 409 : 500).json({
                success: false,
                message: error.message,
                data: null,
                timestamp: new Date().toISOString()
            });
        }
    }

// ── UPDATE OPERATIONAL USER ──────────────────────────────────────────────────
    async updateOperationalUser(req, res) {
        try {
            const { id } = req.params;
            const { title, first_name, last_name, email, user_role } = req.body;

            if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
                return res.status(400).json({
                    success: false,
                    message: 'Please provide a valid email address.',
                    data: null,
                    timestamp: new Date().toISOString()
                });
            }

            if (user_role) {
                const validRoles = ['Admin', 'Manager', 'Support'];
                if (!validRoles.includes(user_role)) {
                    return res.status(400).json({
                        success: false,
                        message: `Invalid role. Must be one of: ${validRoles.join(', ')}.`,
                        data: null,
                        timestamp: new Date().toISOString()
                    });
                }
            }

            const user = await adminService.updateOperationalUser(id, req.body);

            return res.status(200).json({
                success: true,
                message: `${user.first_name} ${user.last_name}'s profile has been updated.`,
                data: { user },
                timestamp: new Date().toISOString()
            });
        } catch (error) {
            const isDuplicate = error.message.includes('already exists');
            const isNotFound = error.message.includes('not found');
            return res.status(isDuplicate ? 409 : isNotFound ? 404 : 500).json({
                success: false,
                message: error.message,
                data: null,
                timestamp: new Date().toISOString()
            });
        }
    }

// ── DELETE OPERATIONAL USER ──────────────────────────────────────────────────
    async deleteOperationalUser(req, res) {
        try {
            const { id } = req.params;
            const deleted = await adminService.deleteOperationalUser(id);

            return res.status(200).json({
                success: true,
                message: `${deleted.first_name} ${deleted.last_name} has been removed.`,
                data: { user: deleted },
                timestamp: new Date().toISOString()
            });
        } catch (error) {
            const isNotFound = error.message.includes('not found');
            return res.status(isNotFound ? 404 : 500).json({
                success: false,
                message: error.message,
                data: null,
                timestamp: new Date().toISOString()
            });
        }
    }

    async changeOperationalUserPassword(req, res) {
        try {
            const {id} = req.params;
            const {current_password, new_password, confirm_password} = req.body;

            if (!current_password || !new_password || !confirm_password) {
                return res.status(400).json({
                    success: false,
                    message: 'Current password, new password, and confirmation are required.',
                    data: null,
                    timestamp: new Date().toISOString()
                });
            }

            if (new_password !== confirm_password) {
                return res.status(400).json({
                    success: false,
                    message: 'New password and confirmation do not match.',
                    data: null,
                    timestamp: new Date().toISOString()
                });
            }

            if (new_password.length < 8) {
                return res.status(400).json({
                    success: false,
                    message: 'New password must be at least 8 characters.',
                    data: null,
                    timestamp: new Date().toISOString()
                });
            }

            await adminService.changeOperationalUserPassword(id, current_password, new_password);

            return res.status(200).json({
                success: true,
                message: 'Password changed successfully.',
                data: null,
                timestamp: new Date().toISOString()
            });
        } catch (error) {
            const isAuth = error.message.includes('incorrect');
            return res.status(isAuth ? 401 : 500).json({
                success: false,
                message: error.message,
                data: null,
                timestamp: new Date().toISOString()
            });
        }
    }

    async promoteToSuperAdmin(req, res) {
        try {
            const {id} = req.params;
            const user = await adminService.promoteToSuperAdmin(id);
            return res.status(200).json({
                success: true,
                message: `${user.first_name} ${user.last_name} has been promoted to Super Admin.`,
                data: {user},
                timestamp: new Date().toISOString()
            });
        } catch (error) {
            return res.status(error.message.includes('not found') ? 404 : 500).json({
                success: false, message: error.message,
                data: null, timestamp: new Date().toISOString()
            });
        }
    }

    async demoteSuperAdmin(req, res) {
        try {
            const {id} = req.params;

            // Prevent demoting yourself
            const requestingUser = req.user; // from your JWT middleware
            if (requestingUser?.op_user_id === parseInt(id)) {
                return res.status(400).json({
                    success: false,
                    message: 'You cannot demote yourself.',
                    data: null, timestamp: new Date().toISOString()
                });
            }

            const user = await adminService.demoteSuperAdmin(id);
            return res.status(200).json({
                success: true,
                message: `${user.first_name} ${user.last_name} has been demoted from Super Admin.`,
                data: {user},
                timestamp: new Date().toISOString()
            });
        } catch (error) {
            return res.status(error.message.includes('not found') ? 404 : 500).json({
                success: false, message: error.message,
                data: null, timestamp: new Date().toISOString()
            });
        }
    }




}

module.exports = new AdminController();