const express = require('express');
const rbacController = require('../controllers/rbacController');
const { protect, authorize } = require('../middleware/auth');

const router = express.Router();

// All routes require authentication
router.use(protect);

// Get default permissions per role (admin only)
router.get('/defaults', authorize('Admin', 'CEOReportingManager'), rbacController.getDefaults);

// Get user permissions (self = any auth user, others = admin only)
router.get(
  '/users/:id/permissions',
  rbacController.getUserPermissions
);

// Lightweight poll endpoint (self only)
router.get(
  '/users/:id/permissions/poll',
  rbacController.pollPermissions
);

// Update user permissions (admin only)
router.patch(
  '/users/:id/permissions',
  authorize('Admin', 'CEOReportingManager'),
  rbacController.updateUserPermissions
);

module.exports = router;
