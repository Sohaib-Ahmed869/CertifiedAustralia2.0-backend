const AppError = require('../utils/AppError');
const Conversation = require('../models/Conversation');
const Message = require('../models/Message');
const ChatPresence = require('../models/ChatPresence');
const User = require('../models/User');

const CHAT_ROLES = ['Admin', 'CEOReportingManager', 'Agent'];

// ── Helpers ──

const buildDmHash = (id1, id2) => [id1, id2].map(String).sort().join('_');

const populateParticipants = (query) =>
  query.populate('participants.userId', 'firstName lastName email role');

const toLastMessage = (msg, sender) => ({
  content: msg.type === 'file' ? '📎 File' : (msg.content || '').slice(0, 100),
  senderId: msg.senderId,
  senderName: sender ? `${sender.firstName || ''} ${sender.lastName || ''}`.trim() : '',
  sentAt: msg.createdAt,
  type: msg.type,
});

// ── Conversations ──

const listConversations = async (userId, { type, search } = {}) => {
  const filter = { 'participants.userId': userId, archived: { $ne: true } };
  if (type) filter.type = type;

  let query = Conversation.find(filter).sort({ 'lastMessage.sentAt': -1, updatedAt: -1 });
  query = populateParticipants(query);
  const conversations = await query.lean();

  if (search) {
    const term = search.toLowerCase();
    return conversations.filter((c) => {
      if (c.name && c.name.toLowerCase().includes(term)) return true;
      return c.participants.some((p) => {
        const u = p.userId;
        if (!u) return false;
        const name = `${u.firstName || ''} ${u.lastName || ''}`.toLowerCase();
        return name.includes(term);
      });
    });
  }

  return conversations;
};

const getConversation = async (conversationId, userId) => {
  const conv = await populateParticipants(Conversation.findById(conversationId)).lean();
  if (!conv) throw new AppError('Conversation not found', 404);
  if (!conv.participants.some((p) => String(p.userId?._id || p.userId) === String(userId))) {
    throw new AppError('Not a member of this conversation', 403);
  }
  return conv;
};

const createConversation = async (data, creatorId) => {
  const { type, name, description, participantIds = [] } = data;

  if (type === 'dm') {
    if (participantIds.length !== 1) throw new AppError('DM requires exactly one other participant', 400);
    const otherId = participantIds[0];
    const hash = buildDmHash(creatorId, otherId);

    // Return existing DM if one exists
    const existing = await populateParticipants(Conversation.findOne({ dmParticipantHash: hash })).lean();
    if (existing) return existing;

    const conv = await Conversation.create({
      type: 'dm',
      dmParticipantHash: hash,
      participants: [
        { userId: creatorId, role: 'member' },
        { userId: otherId, role: 'member' },
      ],
    });
    return populateParticipants(Conversation.findById(conv._id)).lean();
  }

  // Channel
  if (!name?.trim()) throw new AppError('Channel name is required', 400);
  const allIds = [creatorId, ...participantIds.filter((id) => String(id) !== String(creatorId))];
  const conv = await Conversation.create({
    type: 'channel',
    name: name.trim(),
    description: description?.trim() || '',
    createdBy: creatorId,
    participants: allIds.map((id) => ({
      userId: id,
      role: String(id) === String(creatorId) ? 'owner' : 'member',
    })),
  });
  return populateParticipants(Conversation.findById(conv._id)).lean();
};

const updateConversation = async (conversationId, data, userId) => {
  const conv = await Conversation.findById(conversationId);
  if (!conv) throw new AppError('Conversation not found', 404);
  if (conv.type !== 'channel') throw new AppError('Only channels can be updated', 400);

  const participant = conv.participants.find((p) => String(p.userId) === String(userId));
  if (!participant || !['owner', 'admin'].includes(participant.role)) {
    throw new AppError('Only channel owners/admins can update', 403);
  }

  if (data.name !== undefined) conv.name = data.name.trim();
  if (data.description !== undefined) conv.description = data.description.trim();
  await conv.save();
  return populateParticipants(Conversation.findById(conv._id)).lean();
};

const archiveConversation = async (conversationId, userId) => {
  const conv = await Conversation.findById(conversationId);
  if (!conv) throw new AppError('Conversation not found', 404);
  if (conv.type !== 'channel') throw new AppError('Only channels can be archived', 400);

  const participant = conv.participants.find((p) => String(p.userId) === String(userId));
  if (!participant || participant.role !== 'owner') {
    throw new AppError('Only the channel owner can archive', 403);
  }

  conv.archived = true;
  await conv.save();
  return { message: 'Channel archived' };
};

