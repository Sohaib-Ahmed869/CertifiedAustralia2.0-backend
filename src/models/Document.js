const mongoose = require('mongoose');

const documentSchema = new mongoose.Schema(
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
    // File details
    fileName: {
      type: String,
      required: true,
    },
    fileType: {
      type: String,
      required: true,
    },
    googleDriveFileId: {
      type: String,
      required: true,
    },
    googleDriveLink: String,
    // Document tracking
    documentType: {
      type: String,
      enum: [
        'Identity Verification',
        'Work Experience Certificate',
        'Educational Qualifications',
        'Reference Letter',
        'Other',
      ],
      required: true,
    },
    // For unit-by-unit uploads
    qualificationUnitCode: String,
    // Versioning for re-uploads
    version: {
      type: Number,
      default: 1,
    },
    previousVersionFileIds: [String],
    // Status tracking
    status: {
      type: String,
      enum: ['uploaded', 'verified', 'rejected', 'resubmitted'],
      default: 'uploaded',
    },
    uploadedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    verifiedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    verifiedAt: Date,
    feedback: String,
    reviewStatus: {
      type: String,
      enum: ['pending', 'approved', 'rejected', 'changes_requested'],
    },
    // Expiry for RTO access (30 days from upload)
    rtoAccessExpiresAt: Date,
    // ISO compliance baseline: audit trail
    uploadedAt: {
      type: Date,
      default: Date.now,
    },
    verifiedAt: Date,
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

module.exports = mongoose.model('Document', documentSchema);
