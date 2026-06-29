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

module.exports = mongoose.model('Payment', paymentSchema);