const addParticipants = async (conversationId, userIds, userId) => {
  const conv = await Conversation.findById(conversationId);
  if (!conv) throw new AppError('Conversation not found', 404);
  if (conv.type !== 'channel') throw new AppError('Cannot add members to a DM', 400);

  const existingIds = new Set(conv.participants.map((p) => String(p.userId)));
  const newIds = userIds.filter((id) => !existingIds.has(String(id)));
  if (newIds.length === 0) return populateParticipants(Conversation.findById(conv._id)).lean();

  newIds.forEach((id) => conv.participants.push({ userId: id, role: 'member' }));
  await conv.save();
  return populateParticipants(Conversation.findById(conv._id)).lean();
};

const removeParticipant = async (conversationId, targetUserId, requesterId) => {
  const conv = await Conversation.findById(conversationId);
  if (!conv) throw new AppError('Conversation not found', 404);
  if (conv.type !== 'channel') throw new AppError('Cannot remove members from a DM', 400);

  // Allow self-leave or owner/admin removal
  const isSelf = String(targetUserId) === String(requesterId);
  if (!isSelf) {
    const requester = conv.participants.find((p) => String(p.userId) === String(requesterId));
    if (!requester || !['owner', 'admin'].includes(requester.role)) {
      throw new AppError('Not authorized to remove members', 403);
    }
  }

  conv.participants = conv.participants.filter((p) => String(p.userId) !== String(targetUserId));
  await conv.save();
  return populateParticipants(Conversation.findById(conv._id)).lean();
};

const markRead = async (conversationId, userId) => {
  await Conversation.updateOne(
    { _id: conversationId, 'participants.userId': userId },
    { $set: { 'participants.$.lastReadAt': new Date() } }
  );
  return { success: true };
};

// ── Messages ──

const getMessages = async (conversationId, userId, { before, limit = 50 } = {}) => {
  // Verify membership
  const conv = await Conversation.findById(conversationId).lean();
  if (!conv) throw new AppError('Conversation not found', 404);
  if (!conv.participants.some((p) => String(p.userId) === String(userId))) {
    throw new AppError('Not a member', 403);
  }

  // Exclude thread replies — only show top-level messages in main chat
  const filter = { conversationId, $or: [{ replyTo: null }, { replyTo: { $exists: false } }] };
  if (before) filter.createdAt = { $lt: new Date(before) };

  const messages = await Message.find(filter)
    .sort({ createdAt: -1 })
    .limit(Number(limit) + 1)
    .populate('senderId', 'firstName lastName email role')
    .populate('replyTo', 'content senderId')
    .lean();

  const hasMore = messages.length > limit;
  if (hasMore) messages.pop();

  // Mask deleted messages
  messages.forEach((m) => {
    if (m.deleted) {
      m.content = 'This message was deleted';
      m.attachments = [];
    }
  });

  return { messages: messages.reverse(), hasMore };
};

const sendMessage = async (conversationId, senderId, data) => {
  const conv = await Conversation.findById(conversationId);
  if (!conv) throw new AppError('Conversation not found', 404);
  if (!conv.participants.some((p) => String(p.userId) === String(senderId))) {
    throw new AppError('Not a member', 403);
  }

  const message = await Message.create({
    conversationId,
    senderId,
    type: data.type || 'text',
    content: data.content || '',
    attachments: data.attachments || [],
    mentions: data.mentions || [],
    specialMentions: data.specialMentions || {},
    replyTo: data.replyTo || undefined,
  });

  const sender = await User.findById(senderId).select('firstName lastName').lean();

  // Update conversation's lastMessage
  conv.lastMessage = toLastMessage(message, sender);
  // Update sender's lastReadAt
  const senderParticipant = conv.participants.find((p) => String(p.userId) === String(senderId));
  if (senderParticipant) senderParticipant.lastReadAt = new Date();
  await conv.save();

  return Message.findById(message._id)
    .populate('senderId', 'firstName lastName email role')
    .populate('replyTo', 'content senderId')
    .lean();
};

const editMessage = async (messageId, content, userId) => {
  const message = await Message.findById(messageId);
  if (!message) throw new AppError('Message not found', 404);
  if (String(message.senderId) !== String(userId)) throw new AppError('Can only edit your own messages', 403);

  message.content = content;
  message.editedAt = new Date();
  await message.save();
  return Message.findById(messageId)
    .populate('senderId', 'firstName lastName email role')
    .lean();
};

