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
    // Timestamps
    issuedAt: {
      type: Date,
      default: Date.now,
    },
    dispatchedAt: Date,
    deliveredAt: Date,
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

module.exports = mongoose.model('Certificate', certificateSchema);
