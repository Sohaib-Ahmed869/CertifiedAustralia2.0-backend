const mongoose = require('mongoose');

const threadEntrySchema = new mongoose.Schema(
  {
    role: {
      type: String,
      enum: ['admin', 'rto', 'student'],
      required: true,
    },
    authorName: {
      type: String,
      required: true,
    },
    content: {
      type: String,
      required: true,
    },
    sentToStudent: {
      type: Boolean,
      default: false,
    },
    createdAt: {
      type: Date,
      default: Date.now,
    },
  },
  { _id: true }
);

const documentFeedbackSchema = new mongoose.Schema(
  {
    applicationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Application',
      required: true,
      index: true,
    },
    documentField: {
      type: String,
      required: true,
    },
    documentLabel: {
      type: String,
      required: true,
    },
    source: {
      type: String,
      enum: ['admin', 'rto'],
      required: true,
    },
    comment: {
      type: String,
      required: true,
    },
    thread: [threadEntrySchema],
    status: {
      type: String,
      enum: [
        'pending',
        'agent_responded',
        'forwarded_to_student',
        'student_replied',
        'student_resolved',
        'awaiting_rto_confirmation',
        'completed',
        'resolved',
      ],
      default: 'pending',
    },
    sentToStudent: {
      type: Boolean,
      default: false,
    },
    sentToStudentAt: Date,
    studentForwardedMessage: String,
    studentMarkedComplete: {
      type: Boolean,
      default: false,
    },
    studentMarkedCompleteAt: Date,
    rtoEmail: String,
    rtoName: String,
    adminEmail: String,
    adminName: String,
    resolvedAt: Date,
    resolvedBy: String,
  },
  { timestamps: true }
);

documentFeedbackSchema.index({ applicationId: 1, status: 1 });
documentFeedbackSchema.index({ applicationId: 1, source: 1 });

module.exports = mongoose.model('DocumentFeedback', documentFeedbackSchema);
