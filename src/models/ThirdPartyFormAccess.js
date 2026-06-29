const mongoose = require('mongoose');

const thirdPartyFormAccessSchema = new mongoose.Schema(
  {
    applicationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Application',
      required: true,
    },
    formId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'DynamicForm',
      required: true,
    },
    token: {
      type: String,
      required: true,
      unique: true,
    },
    // Recipient details
    recipientName: { type: String, required: true },
    recipientEmail: { type: String, required: true },
    recipientCompany: String,
    recipientRole: String, // e.g. employer, referee, supervisor

    status: {
      type: String,
      enum: ['pending', 'completed', 'expired', 'cancelled'],
      default: 'pending',
    },
    expiresAt: {
      type: Date,
      required: true,
    },
    completedAt: Date,
    submissionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'FormSubmission',
    },
    // Who set this up
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
  },
  { timestamps: true }
);

thirdPartyFormAccessSchema.index({ token: 1 });
thirdPartyFormAccessSchema.index({ applicationId: 1, formId: 1 });
thirdPartyFormAccessSchema.index({ recipientEmail: 1 });
thirdPartyFormAccessSchema.index({ status: 1, expiresAt: 1 });

module.exports = mongoose.model('ThirdPartyFormAccess', thirdPartyFormAccessSchema);
