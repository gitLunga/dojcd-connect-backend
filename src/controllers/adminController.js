const adminService = require('../services/adminService');
const path = require('path');
const fs = require('fs');

// ─── Utility: standard success response ──────────────────────────────────────
function ok(res, message, data = null, statusCode = 200) {
    return res.status(statusCode).json({
        success: true,
        message,
        data,
        timestamp: new Date().toISOString()
    });
}

// ─── Utility: standard error response ────────────────────────────────────────
function fail(res, message, statusCode = 400) {
    return res.status(statusCode).json({
        success: false,
        message,
        data: null,
        timestamp: new Date().toISOString()
    });
}

class AdminController {

    // ─── USERS ───────────────────────────────────────────────────────────────

    async getAllUsers(req, res) {
        try {
            const users = await adminService.getAllUsers();
            return ok(res, 'All registered users retrieved successfully.', { users });
        } catch (error) {
            console.error('❌ getAllUsers controller error:', error);
            return fail(res, error.message, 500);
        }
    }

    async getAllClientUsers(req, res) {
        try {
            const users = await adminService.getAllClientUsers();
            return ok(res, 'Client users retrieved successfully.', { users });
        } catch (error) {
            return fail(res, error.message, 500);
        }
    }

    async getClientUserById(req, res) {
        try {
            const { id } = req.params;
            const user = await adminService.getClientUserById(id);
            return ok(res, 'User details retrieved successfully.', { user });
        } catch (error) {
            const status = error.message.includes('not found') ? 404 : 500;
            return fail(res, error.message, status);
        }
    }

    async getAllOperationalUsers(req, res) {
        try {
            const users = await adminService.getAllOperationalUsers();
            return ok(res, 'Operational users retrieved successfully.', { users });
        } catch (error) {
            return fail(res, error.message, 500);
        }
    }

    async getOperationalUserById(req, res) {
        try {
            const { id } = req.params;
            const user = await adminService.getOperationalUserById(id);
            return ok(res, 'Operational user retrieved successfully.', { user });
        } catch (error) {
            const status = error.message.includes('not found') ? 404 : 500;
            return fail(res, error.message, status);
        }
    }

    // ─── STATUS UPDATE ────────────────────────────────────────────────────────

    async updateUserStatus(req, res) {
        try {
            const { id } = req.params;
            const { status, notes } = req.body;

            if (!status) {
                return fail(res, 'Please provide a status to update.', 400);
            }

            const normalizedStatus = status.charAt(0).toUpperCase() + status.slice(1).toLowerCase();
            const validStatuses = ['Pending', 'Verified', 'Rejected', 'Profile_Completed'];

            if (!validStatuses.includes(normalizedStatus)) {
                return fail(res, `"${status}" is not a valid status. Please use one of: ${validStatuses.join(', ')}.`, 400);
            }

            const updatedUser = await adminService.updateUserRegistrationStatus(id, normalizedStatus, notes);

            const messages = {
                Verified: `${updatedUser.first_name} ${updatedUser.last_name}'s account has been verified successfully.`,
                Rejected: `${updatedUser.first_name} ${updatedUser.last_name}'s account has been rejected.`,
                Pending: `${updatedUser.first_name} ${updatedUser.last_name}'s status has been set to Pending.`,
                Profile_Completed: `${updatedUser.first_name} ${updatedUser.last_name}'s profile has been marked as completed.`
            };

            return ok(res, messages[normalizedStatus] || 'User status updated successfully.', { user: updatedUser });
        } catch (error) {
            // Already-verified lock or not-found → 409 Conflict or 404
            if (error.message.includes('already verified')) {
                return fail(res, error.message, 409);
            }
            if (error.message.includes('not found')) {
                return fail(res, error.message, 404);
            }
            return fail(res, error.message, 500);
        }
    }

    // ─── INVOICES ────────────────────────────────────────────────────────────

    async downloadInvoice(req, res) {
        try {
            const { id } = req.params;
            await adminService.downloadInvoice(id, res);
        } catch (error) {
            console.error('Invoice download error:', error);
            if (!res.headersSent) {
                const status = error.message.includes('not found') || error.message.includes('No invoice') ? 404 : 500;
                return fail(res, error.message, status);
            }
            res.end();
        }
    }

    async viewInvoice(req, res) {
        try {
            const { id } = req.params;
            const invoiceInfo = await adminService.getClientInvoice(id);

            res.setHeader('Content-Disposition', `inline; filename="${invoiceInfo.fileName}"`);
            res.setHeader('Content-Type', invoiceInfo.mimeType);

            const fileStream = fs.createReadStream(invoiceInfo.filePath);
            fileStream.pipe(res);

            fileStream.on('error', () => {
                if (!res.headersSent) {
                    return fail(res, 'There was a problem loading the invoice. Please try again.', 500);
                }
            });
        } catch (error) {
            console.error('Invoice view error:', error);
            if (!res.headersSent) {
                const status = error.message.includes('not found') || error.message.includes('No invoice') ? 404 : 500;
                return fail(res, error.message, status);
            }
        }
    }

    async getInvoiceInfo(req, res) {
        try {
            const { id } = req.params;
            const result = await adminService.getClientUserById(id);

            if (!result.invoice_path) {
                return fail(res, 'No invoice has been uploaded for this user.', 404);
            }

            const fullPath = path.join(__dirname, '..', result.invoice_path.startsWith('/') ? result.invoice_path.slice(1) : result.invoice_path);
            const stats = fs.statSync(fullPath);

            return ok(res, 'Invoice information retrieved successfully.', {
                file_name: path.basename(result.invoice_path),
                file_path: result.invoice_path,
                file_size: stats.size,
                uploaded_date: stats.mtime,
                mime_type: adminService.getMimeType(fullPath)
            });
        } catch (error) {
            const status = error.message.includes('not found') ? 404 : 500;
            return fail(res, error.message, status);
        }
    }

