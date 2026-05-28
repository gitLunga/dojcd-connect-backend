// requireRoles('Admin', 'Manager') — returns 403 if the authenticated user's
// effective role is not in the allowed list.
//
// Client users get the synthetic role 'Client' so you can write:
//   requireRoles('Client')
// for client-only endpoints.
//
// Must be used AFTER authenticate middleware.

module.exports = function requireRoles(...roles) {
    return (req, res, next) => {
        if (!req.user) {
            return res.status(401).json({
                success: false,
                message: 'Authentication required.',
                data: null,
            });
        }

        const effectiveRole = req.user.userType === 'Client' ? 'Client' : req.user.role;

        if (!roles.includes(effectiveRole)) {
            return res.status(403).json({
                success: false,
                message: 'You do not have permission to perform this action.',
                data: null,
            });
        }

        next();
    };
};
