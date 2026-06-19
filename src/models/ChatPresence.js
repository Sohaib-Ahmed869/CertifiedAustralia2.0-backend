const mongoose = require('mongoose');

const chatPresenceSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    unique: true,
    required: true,
  },
  status: {
    type: String,
    enum: ['online', 'away', 'offline'],
    default: 'offline',
  },
  lastSeenAt: { type: Date, default: Date.now },
  socketId: String,
});

// Auto-cleanup stale records after 24 hours
chatPresenceSchema.index({ lastSeenAt: 1 }, { expireAfterSeconds: 86400 });

module.exports = mongoose.model('ChatPresence', chatPresenceSchema);
