const AppError = require('../utils/AppError');
const { getEffectivePermissions } = require('../config/permissions');

/**
 * Middleware factory that checks if the user has the required permission(s).
 * Usage: requirePermission('feature_assign_agent')
 *        requirePermission('feature_manage_payments', 'feature_issue_refund')
 */
const requirePermission = (...requiredPermissions) => (req, res, next) => {
  if (!req.user) {
    throw new AppError('Not authenticated', 401);
  }

  const effective = getEffectivePermissions(req.user);

  const denied = requiredPermissions.filter((perm) => !effective[perm]);

  if (denied.length > 0) {
    throw new AppError('Insufficient permissions', 403);
  }

  next();
};

module.exports = requirePermission;
