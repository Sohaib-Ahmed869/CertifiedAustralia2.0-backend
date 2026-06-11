const Notification = require('../models/Notification');
const AppError = require('../utils/AppError');
const buildCrud = require('./commonCrud');

const notificationCrud = buildCrud(Notification, {
  populate: ['userId'],
});

const createNotification = async ({ userId, type, title, message, link, relatedId }) => {
  const notification = await Notification.create({
    userId,
    type: type || 'general',
    title,
    message,
    link,
    relatedId,
  });
  return notification.toObject();
};

const markRead = async (notificationId) => {
  const notification = await Notification.findByIdAndUpdate(
    notificationId,
    { read: true },
    { new: true }
  );
  if (!notification) throw new AppError('Notification not found', 404);
  return notification.toObject();
};

const markAllRead = async (userId) => {
  await Notification.updateMany(
    { userId, read: false },
    { read: true }
  );
  return { message: 'All notifications marked as read' };
};

const getUnreadCount = async (userId) => {
  const count = await Notification.countDocuments({ userId, read: false });
  return { count };
};

module.exports = {
  notifications: notificationCrud,
  createNotification,
  markRead,
  markAllRead,
  getUnreadCount,
};
