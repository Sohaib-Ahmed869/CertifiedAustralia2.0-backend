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
    /**
     * Mailbox to send from. Declared because the wizard has always offered a
     * "Send From Mailbox" picker whose value a strict schema silently DROPPED —
     * every campaign actually went out from whichever active mailbox was least
     * used. Optional: left unset, `pickMailbox` picks as before.
     */
    mailboxId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Mailbox',
    },
    /**
     * Absolute UTC instant to start sending at.
     *
     * The wizard has offered "Schedule Send" since it shipped, but the field was
     * never on this schema (so it was dropped) and no cron ever looked for one —
     * the confirm dialog said "It will be scheduled for …" while the very next
     * line sent the campaign immediately. Stored UTC; the frontend converts an
     * AEST wall-clock through `utils/aestTime.aestWallToUtcISO`, exactly like a
     * sequence step's `sendAt`.
     */
    scheduledAt: {
      type: Date,
    },
    // Who scheduled it, for the audit line on the detail page.
    scheduledBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    status: {
      type: String,
      // `scheduled` sits between draft and sending: queued for a future instant,
      // still cancellable. The due-campaign cron is the only thing that moves it on.
      enum: ['draft', 'scheduled', 'sending', 'paused', 'sent', 'partially_failed', 'failed', 'cancelled'],
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
// The due-campaign cron's only query: scheduled rows whose instant has passed.
campaignSchema.index({ status: 1, scheduledAt: 1 });
campaignSchema.index({ createdBy: 1 });
campaignSchema.index({ campaignId: 1 }, { unique: true });

module.exports = mongoose.model('Campaign', campaignSchema);
