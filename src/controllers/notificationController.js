const asyncHandler = require('../utils/asyncHandler');
const createCrudController = require('./crudController');
const service = require('../services/notificationService');

const notifications = createCrudController(service.notifications);

// Notification types each role should see
const ROLE_NOTIFICATION_TYPES = {
  InternalRTO: ['application_assigned', 'status_changed', 'feedback_received', 'document_reviewed'],
  Support: ['ticket_update', 'general'],
  Agent: ['application_assigned', 'status_changed', 'payment_received', 'general'],
};

module.exports = {
  ...notifications,

  // Override list to scope to current user + filter by role-appropriate types
  list: asyncHandler(async (req, res) => {
    const query = { ...req.query, userId: req.user._id };

    const allowedTypes = ROLE_NOTIFICATION_TYPES[req.user.role];
    if (allowedTypes) {
      query.type = { $in: allowedTypes };
    }

    const result = await service.notifications.list(query);
    res.status(200).json(result);
  }),

  createNotification: asyncHandler(async (req, res) => {
    const result = await service.createNotification(req.body);
    res.status(201).json({ item: result });
  }),

  markRead: asyncHandler(async (req, res) => {
    const result = await service.markRead(req.params.id);
    res.status(200).json({ item: result });
  }),

  markAllRead: asyncHandler(async (req, res) => {
    const result = await service.markAllRead(req.user._id);
    res.status(200).json(result);
  }),

  getUnreadCount: asyncHandler(async (req, res) => {
    const allowedTypes = ROLE_NOTIFICATION_TYPES[req.user.role];
    const result = await service.getUnreadCount(req.user._id, allowedTypes);
    res.status(200).json(result);
  }),
};
