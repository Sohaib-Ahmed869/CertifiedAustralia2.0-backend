const mongoose = require('mongoose');

const campaignSchema = new mongoose.Schema(
  {
    campaignId: {
      type: String,
      unique: true,
      required: true,
    },
    name: {
      type: String,
      required: true,
    },
    subject: {
      type: String,
      required: true,
    },
    previewText: {
      type: String,
    },
    replyTo: {
      type: String,
    },
    templateId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'EmailTemplate',
    },
    htmlContent: {
      type: String,
    },
    audienceConfig: {
      target: {
        type: String,
        enum: ['all', 'active', 'paid', 'intake', 'leads'],
        default: 'all',
      },
      excludeIds: [
        {
          type: mongoose.Schema.Types.ObjectId,
          ref: 'User',
        },
      ],
    },
    status: {
      type: String,
      enum: ['draft', 'sending', 'paused', 'sent', 'partially_failed', 'failed', 'cancelled'],
      default: 'draft',
    },
    stats: {
      totalRecipients: {
        type: Number,
        default: 0,
      },
      sent: {
        type: Number,
        default: 0,
      },
      failed: {
        type: Number,
        default: 0,
      },
      opened: {
        type: Number,
        default: 0,
      },
    },
    sendStartedAt: {
      type: Date,
    },
    completedAt: {
      type: Date,
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

campaignSchema.index({ status: 1 });
campaignSchema.index({ createdBy: 1 });
campaignSchema.index({ campaignId: 1 }, { unique: true });

module.exports = mongoose.model('Campaign', campaignSchema);
