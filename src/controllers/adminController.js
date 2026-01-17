const adminService = require('../services/adminService');

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

            // Validate status
            const validStatuses = ['Pending', 'Verified', 'Rejected'];
            if (!validStatuses.includes(status)) {
                return res.status(400).json({
                    success: false,
                    message: 'Invalid status. Must be: Pending, Verified, or Rejected',
                    data: null,
                    timestamp: new Date().toISOString()
                });
            }

            const updatedUser = await adminService.updateUserRegistrationStatus(id, status, notes);

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
}

module.exports = new AdminController();