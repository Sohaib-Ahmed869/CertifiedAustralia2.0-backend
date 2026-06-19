const mongoose = require('mongoose');

const attachmentSchema = new mongoose.Schema(
  {
    fileName: String,
    fileUrl: String,
    fileType: String,
    fileSize: Number,
    driveFileId: String,
    thumbnailUrl: String,
  },
  { _id: false }
);

const reactionSchema = new mongoose.Schema(
  {
    emoji: { type: String, required: true },
    users: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  },
  { _id: false }
);

const messageSchema = new mongoose.Schema(
  {
    conversationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Conversation',
      required: true,
    },
    senderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },

    type: {
      type: String,
      enum: ['text', 'file', 'system'],
      default: 'text',
    },
    content: { type: String, default: '' },

    attachments: [attachmentSchema],

    // @mentions
    mentions: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],

    // Emoji reactions
    reactions: [reactionSchema],

    // Edit / delete
    editedAt: Date,
    deleted: { type: Boolean, default: false },
    deletedAt: Date,
    deletedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },

    // Message pinning
    pinned: { type: Boolean, default: false },
    pinnedAt: Date,
    pinnedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },

    // Forwarding
    forwardedFrom: { type: mongoose.Schema.Types.ObjectId, ref: 'Message' },
    forwardedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },

    // Reply threading
    replyTo: { type: mongoose.Schema.Types.ObjectId, ref: 'Message' },
  },
  { timestamps: true }
);

// Primary query pattern: messages for a conversation, newest first
messageSchema.index({ conversationId: 1, createdAt: -1 });
messageSchema.index({ mentions: 1 });

module.exports = mongoose.model('Message', messageSchema);
