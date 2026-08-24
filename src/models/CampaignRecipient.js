const mongoose = require('mongoose');

/**
 * One row per (campaign, lead). Drives the send loop and is the source of
 * truth for open/bounce tracking. Campaign.stats holds denormalized counters
 * for fast dashboard reads; those only move on guarded transitions here.
 */
const campaignRecipientSchema = new mongoose.Schema(
  {
    campaignId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Campaign',
      required: true,
    },
    // The student/lead this row targets (a User). Used with campaignId for the
    // deterministic tracking token.
    leadId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    // Optional source application (audience is application-based).
    applicationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Application',
    },
    email: {
      type: String,
      required: true,
    },
    recipientName: {
      type: String,
    },
    // Merge-tag data, snapshotted at audience-resolve time (same "snapshot not
    // populate" convention as PaymentBatch rows) — {{firstName}}/{{lastName}}/
    // {{qualification}}/{{applicationId}} keep resolving correctly even if the
    // student's application is later renamed, re-assigned, or archived.
    firstName: { type: String },
    lastName: { type: String },
    qualification: { type: String },
    applicationDisplayId: { type: String },
    status: {
      type: String,
      enum: ['queued', 'sending', 'sent', 'failed', 'bounced'],
      default: 'queued',
    },
    // Which mailbox sent this message — bounce polling reads that inbox over IMAP.
    mailboxId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Mailbox',
    },
    sentAt: { type: Date },           // accepted for relay
    bouncedAt: { type: Date },        // DSN detected
    bounceCheckedAt: { type: Date },  // verified un-bounced after grace window ("Verifying" → "Sent")
    openedAt: { type: Date },         // first genuine open
    openCount: { type: Number, default: 0 },
    failureReason: { type: String },
    failureCode: { type: String },
    // SMTP Message-ID from nodemailer — primary bounce-matching key.
    messageId: { type: String },
    // HMAC, unguessable — used in the pixel URL (not reverse-decoded).
    trackingToken: { type: String },
  },
  { timestamps: true }
);

campaignRecipientSchema.index({ campaignId: 1, leadId: 1 }, { unique: true, sparse: true });
campaignRecipientSchema.index({ campaignId: 1, status: 1 });
campaignRecipientSchema.index({ trackingToken: 1 }, { sparse: true });
campaignRecipientSchema.index({ messageId: 1 }, { sparse: true }); // bounce match by id
campaignRecipientSchema.index({ email: 1, status: 1 });            // bounce match by address fallback

module.exports = mongoose.model('CampaignRecipient', campaignRecipientSchema);
