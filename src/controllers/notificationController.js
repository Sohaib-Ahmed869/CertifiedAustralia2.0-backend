const asyncHandler = require('../utils/asyncHandler');
const createCrudController = require('./crudController');
const service = require('../services/notificationService');

const notifications = createCrudController(service.notifications);

module.exports = {
  ...notifications,

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
    const result = await service.getUnreadCount(req.user._id);
    res.status(200).json(result);
  }),
};
