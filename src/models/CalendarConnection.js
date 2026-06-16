const mongoose = require('mongoose');

const calendarConnectionSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    provider: {
      type: String,
      enum: ['google', 'outlook'],
      required: true,
    },
    status: {
      type: String,
      enum: ['connected', 'disconnected', 'expired'],
      default: 'connected',
    },
    // OAuth tokens (encrypted at rest in production)
    accessToken: {
      type: String,
    },
    refreshToken: {
      type: String,
    },
    tokenExpiresAt: {
      type: Date,
    },
    // Provider account info
    accountEmail: {
      type: String,
    },
    calendarId: {
      type: String,
      default: 'primary',
    },
    // Sync preferences
    syncFollowUps: {
      type: Boolean,
      default: true,
    },
    syncDeadlines: {
      type: Boolean,
      default: false,
    },
    connectedAt: {
      type: Date,
      default: Date.now,
    },
    lastSyncAt: {
      type: Date,
    },
  },
  {
    timestamps: true,
  }
);

// One connection per user per provider
calendarConnectionSchema.index({ userId: 1, provider: 1 }, { unique: true });

module.exports = mongoose.model('CalendarConnection', calendarConnectionSchema);