    // ─── STATISTICS & DASHBOARD ───────────────────────────────────────────────

    async getStatistics(req, res) {
        try {
            const statistics = await adminService.getUserStatistics();
            return ok(res, 'Statistics retrieved successfully.', { statistics });
        } catch (error) {
            return fail(res, error.message, 500);
        }
    }

    async getRecentRegistrations(req, res) {
        try {
            const registrations = await adminService.getRecentRegistrations();
            return ok(res, 'Recent registrations retrieved successfully.', { registrations });
        } catch (error) {
            return fail(res, error.message, 500);
        }
    }

    async getActivitySummary(req, res) {
        try {
            const activity = await adminService.getUserActivitySummary();
            return ok(res, 'Activity summary retrieved successfully.', { activity });
        } catch (error) {
            return fail(res, error.message, 500);
        }
    }

    async getDashboardData(req, res) {
        try {
            const [statistics, recentRegistrations, activitySummary] = await Promise.all([
                adminService.getUserStatistics(),
                adminService.getRecentRegistrations(),
                adminService.getUserActivitySummary()
            ]);

            return ok(res, 'Dashboard data retrieved successfully.', {
                statistics,
                recent_registrations: recentRegistrations,
                activity_summary: activitySummary
            });
        } catch (error) {
            return fail(res, error.message, 500);
        }
    }

    async getEnhancedStatistics(req, res) {
        try {
            const statistics = await adminService.getEnhancedStatistics();
            return ok(res, 'Enhanced statistics retrieved successfully.', { statistics });
        } catch (error) {
            return fail(res, error.message, 500);
        }
    }

    async getDashboardMetrics(req, res) {
        try {
            const metrics = await adminService.getDashboardMetrics();
            return ok(res, 'Dashboard metrics retrieved successfully.', { metrics });
        } catch (error) {
            return fail(res, error.message, 500);
        }
    }

    async getPerformanceStats(req, res) {
        try {
            const stats = await adminService.getPerformanceStats();
            return ok(res, 'Performance statistics retrieved successfully.', { stats });
        } catch (error) {
            return fail(res, error.message, 500);
        }
    }

    // ─── SEARCH ───────────────────────────────────────────────────────────────

    async searchUsers(req, res) {
        try {
            const { query } = req.query;

            if (!query || query.trim().length < 2) {
                return fail(res, 'Please enter at least 2 characters to search.', 400);
            }

            const users = await adminService.searchUsers(query.trim());

            if (users.length === 0) {
                return ok(res, `No users found matching "${query.trim()}".`, { users, count: 0 });
            }

            return ok(res, `Found ${users.length} user(s) matching your search.`, { users, count: users.length });
        } catch (error) {
            return fail(res, error.message, 500);
        }
    }

    // ─── DOCUMENTS ───────────────────────────────────────────────────────────

    async getAllUserDocuments(req, res) {
        try {
            const { id } = req.params;
            const documents = await adminService.getAllUserDocuments(id);

            const message = documents.length === 0
                ? 'This user has not uploaded any documents yet.'
                : `${documents.length} document(s) retrieved successfully.`;

            return ok(res, message, { user_id: id, documents });
        } catch (error) {
            const status = error.message.includes('not found') ? 404 : 500;
            return fail(res, error.message, status);
        }
    }

    async downloadDocument(req, res) {
        try {
            const { id } = req.params;
            const docInfo = await adminService.downloadUserDocument(id);

            res.setHeader('Content-Disposition', `attachment; filename="${docInfo.fileName}"`);
            res.setHeader('Content-Type', docInfo.mimeType);

            const fileStream = fs.createReadStream(docInfo.filePath);
            fileStream.pipe(res);

            fileStream.on('error', () => {
                if (!res.headersSent) {
                    return fail(res, 'There was a problem downloading the document. Please try again.', 500);
                }
            });
        } catch (error) {
            if (!res.headersSent) {
                const status = error.message.includes('not found') || error.message.includes('could not be found') ? 404 : 500;
                return fail(res, error.message, status);
            }
        }
    }

    async viewDocument(req, res) {
        try {
            const { id } = req.params;
            const docInfo = await adminService.viewUserDocument(id);

            res.setHeader('Content-Disposition', `inline; filename="${docInfo.fileName}"`);
            res.setHeader('Content-Type', docInfo.mimeType);

            const fileStream = fs.createReadStream(docInfo.filePath);
            fileStream.pipe(res);

            fileStream.on('error', () => {
                if (!res.headersSent) {
                    return fail(res, 'There was a problem loading the document. Please try again.', 500);
                }
            });
        } catch (error) {
            if (!res.headersSent) {
                const status = error.message.includes('not found') || error.message.includes('could not be found') ? 404 : 500;
                return fail(res, error.message, status);
            }
        }
    }

    async updateDocumentStatus(req, res) {
        try {
            const { id } = req.params;
            const { status, notes } = req.body;

            if (!status) {
                return fail(res, 'Please provide a status to update.', 400);
            }

            const updatedDoc = await adminService.updateDocumentStatus(id, status, notes);

            const messages = {
                Verified: 'Document has been verified successfully.',
                Rejected: 'Document has been rejected.',
                Pending: 'Document status has been set back to Pending.'
            };

            return ok(res, messages[status] || 'Document status updated successfully.', { document: updatedDoc });
        } catch (error) {
            const status = error.message.includes('not found') ? 404 : 500;
            return fail(res, error.message, status);
        }
    }
}

module.exports = new AdminController();