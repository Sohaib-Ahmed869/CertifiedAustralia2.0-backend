const express = require('express');
const { protect, authorize } = require('../middleware/auth');
const controller = require('../controllers/chatController');
const upload = require('../middleware/upload');

const router = express.Router();

// All chat routes require auth + chat-eligible roles
router.use(protect);
router.use(authorize('Admin', 'CEOReportingManager', 'Agent'));

// ── Unread (before /:id to avoid param collision) ──
router.get('/unread', controller.getUnreadTotal);
router.get('/unread/per-conversation', controller.getUnreadPerConversation);

// ── Users & Presence ──
router.get('/users/available', controller.getAvailableUsers);
router.get('/presence', controller.getPresence);

// ── Conversations ──
router.route('/conversations')
  .get(controller.listConversations)
  .post(controller.createConversation);

router.route('/conversations/:id')
  .get(controller.getConversation)
  .patch(controller.updateConversation)
  .delete(controller.archiveConversation);

router.post('/conversations/:id/participants', controller.addParticipants);
router.delete('/conversations/:id/participants/:userId', controller.removeParticipant);
router.patch('/conversations/:id/read', controller.markRead);
router.patch('/conversations/:id/pin', controller.togglePin);
router.patch('/conversations/:id/favourite', controller.toggleFavourite);
router.patch('/conversations/:id/mute', controller.muteConversation);
router.patch('/conversations/:id/label', controller.setLabel);
router.delete('/conversations/:id/label', controller.removeLabel);
router.patch('/conversations/:id/rename', controller.renameChannel);
router.get('/conversations/:id/pinned', controller.getPinnedMessages);

// ── Messages ──
router.get('/conversations/:id/messages', controller.getMessages);
router.post('/conversations/:id/messages', controller.sendMessage);

// ── Files ──
router.post('/conversations/:id/upload', upload.array('files', 10), controller.uploadFiles);

// ── Message actions (separate from conversation /:id) ──
router.patch('/messages/:id', controller.editMessage);
router.delete('/messages/:id', controller.deleteMessage);
router.post('/messages/:id/reactions', controller.toggleReaction);
router.patch('/messages/:id/pin', controller.toggleMessagePin);
router.post('/messages/:id/forward', controller.forwardMessage);
router.get('/messages/:id/thread', controller.getThreadReplies);
router.get('/conversations/:id/thread-counts', controller.getThreadCounts);

module.exports = router;
