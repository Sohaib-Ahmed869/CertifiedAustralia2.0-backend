const mongoose = require('mongoose');

/**
 * A step in an email sequence (drip). `sendAt` is an ABSOLUTE UTC time (the FE
 * converts an AEST wall-clock to UTC). `htmlContent` is snapshotted from the
 * chosen template when the sequence starts, so later template edits never mutate
 * an in-flight drip.
 */
const sequenceStepSchema = new mongoose.Schema(
  {
    stepId: { type: String, required: true },
    order: { type: Number, required: true },
    templateId: { type: mongoose.Schema.Types.ObjectId, ref: 'EmailTemplate' },
    templateName: { type: String },
    subject: { type: String },
    previewText: { type: String },
    replyTo: { type: String },
    sendAt: { type: Date }, // absolute UTC send time
    htmlContent: { type: String }, // snapshotted from template at start
  },
  { _id: false }
);

const sequenceSchema = new mongoose.Schema(
  {
    sequenceId: {
      type: String,
      unique: true,
      required: true,
    },
    name: {
      type: String,
      required: true,
    },
    description: {
      type: String,
    },
    // Audience snapshot config — resolved once at start into enrollments.
    audienceConfig: {
      target: {
        type: String,
        enum: ['all', 'active', 'paid', 'intake', 'leads', 'specific', 'custom'],
        default: 'all',
      },
      // Advanced filters (industries[]/qualifications[]/statuses[]/sources[]/states[]/
      // callAttempts/dateFrom/dateTo/readyForAssessmentOnly/includeArchived/archivedOnly).
      filters: { type: mongoose.Schema.Types.Mixed, default: {} },
      excludeIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
      includeApplicationIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Application' }],
    },
    mailboxId: { type: mongoose.Schema.Types.ObjectId, ref: 'Mailbox' },
    // When this sequence last filled a send batch. The tick keeps ≥ SEQ_BATCH_INTERVAL
    // between batches so a large audience goes out paced, not as one SMTP burst.
    lastBatchAt: { type: Date },
    steps: [sequenceStepSchema],
    status: {
      type: String,
      enum: ['draft', 'active', 'paused', 'completed', 'cancelled'],
      default: 'draft',
    },
    // Denormalized counters. `active` is NOT stored — it is derived on read as
    // max(0, totalEnrolled − opened − completed − bounced) (buckets are exclusive).
    stats: {
      totalEnrolled: { type: Number, default: 0 },
      opened: { type: Number, default: 0 },
      completed: { type: Number, default: 0 },
      bounced: { type: Number, default: 0 },
      sent: { type: Number, default: 0 },
      failed: { type: Number, default: 0 },
      // { [stepId]: { sent, opened, bounced, failed } } — Mixed so dot-path $inc works.
      byStep: { type: mongoose.Schema.Types.Mixed, default: {} },
    },
    lastError: { type: String },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    startedAt: { type: Date },
    completedAt: { type: Date },
  },
  { timestamps: true }
);

sequenceSchema.index({ status: 1 });
sequenceSchema.index({ createdBy: 1 });
sequenceSchema.index({ sequenceId: 1 }, { unique: true });

module.exports = mongoose.model('Sequence', sequenceSchema);