const deleteMessage = async (messageId, userId) => {
  const message = await Message.findById(messageId);
  if (!message) throw new AppError('Message not found', 404);

  // Allow sender or admins
  if (String(message.senderId) !== String(userId)) {
    const user = await User.findById(userId).select('role').lean();
    if (user.role !== 'Admin' && user.role !== 'CEOReportingManager') {
      throw new AppError('Not authorized to delete', 403);
    }
  }

  message.deleted = true;
  message.deletedAt = new Date();
  message.deletedBy = userId;
  await message.save();
  return { messageId, conversationId: message.conversationId };
};

const toggleReaction = async (messageId, emoji, userId) => {
  const message = await Message.findById(messageId);
  if (!message) throw new AppError('Message not found', 404);

  const existing = message.reactions.find((r) => r.emoji === emoji);
  if (existing) {
    const userIdx = existing.users.findIndex((u) => String(u) === String(userId));
    if (userIdx >= 0) {
      existing.users.splice(userIdx, 1);
      if (existing.users.length === 0) {
        message.reactions = message.reactions.filter((r) => r.emoji !== emoji);
      }
    } else {
      existing.users.push(userId);
    }
  } else {
    message.reactions.push({ emoji, users: [userId] });
  }

  await message.save();
  return { messageId, reactions: message.reactions };
};

// ── Files ──

const uploadFiles = async (conversationId, files, userId) => {
  const conv = await Conversation.findById(conversationId).lean();
  if (!conv) throw new AppError('Conversation not found', 404);
  if (!conv.participants.some((p) => String(p.userId) === String(userId))) {
    throw new AppError('Not a member', 403);
  }

  const driveService = require('./googleDriveService');
  const fs = require('fs');
  const crypto = require('crypto');

  const attachments = [];
  for (const file of files) {
    const driveName = `Chat_${crypto.randomUUID()}_${file.originalname}`;
    const driveFile = await driveService.uploadFileFromDisk({
      filePath: file.path,
      fileName: driveName,
      mimeType: file.mimetype,
      folderId: undefined, // Uses default folder
    });
    fs.unlink(file.path, () => {});
    attachments.push({
      fileName: file.originalname,
      fileUrl: driveFile.webViewLink,
      fileType: file.mimetype,
      fileSize: file.size,
      driveFileId: driveFile.id,
    });
  }
  return attachments;
};

// ── Users & Presence ──

const getAvailableUsers = async () => {
  return User.find({ role: { $in: CHAT_ROLES }, status: 'active' })
    .select('firstName lastName email role')
    .sort({ firstName: 1 })
    .lean();
};

const getPresence = async () => {
  const records = await ChatPresence.find({}).lean();
  const map = {};
  records.forEach((r) => { map[String(r.userId)] = r.status; });
  return map;
};

// ── Unread ──

const getUnreadTotal = async (userId) => {
  const convos = await Conversation.find({ 'participants.userId': userId, archived: { $ne: true } })
    .select('participants')
    .lean();

  let total = 0;
  for (const c of convos) {
    const p = c.participants.find((pp) => String(pp.userId) === String(userId));
    if (!p) continue;
    const count = await Message.countDocuments({
      conversationId: c._id,
      createdAt: { $gt: p.lastReadAt },
      senderId: { $ne: userId },
    });
    total += count;
  }
  return { count: total };
};

const getUnreadPerConversation = async (userId) => {
  const convos = await Conversation.find({ 'participants.userId': userId, archived: { $ne: true } })
    .select('participants')
    .lean();

  const result = {};
  for (const c of convos) {
    const p = c.participants.find((pp) => String(pp.userId) === String(userId));
    if (!p) continue;
    const count = await Message.countDocuments({
      conversationId: c._id,
      createdAt: { $gt: p.lastReadAt },
      senderId: { $ne: userId },
    });
    if (count > 0) result[String(c._id)] = count;
  }
  return result;
};

// ── Per-user conversation preferences ──

const getParticipant = (conv, userId) => {
  const p = conv.participants.find((pp) => String(pp.userId) === String(userId));
  if (!p) throw new AppError('Not a member of this conversation', 403);
  return p;
};

const toggleConversationPin = async (conversationId, userId) => {
  const conv = await Conversation.findById(conversationId);
  if (!conv) throw new AppError('Conversation not found', 404);
  const p = getParticipant(conv, userId);
  p.pinned = !p.pinned;
  await conv.save();
  return { pinned: p.pinned };
};

const toggleConversationFavourite = async (conversationId, userId) => {
  const conv = await Conversation.findById(conversationId);
  if (!conv) throw new AppError('Conversation not found', 404);
  const p = getParticipant(conv, userId);
  p.favourited = !p.favourited;
  await conv.save();
  return { favourited: p.favourited };
};

