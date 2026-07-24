const mongoose = require('mongoose');

/**
 * Direct Debit Authority — a signed customer authorisation for recurring
 * charges against the payment plan on file. Admin enables it (emails the
 * student a token link); the student reviews the arrangement, consents and
 * signs; a real PDF is generated and stored to the application's Drive folder.
 */
const directDebitAuthoritySchema = new mongoose.Schema(
  {
    applicationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Application',
      required: true,
      index: true,
    },
    studentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    token: {
      type: String,
      required: true,
      unique: true, // unique implies an index
    },
    status: {
      type: String,
      enum: ['pending', 'submitted', 'disabled'],
      default: 'pending',
    },
    enabled: {
      type: Boolean,
      default: true,
    },
    // Snapshot of the payment arrangement at enable time (read-only on the form)
    arrangement: {
      totalAmount: Number,
      recurringAmount: Number,
      frequency: String, // Weekly | Fortnightly | Monthly | Per schedule
      firstChargeDate: Date,
      numberOfPayments: Number,
      paidToDate: Number,
      outstanding: Number,
      surcharge: Number,
    },
    // Student-submitted form
    form: {
      fullName: String,
      studentClientId: String,
      address: String,
      phone: String,
      email: String,
      authoriseRecurring: Boolean,
      understandRecurring: Boolean,
      confirmCardholder: Boolean,
      acceptTerms: Boolean,
      signatureName: String,
      signatureDate: String,
    },
    // Signature image (base64 PNG data URL) + how it was produced
    signature: {
      mode: { type: String, enum: ['drawn', 'typed'] },
      dataUrl: String,
      font: String,
    },
    // Generated PDF (stored on Google Drive)
    pdf: {
      driveFileId: String,
      viewLink: String,
      downloadLink: String,
      fileName: String,
      generatedAt: Date,
    },
    enabledBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    enabledAt: Date,
    submittedAt: Date,
  },
  { timestamps: true }
);

module.exports = mongoose.model('DirectDebitAuthority', directDebitAuthoritySchema);
