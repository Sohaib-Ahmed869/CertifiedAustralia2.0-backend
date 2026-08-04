const User = require('../models/User');
const AppError = require('../utils/AppError');
const {
  ROLE_DEFAULTS,
  PERMISSION_KEYS,
  getEffectivePermissions,
  validatePermissionKeys,
} = require('../config/permissions');

const getDefaults = () => {
  return { roles: ROLE_DEFAULTS, permissionKeys: PERMISSION_KEYS };
};

const getUserPermissions = async (userId) => {
  const user = await User.findById(userId).select('role isSalesAgent permissions permissionsUpdatedAt permissionsUpdatedBy');
  if (!user) throw new AppError('User not found', 404);

  const effective = getEffectivePermissions(user);

  return {
    permissions: effective,
    role: user.role,
    customOverrides: user.permissions instanceof Map
      ? Object.fromEntries(user.permissions)
      : (user.permissions || {}),
    updatedAt: user.permissionsUpdatedAt,
    updatedBy: user.permissionsUpdatedBy,
  };
};

const updateUserPermissions = async (userId, permissions, updatedBy) => {
  const user = await User.findById(userId);
  if (!user) throw new AppError('User not found', 404);

  // Validate permission keys
  const invalid = validatePermissionKeys(permissions);
  if (invalid.length > 0) {
    throw new AppError(`Invalid permission keys: ${invalid.join(', ')}`, 400);
  }

  // Set per-user overrides
  if (!user.permissions) {
    user.permissions = new Map();
  }

  Object.entries(permissions).forEach(([key, value]) => {
    if (value === null) {
      // null means "reset to default" — remove the override
      user.permissions.delete(key);
    } else {
      user.permissions.set(key, Boolean(value));
    }
  });

  user.permissionsUpdatedAt = new Date();
  user.permissionsUpdatedBy = updatedBy;
  user.markModified('permissions');
  await user.save({ validateBeforeSave: false });

  const effective = getEffectivePermissions(user);

  // Notify user of permission changes (non-fatal)
  try {
    const { createNotification } = require('./notificationService');
    const granted = Object.entries(permissions).filter(([, v]) => v === true).map(([k]) => k);
    const revoked = Object.entries(permissions).filter(([, v]) => v === false).map(([k]) => k);
    const parts = [];
    if (granted.length) parts.push(`Granted: ${granted.length} permission${granted.length > 1 ? 's' : ''}`);
    if (revoked.length) parts.push(`Revoked: ${revoked.length} permission${revoked.length > 1 ? 's' : ''}`);
    if (parts.length) {
      await createNotification({
        userId,
        type: 'permission_changed',
        title: 'Permissions Updated',
        message: `Your access permissions have been updated. ${parts.join('. ')}.`,
      });
    }
  } catch (err) {
    console.error('[RBAC] Failed to create notification:', err.message);
  }

  // Push permission update via socket (avoids HTTP polling)
  try {
    const { pushPermissionUpdate } = require('../socket');
    pushPermissionUpdate(userId);
  } catch { /* socket not initialized */ }

  return {
    permissions: effective,
    role: user.role,
    customOverrides: Object.fromEntries(user.permissions),
    updatedAt: user.permissionsUpdatedAt,
    updatedBy: user.permissionsUpdatedBy,
  };
};

const pollPermissions = async (userId) => {
  const user = await User.findById(userId)
    .select('permissionsUpdatedAt')
    .lean();

  if (!user) throw new AppError('User not found', 404);

  return { permissionsUpdatedAt: user.permissionsUpdatedAt || null };
};

module.exports = {
  getDefaults,
  getUserPermissions,
  updateUserPermissions,
  pollPermissions,
};