const MUTE_DURATIONS = { '15m': 15, '1h': 60, '8h': 480, '24h': 1440, forever: null };

const muteConversation = async (conversationId, userId, duration) => {
  const conv = await Conversation.findById(conversationId);
  if (!conv) throw new AppError('Conversation not found', 404);
  const p = getParticipant(conv, userId);

  if (!duration || duration === 'unmute') {
    p.mutedUntil = null;
  } else if (duration === 'forever') {
    p.mutedUntil = new Date('2099-12-31');
  } else {
    const mins = MUTE_DURATIONS[duration];
    if (!mins) throw new AppError('Invalid mute duration', 400);
    p.mutedUntil = new Date(Date.now() + mins * 60 * 1000);
  }
  await conv.save();
  return { mutedUntil: p.mutedUntil };
};

const setLabel = async (conversationId, userId, label) => {
  const conv = await Conversation.findById(conversationId);
  if (!conv) throw new AppError('Conversation not found', 404);
  const p = getParticipant(conv, userId);
  if (!p.labels) p.labels = [];
  const existing = p.labels.find((l) => l.title === label.title);
  if (existing) {
    existing.color = label.color || existing.color;
  } else {
    p.labels.push({ title: label.title, color: label.color || '#6366f1' });
  }
  await conv.save();
  return { labels: p.labels };
};

const removeLabel = async (conversationId, userId, labelTitle) => {
  const conv = await Conversation.findById(conversationId);
  if (!conv) throw new AppError('Conversation not found', 404);
  const p = getParticipant(conv, userId);
  p.labels = (p.labels || []).filter((l) => l.title !== labelTitle);
  await conv.save();
  return { labels: p.labels };
};

const renameChannel = async (conversationId, name, userId) => {
  const conv = await Conversation.findById(conversationId);
  if (!conv) throw new AppError('Conversation not found', 404);
  if (conv.type !== 'channel') throw new AppError('Only channels can be renamed', 400);
  if (String(conv.createdBy) !== String(userId)) {
    throw new AppError('Only the channel creator can rename', 403);
  }
  conv.name = name.trim();
  await conv.save();
  return populateParticipants(Conversation.findById(conv._id)).lean();
};

// ── Message pinning & forwarding ──

const toggleMessagePin = async (messageId, userId) => {
  const message = await Message.findById(messageId);
  if (!message) throw new AppError('Message not found', 404);
  message.pinned = !message.pinned;
  message.pinnedAt = message.pinned ? new Date() : null;
  message.pinnedBy = message.pinned ? userId : null;
  await message.save();
  return Message.findById(messageId)
    .populate('senderId', 'firstName lastName email role')
    .populate('pinnedBy', 'firstName lastName')
    .lean();
};

const getPinnedMessages = async (conversationId, userId) => {
  const conv = await Conversation.findById(conversationId).lean();
  if (!conv) throw new AppError('Conversation not found', 404);
  if (!conv.participants.some((p) => String(p.userId) === String(userId))) {
    throw new AppError('Not a member', 403);
  }
  return Message.find({ conversationId, pinned: true, deleted: { $ne: true } })
    .sort({ pinnedAt: -1 })
    .populate('senderId', 'firstName lastName email role')
    .populate('pinnedBy', 'firstName lastName')
    .lean();
};

const forwardMessage = async (messageId, targetConversationId, userId) => {
  const original = await Message.findById(messageId).lean();
  if (!original) throw new AppError('Original message not found', 404);

  const targetConv = await Conversation.findById(targetConversationId);
  if (!targetConv) throw new AppError('Target conversation not found', 404);
  if (!targetConv.participants.some((p) => String(p.userId) === String(userId))) {
    throw new AppError('Not a member of the target conversation', 403);
  }

  const forwarded = await Message.create({
    conversationId: targetConversationId,
    senderId: userId,
    type: original.type,
    content: original.content,
    attachments: original.attachments,
    forwardedFrom: original._id,
    forwardedBy: userId,
  });

  const sender = await User.findById(userId).select('firstName lastName').lean();
  targetConv.lastMessage = toLastMessage(forwarded, sender);
  const senderP = targetConv.participants.find((p) => String(p.userId) === String(userId));
  if (senderP) senderP.lastReadAt = new Date();
  await targetConv.save();

  return Message.findById(forwarded._id)
    .populate('senderId', 'firstName lastName email role')
    .populate('forwardedFrom', 'content senderId')
    .lean();
};

const getThreadReplies = async (messageId) => {
  return Message.find({ replyTo: messageId, deleted: { $ne: true } })
    .sort({ createdAt: 1 })
    .populate('senderId', 'firstName lastName email role')
    .lean();
};

