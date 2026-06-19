const Notification = require('../models/Notification');
const AppError = require('../utils/AppError');
const buildCrud = require('./commonCrud');

const notificationCrud = buildCrud(Notification, {
  populate: ['userId'],
});

/**
 * Create a single notification. Non-throwing — logs errors instead.
 */
const createNotification = async ({ userId, type, title, message, link, relatedId }) => {
  try {
    const notification = await Notification.create({
      userId,
      type: type || 'general',
      title,
      message,
      link,
      relatedId,
    });
    return notification.toObject();
  } catch (err) {
    console.error('[NotificationService] Failed to create:', err.message);
    return null;
  }
};

/**
 * Notify a single user. Safe wrapper — never throws.
 * @param {string} userId
 * @param {object} data - { type, title, message, link?, relatedId? }
 */
const notify = async (userId, data) => {
  if (!userId) return null;
  return createNotification({ userId, ...data });
};

/**
 * Notify multiple users with the same notification. Non-throwing.
 * Skips duplicates and the excludeId (typically the sender).
 * @param {string[]} userIds
 * @param {object} data - { type, title, message, link?, relatedId? }
 * @param {string} [excludeId] - userId to skip (e.g., sender)
 */
const notifyMany = async (userIds, data, excludeId) => {
  if (!userIds?.length) return [];
  const unique = [...new Set(userIds.map(String))].filter((id) => id !== String(excludeId));
  const results = await Promise.allSettled(
    unique.map((uid) => createNotification({ userId: uid, ...data }))
  );
  return results.filter((r) => r.status === 'fulfilled').map((r) => r.value);
};

/**
 * Notify all participants of a conversation except the sender. Non-throwing.
 * Respects mute settings.
 * @param {object} conversation - populated conversation with participants
 * @param {string} senderId - userId to exclude
 * @param {object} data - { type, title, message, link?, relatedId? }
 */
const notifyConversationParticipants = async (conversation, senderId, data) => {
  if (!conversation?.participants) return [];
  const eligibleIds = conversation.participants
    .filter((p) => {
      const pId = String(p.userId?._id || p.userId);
      if (pId === String(senderId)) return false;
      // Skip muted
      if (p.mutedUntil && new Date(p.mutedUntil) > new Date()) return false;
      return true;
    })
    .map((p) => String(p.userId?._id || p.userId));

  return notifyMany(eligibleIds, data);
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

const getUnreadCount = async (userId, typeFilter) => {
  const query = { userId, read: false };
  if (typeFilter) query.type = { $in: typeFilter };
  const count = await Notification.countDocuments(query);
  return { count };
};

module.exports = {
  notifications: notificationCrud,
  createNotification,
  notify,
  notifyMany,
  notifyConversationParticipants,
  markRead,
  markAllRead,
  getUnreadCount,
};
