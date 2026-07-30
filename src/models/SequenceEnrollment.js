const mongoose = require('mongoose');

/**
 * A recipient's per-step journey through a sequence. One row per (sequence, lead).
 * The governing rule is "open = stop": once any step is opened the enrollment moves
 * to the terminal `opened` bucket and remaining pending steps are `skipped`.
 * Terminal states (opened / completed / bounced) are mutually exclusive; `active`
 * means still receiving.
 */
const enrollmentStepSchema = new mongoose.Schema(
  {
    stepId: { type: String },
    order: { type: Number },
    status: {
      type: String,
      enum: ['pending', 'sent', 'opened', 'skipped', 'bounced', 'failed'],
      default: 'pending',
    },
    sentAt: { type: Date },
    openedAt: { type: Date },
    messageId: { type: String },
    // = hmac(sequenceId:stepId:email) — also the SequenceRecipient/pixel token.
    trackingToken: { type: String },
    failureReason: { type: String },
  },
  { _id: false }
);

const sequenceEnrollmentSchema = new mongoose.Schema(
  {
    sequenceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Sequence', required: true },
    // = hmac(sequenceId:email) — deterministic, dedupes the audience.
    enrollmentKey: { type: String, required: true },
    mailboxId: { type: mongoose.Schema.Types.ObjectId, ref: 'Mailbox' },
    email: { type: String, required: true },
    name: { type: String },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    applicationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Application' },
    displayApplicationId: { type: String },
    qualification: { type: String },
    status: {
      type: String,
      enum: ['active', 'opened', 'completed', 'bounced'],
      default: 'active',
    },
    openedAt: { type: Date },
    openedAtOrder: { type: Number }, // step ORDER at which they opened
    openedStepId: { type: String },
    steps: [enrollmentStepSchema],
    enrolledAt: { type: Date },
  },
  { timestamps: true }
);

// Enroll-once guard (mirrors CampaignRecipient's {campaignId,leadId} unique).
sequenceEnrollmentSchema.index({ sequenceId: 1, userId: 1 }, { unique: true, sparse: true });
sequenceEnrollmentSchema.index({ enrollmentKey: 1 }, { unique: true });
sequenceEnrollmentSchema.index({ sequenceId: 1, status: 1 });

module.exports = mongoose.model('SequenceEnrollment', sequenceEnrollmentSchema);
