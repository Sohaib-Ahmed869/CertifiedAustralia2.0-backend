const mongoose = require('mongoose');
const User = require('./User');

const studentSchema = new mongoose.Schema(
  {
    // Student-specific fields
    usi: {
      type: String,
      sparse: true,
    },
    applicationIds: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Application',
      },
    ],
    // Marketing attribution
    sourceAttribution: {
      source: String,
      platform: String,
      campaign: String,
      timestamp: Date,
      trackingUrl: String,
    },
    // ISO compliance baseline: student consent tracking
    consents: {
      termsOfServiceAccepted: Boolean,
      eSignatureProvided: Boolean,
      privacyPolicyAccepted: Boolean,
      acceptedAt: Date,
    },
    signupDiscountApplied: {
      type: Boolean,
      default: true,
    },
  },
  { discriminatorKey: 'userType' }
);

module.exports = User.discriminator('Student', studentSchema);
