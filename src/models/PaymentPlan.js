const mongoose = require('mongoose');

const installmentSchema = new mongoose.Schema(
  {
    index: {
      type: Number,
      required: true,
    },
    amount: {
      type: Number,
      required: true,
      min: 0,
    },
    dueDate: {
      type: Date,
      required: true,
    },
    status: {
      type: String,
      enum: ['pending', 'partiallyPaid', 'paid', 'skipped', 'cancelled'],
      default: 'pending',
    },
    paidAmount: {
      type: Number,
      default: 0,
      min: 0,
    },
    paymentDate: Date,
    paymentIds: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Payment',
      },
    ],
  },
  { _id: false }
);

const paymentPlanSchema = new mongoose.Schema(
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
    totalAmount: {
      type: Number,
      required: true,
      min: 0,
    },
    totalPaidAmount: {
      type: Number,
      default: 0,
      min: 0,
    },
    installments: [installmentSchema],
    discountApplied: {
      type: Number,
      default: 0,
      min: 0,
    },
    directDebitEnabled: {
      type: Boolean,
      default: false,
    },
    directDebitAccountDetails: {
      // Square card-on-file for recurring charges
      squareCustomerId: String,
      squareCardId: String,
      cardBrand: String,    // e.g. 'VISA', 'MASTERCARD'
      cardLast4: String,    // e.g. '4242'
      // Legacy bank details (kept for backwards compat)
      accountHolderName: String,
      accountNumber: String,
      bsb: String,
    },
    directDebitStatus: {
      type: String,
      enum: ['scheduled', 'processing', 'failed', 'disabled'],
      default: 'scheduled',
    },
    directDebitFailedAt: Date,
    directDebitFailReason: String,
    status: {
      type: String,
      enum: ['active', 'completed', 'cancelled', 'paused'],
      default: 'active',
    },
    pausedAt: {
      type: Date,
      default: null,
    },
    // Xero invoice
    xeroInvoiceId: String,
    // Audit trail
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
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

paymentPlanSchema.index({ applicationId: 1 });
paymentPlanSchema.index({ studentId: 1 });
paymentPlanSchema.index({ status: 1 });

module.exports = mongoose.model('PaymentPlan', paymentPlanSchema);
