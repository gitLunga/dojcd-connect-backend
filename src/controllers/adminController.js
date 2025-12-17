const AdminService = require('../services/AdminService');

class AdminController {
    async getAllUsers(req, res) {
        try {
            const users = await AdminService.getAllUsers();
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
}

module.exports = new AdminController();
