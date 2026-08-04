const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const User = require('./models/User');
const ChatPresence = require('./models/ChatPresence');
const chatService = require('./services/chatService');

// All roles can connect to sockets for notifications/permissions.
// Chat features are limited to these roles:
const CHAT_ROLES = ['Admin', 'CEOReportingManager', 'Agent'];
const ALL_ROLES = ['Admin', 'CEOReportingManager', 'Agent', 'Student', 'InternalRTO', 'Support', 'Marketing'];
const TYPING_TIMEOUT = 5000;

let io;

const setupSocket = (httpServer) => {
  io = new Server(httpServer, {
    cors: {
      origin: process.env.FRONTEND_URL || 'http://localhost:5173',
      methods: ['GET', 'POST'],
      credentials: true,
    },
    path: '/socket.io',
  });

  // ── Auth middleware ──
  io.use(async (socket, next) => {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error('Authentication required'));
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      const user = await User.findById(decoded.id).select('-password').lean();
      if (!user || user.status !== 'active') return next(new Error('Unauthorized'));
      if (!ALL_ROLES.includes(user.role)) return next(new Error('Socket not available for this role'));
      socket.user = user;
      next();
    } catch {
      next(new Error('Invalid token'));
    }
  });

  // ── Connection handler ──
  io.on('connection', async (socket) => {
    const userId = String(socket.user._id);
    const userName = `${socket.user.firstName || ''} ${socket.user.lastName || ''}`.trim();

    console.log(`[Socket] ${userName} connected (${socket.id})`);

    // Mark online
    await ChatPresence.findOneAndUpdate(
      { userId },
      { status: 'online', lastSeenAt: new Date(), socketId: socket.id },
      { upsert: true }
    );

    // Join personal room for targeted events
    socket.join(`user:${userId}`);

    // Broadcast presence
    io.emit('presence:update', { userId, status: 'online' });

    // Typing timeout map
    const typingTimers = new Map();

    // ── Join / Leave conversation rooms ──
    socket.on('join:conversation', ({ conversationId }) => {
      socket.join(`conv:${conversationId}`);
    });

    socket.on('leave:conversation', ({ conversationId }) => {
      socket.leave(`conv:${conversationId}`);
    });

    // ── Messaging ──
    socket.on('message:send', async (data) => {
      try {
        const message = await chatService.sendMessage(data.conversationId, userId, {
          content: data.content,
          type: data.type || 'text',
          attachments: data.attachments || [],
          mentions: data.mentions || [],
          specialMentions: data.specialMentions || {},
          replyTo: data.replyTo,
        });

        io.to(`conv:${data.conversationId}`).emit('message:new', {
          message,
          conversationId: data.conversationId,
        });

        // Push unread updates + notifications
        const conv = await require('./models/Conversation').findById(data.conversationId).lean();
        if (conv) {
          const { notifyConversationParticipants, notifyMany } = require('./services/notificationService');
          const contentPreview = (data.content || '').replace(/<[^>]*>/g, '').slice(0, 80);
          const isDm = conv.type === 'dm';

          // Push unread socket events
          for (const p of conv.participants) {
            const pId = String(p.userId);
            if (pId === userId) continue;
            const muted = p.mutedUntil && new Date(p.mutedUntil) > new Date();
            if (muted) continue;
            const unread = await chatService.getUnreadTotal(pId);
            io.to(`user:${pId}`).emit('unread:update', {
              conversationId: data.conversationId,
              totalUnread: unread.count,
            });
          }

          // Notify all participants (respects mute)
          await notifyConversationParticipants(conv, userId, {
            type: 'chat_message',
            title: isDm ? userName : `#${conv.name || 'Channel'}`,
            message: contentPreview || '📎 Sent a file',
            link: `/admin/chat?conversation=${data.conversationId}`,
            relatedId: message._id,
          });

          // Mention notifications (@all, @here, individual)
          const mentionedIds = [];
          if (data.specialMentions?.all) {
            conv.participants.forEach((p) => mentionedIds.push(String(p.userId)));
          }
          if (data.specialMentions?.here) {
            const onlinePresences = await ChatPresence.find({ status: 'online' }).lean();
            const onlineIds = new Set(onlinePresences.map((pr) => String(pr.userId)));
            conv.participants.forEach((p) => {
              if (onlineIds.has(String(p.userId))) mentionedIds.push(String(p.userId));
            });
          }
          if (data.mentions?.length) {
            data.mentions.forEach((mId) => mentionedIds.push(String(mId)));
          }
          if (mentionedIds.length > 0) {
            await notifyMany(mentionedIds, {
              type: 'chat_mention',
              title: `${userName} mentioned you`,
              message: contentPreview,
              link: `/admin/chat?conversation=${data.conversationId}&message=${message._id}`,
              relatedId: message._id,
            }, userId);
          }
        }
      } catch (err) {
        socket.emit('error', { message: err.message || 'Failed to send message' });
      }
    });

    socket.on('message:edit', async ({ messageId, content }) => {
      try {
        const message = await chatService.editMessage(messageId, content, userId);
        io.to(`conv:${message.conversationId}`).emit('message:updated', { message });
      } catch (err) {
        socket.emit('error', { message: err.message });
      }
    });

    socket.on('message:delete', async ({ messageId }) => {
      try {
        const result = await chatService.deleteMessage(messageId, userId);
        io.to(`conv:${result.conversationId}`).emit('message:deleted', result);
      } catch (err) {
        socket.emit('error', { message: err.message });
      }
    });

    socket.on('message:reaction', async ({ messageId, emoji }) => {
      try {
        const result = await chatService.toggleReaction(messageId, emoji, userId);
        // Need the conversationId to broadcast
        const msg = await require('./models/Message').findById(messageId).select('conversationId').lean();
        if (msg) {
          io.to(`conv:${msg.conversationId}`).emit('message:reaction:updated', {
            messageId: result.messageId,
            reactions: result.reactions,
          });
        }
      } catch (err) {
        socket.emit('error', { message: err.message });
      }
    });

    // ── Typing indicators ──
    socket.on('typing:start', ({ conversationId }) => {
      socket.to(`conv:${conversationId}`).emit('typing:update', {
        conversationId,
        userId,
        userName,
        isTyping: true,
      });

      // Auto-clear after timeout
      if (typingTimers.has(conversationId)) clearTimeout(typingTimers.get(conversationId));
      typingTimers.set(conversationId, setTimeout(() => {
        socket.to(`conv:${conversationId}`).emit('typing:update', {
          conversationId,
          userId,
          userName,
          isTyping: false,
        });
        typingTimers.delete(conversationId);
      }, TYPING_TIMEOUT));
    });

    socket.on('typing:stop', ({ conversationId }) => {
      if (typingTimers.has(conversationId)) {
        clearTimeout(typingTimers.get(conversationId));
        typingTimers.delete(conversationId);
      }
      socket.to(`conv:${conversationId}`).emit('typing:update', {
        conversationId,
        userId,
        userName,
        isTyping: false,
      });
    });

    // ── Read receipts ──
    socket.on('conversation:read', async ({ conversationId }) => {
      try {
        await chatService.markRead(conversationId, userId);
      } catch { /* ignore */ }
    });

    // ── Disconnect ──
    socket.on('disconnect', async () => {
      console.log(`[Socket] ${userName} disconnected`);

      // Clear typing timers
      for (const timer of typingTimers.values()) clearTimeout(timer);
      typingTimers.clear();

      // Mark offline
      await ChatPresence.findOneAndUpdate(
        { userId },
        { status: 'offline', lastSeenAt: new Date(), socketId: null }
      );

      io.emit('presence:update', { userId, status: 'offline' });
    });
  });

  return io;
};

