const mongoose = require('mongoose');

const certificateSchema = new mongoose.Schema(
  {
    applicationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Application',
      required: true,
    },
    studentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    issuedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    // Certificate file
    certificateLink: {
      type: String,
      required: true,
    },
    googleDriveFileId: String,
    // Certificate tracking (physical)
    trackingNumber: String,
    trackingLink: String,
    // Delivery status
    status: {
      type: String,
      enum: ['issued', 'in_delivery', 'delivered', 'failed_delivery'],
      default: 'issued',
    },
    // Soft-copy workflow
    softCopyUploadedAt: Date,
    softCopyEmailSentAt: Date,
    // Hard-copy workflow
    hardCopyDispatchedAt: Date,
    hardCopyEmailSentAt: Date,
    hardCopySentKPI: {
      type: Boolean,
      default: false,
    },
    // Timestamps
    issuedAt: {
      type: Date,
      default: Date.now,
    },
    dispatchedAt: Date,
    deliveredAt: Date,
    deliveredConfirmedBy: {
      type: String,
      enum: ['student', 'staff'],
    },
    // Denormalized from Application.isTest — certificates of a test application
    // are excluded from certificate metrics. Re-synced on toggle (setTestFlag).
    isTest: {
      type: Boolean,
      default: false,
    },
    // Notes
    notes: String,
    createdAt: {
      type: Date,
      default: Date.now,
    },
    updatedAt: {
      type: Date,
      default: Date.now,
    },
  }
);

certificateSchema.index({ isTest: 1 });

// Inherit the test flag from the parent application on creation.
certificateSchema.pre('save', async function (next) {
  if (!this.isNew || this.isTest === true) return next();
  try {
    if (this.applicationId) {
      const app = await mongoose.model('Application').findById(this.applicationId).select('isTest').lean();
      if (app?.isTest) this.isTest = true;
    }
  } catch { /* non-fatal — a later toggle sync will correct it */ }
  next();
});

module.exports = mongoose.model('Certificate', certificateSchema);
