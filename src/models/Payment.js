const mongoose = require('mongoose');

const paymentSchema = new mongoose.Schema(
  {
    applicationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Application',
    },
    studentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    amount: {
      type: Number,
      required: true,
      min: 0,
    },
    type: {
      type: String,
      enum: ['upfront', 'plan', 'discount', 'manualMarkPaid', 'refund', 'rtoPayable', 'rtoPayment'],
      required: true,
    },
    // For discounts
    discountAmount: {
      type: Number,
      min: 0,
    },
    discountReason: String,
    // Payment method
    paymentMethod: {
      type: String,
      enum: ['square', 'manual', 'directDebit'],
      required: true,
    },
    status: {
      type: String,
      enum: ['pending', 'completed', 'failed', 'refunded', 'reversed'],
      default: 'pending',
    },
    // Square transaction details
    squareTransactionId: String,
    squarePaymentId: String,
    // Manual payment tracking
    manualPaymentReference: String,
    manualPaymentReason: String,
    // Xero sync
    xeroInvoiceId: String,
    xeroSyncStatus: {
      type: String,
      enum: ['pending', 'synced', 'failed'],
      default: null,
    },
    xeroSyncedAt: Date,
    // For payments within plans
    paymentPlanId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'PaymentPlan',
    },
    installmentIndex: Number,
    // Denormalized from Application.isTest — payments of a test application are
    // excluded from all revenue/cashflow metrics. Set on creation from the app
    // and re-synced when the application's test flag is toggled.
    isTest: {
      type: Boolean,
      default: false,
    },
    // Denormalized from the application being Archived — payments of an archived
    // application are excluded from all revenue/cashflow metrics. Kept in sync on
    // archive (applicationService.updateStatus) and restore (restoreFromArchive).
    isArchived: {
      type: Boolean,
      default: false,
    },
    // Notes
    notes: String,
    // Audit
    authorizedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    approvedByMFA: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    mfaRequiredForAmount: Boolean,
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

paymentSchema.index({ applicationId: 1 });
paymentSchema.index({ studentId: 1 });
paymentSchema.index({ status: 1 });
paymentSchema.index({ xeroSyncStatus: 1 });
paymentSchema.index({ applicationId: 1, status: 1 });
paymentSchema.index({ isTest: 1 });
paymentSchema.index({ isArchived: 1 });

// Inherit the test/archived flags from the parent application on creation, so
// payments recorded against a test OR archived application are excluded from
// revenue/cashflow metrics regardless of which code path created them. Toggling
// the app re-syncs existing payments (setTestFlag / updateStatus / restore), so
// this only needs to cover new docs.
paymentSchema.pre('save', async function (next) {
  if (!this.isNew) return next();
  try {
    if (this.applicationId && (this.isTest !== true || this.isArchived !== true)) {
      const app = await mongoose.model('Application').findById(this.applicationId).select('isTest status').lean();
      if (app) {
        if (this.isTest !== true && app.isTest) this.isTest = true;
        if (this.isArchived !== true && app.status === 'Archived') this.isArchived = true;
      }
    }
  } catch { /* non-fatal — a later sync will correct it */ }
  next();
});

module.exports = mongoose.model('Payment', paymentSchema);