const getIO = () => {
  if (!io) throw new Error('Socket.io not initialized');
  return io;
};

/**
 * Push a notification to a user via socket (avoids HTTP polling).
 */
const pushNotification = (userId, notification) => {
  if (!io) return;
  io.to(`user:${String(userId)}`).emit('notification:new', notification);
};

/**
 * Push permission update signal to a user via socket.
 */
const pushPermissionUpdate = (userId) => {
  if (!io) return;
  io.to(`user:${String(userId)}`).emit('permissions:updated');
};

/**
 * Campaign send progress — emitted on each stats change during a send and on
 * every applied open/bounce. Staff dashboards filter by campaignId.
 */
const emitCampaignProgress = (campaignId, stats, status) => {
  if (!io) return;
  io.emit('campaign:progress', { campaignId: String(campaignId), stats, status });
};

/** Campaign reached a terminal state (sent / partially_failed / failed / paused). */
const emitCampaignCompleted = (campaignId, status, stats) => {
  if (!io) return;
  io.emit('campaign:completed', { campaignId: String(campaignId), status, stats });
};

/**
 * Email-sequence (drip) progress — emitted on each send/open/bounce and on
 * lifecycle changes. Staff dashboards filter by sequenceId.
 */
const emitSequenceProgress = (sequenceId, stats, status) => {
  if (!io) return;
  io.emit('sequence:progress', { sequenceId: String(sequenceId), stats, status });
};

/**
 * Call burst updates — pushed to the initiating agent's personal room as the
 * burst progresses (ringing → connected → ended). `type` distinguishes the
 * lifecycle stage; `burst` is the sanitised burst payload.
 */
const emitBurstUpdate = (agentId, type, burst) => {
  if (!io) return;
  io.to(`user:${String(agentId)}`).emit('burst:update', { type, burst });
};

/**
 * Inbound call ringing — pushed to the assigned user's personal room so the
 * global incoming-call modal can show rich caller context (name, application)
 * that the raw Twilio Client "incoming" event doesn't carry. `payload` is the
 * sanitised CallRecord-ish shape { callSid, from, contactName, displayApplicationId, ... }.
 */
const emitIncomingCall = (userId, payload) => {
  if (!io) return;
  io.to(`user:${String(userId)}`).emit('call:incoming', payload);
};

/** Inbound call resolved (answered elsewhere / missed / voicemail) — tells the
 *  assignee's other tabs to dismiss the ringing modal. */
const emitIncomingResolved = (userId, payload) => {
  if (!io) return;
  io.to(`user:${String(userId)}`).emit('call:incoming-resolved', payload);
};

/** Broadcast that the CDR changed so any open Call Tracking page refetches. */
const emitCallRecordsUpdated = () => {
  if (!io) return;
  io.emit('call:records-updated');
};

module.exports = {
  setupSocket,
  getIO,
  pushNotification,
  pushPermissionUpdate,
  emitCampaignProgress,
  emitCampaignCompleted,
  emitSequenceProgress,
  emitBurstUpdate,
  emitIncomingCall,
  emitIncomingResolved,
  emitCallRecordsUpdated,
};
