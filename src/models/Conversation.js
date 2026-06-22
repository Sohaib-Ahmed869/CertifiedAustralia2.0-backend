const mongoose = require('mongoose');

const participantSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    role: {
      type: String,
      enum: ['owner', 'admin', 'member'],
      default: 'member',
    },
    joinedAt: { type: Date, default: Date.now },
    lastReadAt: { type: Date, default: Date.now },
    // Per-user preferences
    pinned: { type: Boolean, default: false },
    favourited: { type: Boolean, default: false },
    mutedUntil: { type: Date, default: null },
    labels: [{
      title: { type: String, required: true },
      color: { type: String, default: '#6366f1' },
    }],
  },
  { _id: false }
);

const conversationSchema = new mongoose.Schema(
  {
    type: {
      type: String,
      enum: ['dm', 'channel'],
      required: true,
    },

    // Channel-only fields
    name: { type: String, trim: true },
    description: { type: String, trim: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },

    // Participants (DMs: exactly 2, channels: N members)
    participants: [participantSchema],

    // Denormalized last message for fast sidebar queries
    lastMessage: {
      content: String,
      senderId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      senderName: String,
      sentAt: Date,
      type: {
        type: String,
        enum: ['text', 'file', 'system'],
        default: 'text',
      },
    },

    // DM uniqueness — sorted participant ID hash
    dmParticipantHash: { type: String, unique: true, sparse: true },

    // Observers: users with read-only access (admin visibility on RTO-student chats)
    observers: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
      },
    ],

    archived: { type: Boolean, default: false },
  },
  { timestamps: true }
);

conversationSchema.index({ 'participants.userId': 1 });
conversationSchema.index({ type: 1, updatedAt: -1 });
conversationSchema.index({ 'lastMessage.sentAt': -1 });

module.exports = mongoose.model('Conversation', conversationSchema);
