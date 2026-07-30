const mongoose = require('mongoose');

/**
 * One row per sent step — the pixel + bounce target. Keyed by `trackingToken`
 * (= hmac(sequenceId:stepId:email)), which is also the public pixel token, so an
 * open lookup is O(1). Bounce reconciliation is status-guarded on `sent`.
 */
const sequenceRecipientSchema = new mongoose.Schema(
  {
    trackingToken: { type: String, required: true },
    sequenceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Sequence', required: true },
    stepId: { type: String },
    stepOrder: { type: Number },
    enrollmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'SequenceEnrollment' },
    mailboxId: { type: mongoose.Schema.Types.ObjectId, ref: 'Mailbox' },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    email: { type: String, required: true },
    name: { type: String },
    applicationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Application' },
    status: {
      type: String,
      enum: ['sent', 'bounced', 'failed'],
      default: 'sent',
    },
    messageId: { type: String }, // SMTP Message-ID — primary bounce-matching key
    sentAt: { type: Date },
    openedAt: { type: Date }, // first genuine open (status stays 'sent')
    openCount: { type: Number, default: 0 },
    bouncedAt: { type: Date },
    bounceCheckedAt: { type: Date },
    failureReason: { type: String },
    failureCode: { type: String },
  },
  { timestamps: true }
);

sequenceRecipientSchema.index({ trackingToken: 1 }, { unique: true });
sequenceRecipientSchema.index({ sequenceId: 1, status: 1 });
sequenceRecipientSchema.index({ messageId: 1 }, { sparse: true }); // bounce match by id
sequenceRecipientSchema.index({ email: 1, status: 1 }); // bounce match by address fallback
sequenceRecipientSchema.index({ enrollmentId: 1 });

module.exports = mongoose.model('SequenceRecipient', sequenceRecipientSchema);
