const mongoose = require('mongoose');

/**
 * SQUARE PAYMENT LINK — a hosted Square checkout URL emailed to a student.
 *
 * This is an ADD-ON to the existing payment stack, not a replacement. Nothing
 * about upfront/plan/manual collection changes; a link is simply a third way to
 * ask for the same money.
 *
 * THE LINK IS NOT THE PAYMENT. Creating one moves no money and writes no
 * `Payment` row — it only reserves an amount. The `Payment` is written later,
 * by the Square webhook, once the student has actually paid. So a link is a
 * *request*, and its `status` tracks the request, never the ledger.
 *
 * WHY `squareOrderId` IS THE JOIN KEY: the webhook hands us a Square *payment*
 * whose id we have never seen (we did not create the charge — the student did,
 * on Square's page). The only field connecting it back to this record is
 * `payment.order_id`, which Square stamps from the order behind the link. That
 * is why the id is stored and indexed here, and why a link without one can
 * never be settled automatically.
 *
 * TARGETING: `applicationId` is required — every link bills a specific
 * application. `paymentPlanId` + `installmentIndex` are set when the link was
 * raised against one installment; they are recorded for audit and for the row's
 * label, but settlement still runs through the same sequential
 * `allocateToPlan` the rest of the portal uses, so a link payment lands exactly
 * where a manual payment of the same size would.
 */
const paymentLinkSchema = new mongoose.Schema(
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
    // Set only when the link was raised against a specific installment.
    paymentPlanId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'PaymentPlan',
      default: null,
    },
    installmentIndex: {
      type: Number,
      default: null,
    },
    amount: {
      type: Number,
      required: true,
      min: 0.01,
    },
    // Shown as the line item on Square's checkout page.
    description: String,

    // ── Square ──────────────────────────────────────────────────────────────
    squarePaymentLinkId: String,
    // The join key for the webhook. See the header note.
    squareOrderId: String,
    url: String,
    longUrl: String,
    idempotencyKey: String,

    /**
     * `pending` is the live state — the link exists and is payable. It is
     * deliberately not called "sent": whether the email left the building is a
     * separate fact (`emailSent`), and a link whose email bounced is still a
     * perfectly good link an admin can resend or copy.
     */
    status: {
      type: String,
      enum: ['pending', 'paid', 'expired', 'cancelled'],
      default: 'pending',
    },

    // ── Delivery ────────────────────────────────────────────────────────────
    sentTo: String,
    sentAt: Date,
    sentBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    emailSent: {
      type: Boolean,
      default: false,
    },
    emailError: String,
    resendCount: {
      type: Number,
      default: 0,
    },
    lastResentAt: Date,

    // Square stops accepting the checkout at this instant; the portal expires
    // the row lazily on read so a stale amount can never be paid.
    expiresAt: Date,

    // ── Settlement (written by the webhook, never by a human) ────────────────
    paymentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Payment',
    },
    squarePaymentId: String,
    paidAt: Date,
    paidAmount: Number,

    cancelledAt: Date,
    cancelledBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },

    // Denormalized from Application.isTest, matching Payment/PaymentPlan, so a
    // test application's links are excluded from any future reporting on them.
    isTest: {
      type: Boolean,
      default: false,
    },

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

paymentLinkSchema.index({ applicationId: 1, status: 1 });
paymentLinkSchema.index({ studentId: 1, status: 1 });
// The webhook's lookup path — one indexed hit per incoming Square payment.
paymentLinkSchema.index({ squareOrderId: 1 });
paymentLinkSchema.index({ squarePaymentLinkId: 1 });
paymentLinkSchema.index({ status: 1, expiresAt: 1 });

// Inherit the test flag from the parent application on creation, exactly as
// Payment and PaymentPlan do.
paymentLinkSchema.pre('save', async function (next) {
  if (!this.isNew || this.isTest === true) return next();
  try {
    if (this.applicationId) {
      const app = await mongoose.model('Application').findById(this.applicationId).select('isTest').lean();
      if (app?.isTest) this.isTest = true;
    }
  } catch { /* non-fatal — reporting can be re-synced */ }
  next();
});

module.exports = mongoose.model('PaymentLink', paymentLinkSchema);
