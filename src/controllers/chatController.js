const asyncHandler = require('../utils/asyncHandler');
const chatService = require('../services/chatService');

module.exports = {
  // ── Conversations ──

  listConversations: asyncHandler(async (req, res) => {
    const items = await chatService.listConversations(req.user._id, {
      type: req.query.type,
      search: req.query.search,
    });
    res.json({ items });
  }),

  getConversation: asyncHandler(async (req, res) => {
    const item = await chatService.getConversation(req.params.id, req.user._id);
    res.json({ item });
  }),

  createConversation: asyncHandler(async (req, res) => {
    const item = await chatService.createConversation(req.body, req.user._id);
    res.status(201).json({ item });
  }),

  updateConversation: asyncHandler(async (req, res) => {
    const item = await chatService.updateConversation(req.params.id, req.body, req.user._id);
    res.json({ item });
  }),

  archiveConversation: asyncHandler(async (req, res) => {
    const result = await chatService.archiveConversation(req.params.id, req.user._id);
    res.json(result);
  }),

  addParticipants: asyncHandler(async (req, res) => {
    const item = await chatService.addParticipants(req.params.id, req.body.userIds, req.user._id);
    res.json({ item });
  }),

  removeParticipant: asyncHandler(async (req, res) => {
    const item = await chatService.removeParticipant(req.params.id, req.params.userId, req.user._id);
    res.json({ item });
  }),

  markRead: asyncHandler(async (req, res) => {
    const result = await chatService.markRead(req.params.id, req.user._id);
    res.json(result);
  }),

  // ── Messages ──

  getMessages: asyncHandler(async (req, res) => {
    const result = await chatService.getMessages(req.params.id, req.user._id, {
      before: req.query.before,
      limit: req.query.limit,
    });
    res.json(result);
  }),

  sendMessage: asyncHandler(async (req, res) => {
    const item = await chatService.sendMessage(req.params.id, req.user._id, req.body);
    res.status(201).json({ item });
  }),

  editMessage: asyncHandler(async (req, res) => {
    const item = await chatService.editMessage(req.params.id, req.body.content, req.user._id);
    res.json({ item });
  }),

  deleteMessage: asyncHandler(async (req, res) => {
    const result = await chatService.deleteMessage(req.params.id, req.user._id);
    res.json(result);
  }),

  toggleReaction: asyncHandler(async (req, res) => {
    const result = await chatService.toggleReaction(req.params.id, req.body.emoji, req.user._id);
    res.json(result);
  }),

  // ── Files ──

  uploadFiles: asyncHandler(async (req, res) => {
    if (!req.files?.length) {
      return res.status(400).json({ message: 'No files provided' });
    }
    const attachments = await chatService.uploadFiles(req.params.id, req.files, req.user._id);
    res.status(201).json({ attachments });
  }),

  // ── Users & Presence ──

  getAvailableUsers: asyncHandler(async (req, res) => {
    const items = await chatService.getAvailableUsers();
    res.json({ items });
  }),

  getPresence: asyncHandler(async (req, res) => {
    const presence = await chatService.getPresence();
    res.json({ presence });
  }),

  // ── Unread ──

  getUnreadTotal: asyncHandler(async (req, res) => {
    const result = await chatService.getUnreadTotal(req.user._id);
    res.json(result);
  }),

  getUnreadPerConversation: asyncHandler(async (req, res) => {
    const result = await chatService.getUnreadPerConversation(req.user._id);
    res.json(result);
  }),

  // ── Conversation preferences ──

  togglePin: asyncHandler(async (req, res) => {
    const result = await chatService.toggleConversationPin(req.params.id, req.user._id);
    res.json(result);
  }),

  toggleFavourite: asyncHandler(async (req, res) => {
    const result = await chatService.toggleConversationFavourite(req.params.id, req.user._id);
    res.json(result);
  }),

  muteConversation: asyncHandler(async (req, res) => {
    const result = await chatService.muteConversation(req.params.id, req.user._id, req.body.duration);
    res.json(result);
  }),

  setLabel: asyncHandler(async (req, res) => {
    const result = await chatService.setLabel(req.params.id, req.user._id, req.body);
    res.json(result);
  }),

  removeLabel: asyncHandler(async (req, res) => {
    const result = await chatService.removeLabel(req.params.id, req.user._id, req.body.title);
    res.json(result);
  }),

  renameChannel: asyncHandler(async (req, res) => {
    const item = await chatService.renameChannel(req.params.id, req.body.name, req.user._id);
    res.json({ item });
  }),

  // ── Message pinning & forwarding ──

  toggleMessagePin: asyncHandler(async (req, res) => {
    const item = await chatService.toggleMessagePin(req.params.id, req.user._id);
    res.json({ item });
  }),

  getPinnedMessages: asyncHandler(async (req, res) => {
    const items = await chatService.getPinnedMessages(req.params.id, req.user._id);
    res.json({ items });
  }),

  forwardMessage: asyncHandler(async (req, res) => {
    const item = await chatService.forwardMessage(req.params.id, req.body.targetConversationId, req.user._id);
    res.status(201).json({ item });
  }),

  // ── Threads ──

  getThreadReplies: asyncHandler(async (req, res) => {
    const items = await chatService.getThreadReplies(req.params.id);
    res.json({ items });
  }),

  getThreadCounts: asyncHandler(async (req, res) => {
    const result = await chatService.getThreadCounts(req.params.id);
    res.json(result);
  }),

  // ── Files, Links, Mentions, Favourites ──

  getChannelFiles: asyncHandler(async (req, res) => {
    const items = await chatService.getChannelFiles(req.params.id, req.user._id);
    res.json({ items });
  }),

  getChannelLinks: asyncHandler(async (req, res) => {
    const items = await chatService.getChannelLinks(req.params.id, req.user._id);
    res.json({ items });
  }),

  getUserMentions: asyncHandler(async (req, res) => {
    const items = await chatService.getUserMentions(req.user._id);
    res.json({ items });
  }),

  getFavourites: asyncHandler(async (req, res) => {
    const items = await chatService.getFavourites(req.user._id);
    res.json({ items });
  }),
};
