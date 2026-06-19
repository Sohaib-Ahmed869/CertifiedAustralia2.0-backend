const mongoose = require('mongoose');

const mailboxSchema = new mongoose.Schema(
  {
    email: {
      type: String,
      required: true,
      unique: true,
    },
    displayName: {
      type: String,
    },
    provider: {
      type: String,
      enum: ['gmail', 'outlook', 'custom'],
      default: 'gmail',
    },
    smtpHost: {
      type: String,
      required: true,
    },
    smtpPort: {
      type: Number,
      default: 587,
    },
    appPassword: {
      type: String,
      required: true,
    },
    healthStatus: {
      type: String,
      enum: ['healthy', 'unhealthy', 'cooldown'],
      default: 'healthy',
    },
    cooldownUntil: {
      type: Date,
    },
    lastVerifiedAt: {
      type: Date,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    quotaConfig: {
      dailyLimit: {
        type: Number,
        default: 500,
      },
      hourlyLimit: {
        type: Number,
        default: 20,
      },
    },
    usage: {
      sentToday: {
        type: Number,
        default: 0,
      },
      sentThisHour: {
        type: Number,
        default: 0,
      },
      dailyResetAt: {
        type: Date,
      },
      hourlyResetAt: {
        type: Date,
      },
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
  },
  {
    timestamps: true,
  }
);

mailboxSchema.index({ email: 1 }, { unique: true });
mailboxSchema.index({ provider: 1 });

module.exports = mongoose.model('Mailbox', mailboxSchema);