const getThreadCounts = async (conversationId) => {
  const counts = await Message.aggregate([
    { $match: { conversationId: require('mongoose').Types.ObjectId.createFromHexString(conversationId), replyTo: { $ne: null }, deleted: { $ne: true } } },
    { $group: { _id: '$replyTo', count: { $sum: 1 }, lastReplyAt: { $max: '$createdAt' } } },
  ]);
  const map = {};
  counts.forEach((c) => { map[String(c._id)] = { count: c.count, lastReplyAt: c.lastReplyAt }; });
  return map;
};

// ── Channel files & links ──

const getChannelFiles = async (conversationId, userId) => {
  const conv = await Conversation.findById(conversationId).lean();
  if (!conv) throw new AppError('Conversation not found', 404);
  if (!conv.participants.some((p) => String(p.userId) === String(userId))) {
    throw new AppError('Not a member', 403);
  }

  const messages = await Message.find({
    conversationId,
    'attachments.0': { $exists: true },
    deleted: { $ne: true },
  })
    .populate('senderId', 'firstName lastName')
    .select('attachments senderId createdAt')
    .sort({ createdAt: -1 })
    .lean();

  const files = [];
  for (const msg of messages) {
    for (const att of msg.attachments) {
      files.push({
        ...att,
        uploadedBy: msg.senderId ? `${msg.senderId.firstName || ''} ${msg.senderId.lastName || ''}`.trim() : '',
        uploadedAt: msg.createdAt,
        messageId: msg._id,
      });
    }
  }
  return files;
};

const getChannelLinks = async (conversationId, userId) => {
  const conv = await Conversation.findById(conversationId).lean();
  if (!conv) throw new AppError('Conversation not found', 404);
  if (!conv.participants.some((p) => String(p.userId) === String(userId))) {
    throw new AppError('Not a member', 403);
  }

  const urlRegex = /https?:\/\/[^\s<>"{}|\\^`[\]]+/g;
  const messages = await Message.find({
    conversationId,
    content: { $regex: 'https?://' },
    deleted: { $ne: true },
  })
    .populate('senderId', 'firstName lastName')
    .select('content senderId createdAt')
    .sort({ createdAt: -1 })
    .lean();

  const links = [];
  for (const msg of messages) {
    const matches = msg.content.match(urlRegex) || [];
    for (const url of matches) {
      links.push({
        url,
        sharedBy: msg.senderId ? `${msg.senderId.firstName || ''} ${msg.senderId.lastName || ''}`.trim() : '',
        sharedAt: msg.createdAt,
        messageId: msg._id,
      });
    }
  }
  return links;
};

// ── Mentions for current user ──

const getUserMentions = async (userId) => {
  return Message.find({
    mentions: userId,
    senderId: { $ne: userId },
    deleted: { $ne: true },
  })
    .populate('senderId', 'firstName lastName email')
    .populate('conversationId', 'type name')
    .sort({ createdAt: -1 })
    .limit(50)
    .lean();
};

// ── Favourited conversations ──

const getFavourites = async (userId) => {
  const convos = await Conversation.find({
    'participants.userId': userId,
    'participants.favourited': true,
    archived: { $ne: true },
  })
    .populate('participants.userId', 'firstName lastName email role')
    .sort({ 'lastMessage.sentAt': -1 })
    .lean();

  // Filter to only return convos where THIS user's participant entry is favourited
  return convos.filter((c) =>
    c.participants.some((p) => String(p.userId?._id || p.userId) === String(userId) && p.favourited)
  );
};

const isMuted = async (conversationId, userId) => {
  const conv = await Conversation.findById(conversationId).select('participants').lean();
  if (!conv) return false;
  const p = conv.participants.find((pp) => String(pp.userId) === String(userId));
  if (!p || !p.mutedUntil) return false;
  return new Date(p.mutedUntil) > new Date();
};

module.exports = {
  listConversations,
  getConversation,
  createConversation,
  updateConversation,
  archiveConversation,
  addParticipants,
  removeParticipant,
  markRead,
  getMessages,
  sendMessage,
  editMessage,
  deleteMessage,
  toggleReaction,
  uploadFiles,
  getAvailableUsers,
  getPresence,
  getUnreadTotal,
  getUnreadPerConversation,
  toggleConversationPin,
  toggleConversationFavourite,
  muteConversation,
  setLabel,
  removeLabel,
  renameChannel,
  toggleMessagePin,
  getPinnedMessages,
  forwardMessage,
  getThreadReplies,
  getThreadCounts,
  getChannelFiles,
  getChannelLinks,
  getUserMentions,
  getFavourites,
  isMuted,
};
