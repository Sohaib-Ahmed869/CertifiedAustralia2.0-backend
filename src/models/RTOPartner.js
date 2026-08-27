const mongoose = require('mongoose');

/**
 * External RTO partners CA sends application packages to.
 *
 * These are NOT portal users — external RTOs never log in (see Domain Rules); admin
 * packages the application and emails it out. Internal RTOs are `User` docs with
 * `role: 'InternalRTO'` and are merged into the send-to-RTO picker separately.
 *
 * This list used to be a hardcoded array in the frontend, which meant retiring or adding
 * a partner needed a developer and a deploy. It is editable from the RTO Submission card
 * on the admin student detail page.
 *
 * Which partner delivers a given QUALIFICATION, and at what cost, is a different thing —
 * that's `Qualification.rtoCosts[]`, edited under Admin → Industries.
 */
const rtoPartnerSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    email: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
    },
    // Retiring a partner is a deactivation, not a delete — an application already sent to
    // them keeps a readable `rtoSubmissionName`, and the row can be brought back.
    isActive: {
      type: Boolean,
      default: true,
    },
    notes: {
      type: String,
      trim: true,
      default: '',
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
  },
  { timestamps: true }
);

// One partner per address. Declared here only (never also as `index: true` on the field),
// or Mongoose logs a duplicate-index warning at boot. A collision surfaces as a readable
// 409 via errorHandler's 11000 mapping rather than a raw driver string.
rtoPartnerSchema.index({ email: 1 }, { unique: true });
rtoPartnerSchema.index({ isActive: 1, name: 1 });

module.exports = mongoose.model('RTOPartner', rtoPartnerSchema);
