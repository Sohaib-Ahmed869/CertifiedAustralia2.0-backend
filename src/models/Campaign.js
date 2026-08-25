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
        enum: ['all', 'active', 'paid', 'intake', 'leads', 'specific'],
        default: 'all',
      },
      // Advanced filters, same shape the sequence builder sends and the same
      // audienceService.buildFilter reads (industries[]/qualifications[]/statuses[]/
      // sources[]/states[]/callAttempts/dateFrom/dateTo/readyForAssessmentOnly/
      // includeArchived/archivedOnly). Mixed, so the shape can grow in one place.
      filters: { type: mongoose.Schema.Types.Mixed, default: {} },
      excludeIds: [
        {
          type: mongoose.Schema.Types.ObjectId,
          ref: 'User',
        },
      ],
      // Target 'specific' reads these. Declared explicitly because a strict schema
      // silently DROPS an undeclared key — without it a "Specific Recipients"
      // campaign saved an empty list and resolved to zero recipients.
      includeApplicationIds: [
        {
          type: mongoose.Schema.Types.ObjectId,
          ref: 'Application',
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
      queued: {
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
      bounced: {
        type: Number,
        default: 0,
      },
      opened: {
        type: Number,
        default: 0,
      },
    },
    // Human-readable reason surfaced on pause/failure (e.g. quota exhausted, no mailbox).
    lastError: {
      type: String,
    },
    sendStartedAt: {
      type: Date,
    },
    pausedAt: {
      type: Date,
    },
    resumedAt: {
      type: Date,
    },
    failedAt: {
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
