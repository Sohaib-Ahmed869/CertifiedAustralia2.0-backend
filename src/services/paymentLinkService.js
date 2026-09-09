'use strict';

/**
 * PAYMENT LINKS — ask a student for money by emailing them a hosted Square
 * checkout URL, instead of taking their card over the phone or chasing a bank
 * transfer.
 *
 * This service is an ADD-ON. It writes no ledger rows of its own and changes
 * nothing about upfront / plan / manual collection: when a link is paid it
 * hands the money to `paymentService.createPaymentRecord`, the same function
 * every other collection path already uses, so installment allocation,
 * application flags, the 21-day timer, the lead-status hook and the receipt
 * email all behave identically to a payment recorded by hand.
 *
 * ── THE TWO THINGS THAT MAKE THIS SAFE ──────────────────────────────────────
 *
 * 1. THE JOIN KEY IS `order_id`, NOT A PAYMENT ID. We do not create the charge
 *    — the student does, on Square's page — so the webhook's `payment.id` is a
 *    value the portal has never seen. The only thread back to us is
 *    `payment.order_id`, which Square copies from the order behind the link.
 *    That is why `squareOrderId` is persisted and indexed on PaymentLink, and
 *    why a link Square returned without one is refused at creation rather than
 *    left to fail silently at settlement.
 *
 * 2. SETTLEMENT IS CLAIMED BEFORE IT IS WRITTEN. Square retries a webhook it
 *    considers unacknowledged, and `payment.created` + `payment.updated` both
 *    fire for the same money. `settleFromSquarePayment` therefore flips the
 *    link `pending → paid` with an atomic `findOneAndUpdate` and only the
 *    winner writes the Payment — the same claim pattern the email sequencer
 *    uses to stop duplicate sends. A read-then-write would leave the whole
 *    `createPaymentRecord` round trip as a race window and bank the money
 *    twice.
 *
 * ── WHY A LINK PAYMENT IS TYPED `manualMarkPaid` ───────────────────────────
 *
 * The client's rule: a link payment reads as a manual payment. That is also
 * the safe engineering choice — `['upfront','plan','manualMarkPaid']` is
 * hardcoded as "student money in" in a dozen places (ceoDashboardService,
 * cashflowService, xeroService ACCREC_TYPES, agentTargetService,
 * adminStudentListService, chatbotService, the finance dashboard, the reporting
 * page, both student pages). A NEW payment type would be revenue that silently
 * vanished from every one of them until each was found and edited.
 *
 * What keeps the two distinguishable is `paymentMethod: 'paymentLink'` plus the
 * `paymentLinkId` back-reference, so finance can always tell a real card
 * payment from an off-portal one without any rollup having to know.
 */

const crypto = require('crypto');
const AppError = require('../utils/AppError');
const PaymentLink = require('../models/PaymentLink');
const Payment = require('../models/Payment');
const PaymentPlan = require('../models/PaymentPlan');
const Application = require('../models/Application');
const User = require('../models/User');
const { createSquarePaymentLink, deleteSquarePaymentLink } = require('./squareService');
const { effectivePrice } = require('./priceFloorService');
const appEmails = require('./applicationEmailService');

// Money the student has actually handed over. Same triple the rest of the
// portal treats as revenue.
const MONEY_IN_TYPES = ['upfront', 'plan', 'manualMarkPaid'];

const DEFAULT_EXPIRY_DAYS = Number(process.env.PAYMENT_LINK_TTL_DAYS || 7);
// Square refuses a checkout expiry outside this window.
const MIN_EXPIRY_DAYS = 1;
const MAX_EXPIRY_DAYS = 90;

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

const money = (n) => `$${round2(n).toLocaleString('en-AU', { minimumFractionDigits: 2 })}`;

/**
 * Where Square sends the student after a successful checkout.
 *
 * DELIBERATELY NOT `/thank-you`. That URL is registered as a conversion rule
 * with the ad platforms (it is the post-signup landing page), so pointing
 * payment traffic at it would inflate reported registration conversions.
 */
const redirectUrl = () => {
  const base = (
    process.env.APP_BASE_URL ||
    process.env.FRONTEND_URL ||
    'https://portal.certifiedaustralia.com.au'
  ).replace(/\/$/, '');
  return `${base}/payment-complete`;
};

// ---------------------------------------------------------------------------
// Balance
// ---------------------------------------------------------------------------

/**
 * What this application still owes, and how much of that is already spoken for
 * by open links.
 *
 * `available` is the ceiling on a new link. Without it, two admins (or one
 * admin twice) could raise two full-balance links and the student could pay
 * both — the portal would happily bank an overpayment that no installment
 * needs, because each link is created in ignorance of the other.
 *
 * Mirrors the student-detail maths exactly: price − discounts − completed
 * money-in payments.
 */
const balanceFor = async (applicationId) => {
  const application = await Application.findById(applicationId)
    .populate('qualificationId', 'caPrice')
    .lean();

  if (!application) throw new AppError('Application not found', 404);

  const effectiveTotal = effectivePrice(application.qualificationId, application);

  const paidRows = await Payment.find({
    applicationId,
    type: { $in: MONEY_IN_TYPES },
    status: 'completed',
  })
    .select('amount')
    .lean();

  const totalPaid = paidRows.reduce((s, p) => s + (Number(p.amount) || 0), 0);
  const remaining = Math.max(0, round2(effectiveTotal - totalPaid));

  const openLinks = await PaymentLink.find({
    applicationId,
    status: 'pending',
    $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }],
  })
    .select('amount')
    .lean();

  const reserved = round2(openLinks.reduce((s, l) => s + (Number(l.amount) || 0), 0));

  return {
    effectiveTotal: round2(effectiveTotal),
    totalPaid: round2(totalPaid),
    remaining,
    reserved,
    available: Math.max(0, round2(remaining - reserved)),
    openLinkCount: openLinks.length,
  };
};

// ---------------------------------------------------------------------------
// Lazy expiry
// ---------------------------------------------------------------------------

/**
 * Flip past-expiry links to `expired`.
 *
 * Run lazily on every read rather than from a cron: an expired link is only
 * ever wrong when somebody is looking at it, and crons here run in-process on
 * every instance. Settlement deliberately still accepts an expired link — see
 * `settleFromSquarePayment`.
 */
const expireStale = async (filter = {}) => {
  try {
    await PaymentLink.updateMany(
      { ...filter, status: 'pending', expiresAt: { $ne: null, $lt: new Date() } },
      { $set: { status: 'expired', updatedAt: new Date() } }
    );
  } catch (err) {
    console.error('[paymentLinkService] expireStale error:', err.message);
  }
};

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

const POPULATE = [
  { path: 'studentId', select: 'firstName lastName email' },
  { path: 'applicationId', select: 'applicationId status' },
  { path: 'sentBy', select: 'firstName lastName' },
];

const listLinks = async (query = {}) => {
  const filter = {};
  if (query.applicationId) filter.applicationId = query.applicationId;
  if (query.studentId) filter.studentId = query.studentId;
  if (query.status) filter.status = query.status;

  await expireStale(filter.applicationId ? { applicationId: filter.applicationId } : {});

  const limit = Math.min(Number(query.limit) || 50, 200);

  const items = await PaymentLink.find(filter)
    .populate(POPULATE)
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean();

  return { items, total: items.length };
};

const getLink = async (id) => {
  const link = await PaymentLink.findById(id).populate(POPULATE).lean();
  if (!link) throw new AppError('Payment link not found', 404);
  return link;
};

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

/**
 * Resolve which installment (if any) this link is being raised against, and
 * sanity-check the amount against it.
 */
const resolveInstallment = async (application, installmentIndex) => {
  if (installmentIndex === undefined || installmentIndex === null || installmentIndex === '') {
    return { paymentPlanId: null, installmentIndex: null, installment: null, plan: null };
  }

  const idx = Number(installmentIndex);
  if (!Number.isInteger(idx) || idx < 0) {
    throw new AppError('Invalid installment index', 400);
  }

  if (!application.paymentPlanId) {
    throw new AppError('This application has no payment plan, so a link cannot target an installment', 400);
  }

  const plan = await PaymentPlan.findById(application.paymentPlanId);
  if (!plan || plan.status === 'cancelled') {
    throw new AppError('This application has no active payment plan', 400);
  }

  const installment = plan.installments.find((i) => i.index === idx) || plan.installments[idx];
  if (!installment) throw new AppError(`Installment #${idx + 1} not found on this plan`, 404);
  if (installment.status === 'paid') throw new AppError(`Installment #${idx + 1} is already paid`, 400);
  if (installment.status === 'skipped') throw new AppError(`Installment #${idx + 1} was skipped`, 400);

  return { paymentPlanId: plan._id, installmentIndex: idx, installment, plan };
};

/**
 * Create a Square checkout link for an application and (by default) email it to
 * the student.
 *
 * The Square call happens BEFORE the record is written: a PaymentLink row with
 * no URL is useless, and a failed Square call must leave nothing behind for
 * staff to wonder about.
 */
const createLink = async (data = {}, actor = null) => {
  const application = await Application.findById(data.applicationId)
    .populate('qualificationId', 'name caPrice')
    .lean();

  if (!application) throw new AppError('Application not found', 404);
  if (application.status === 'Archived') {
    throw new AppError('This application is archived — restore it before requesting payment', 400);
  }

  const student = await User.findById(application.studentId)
    .select('firstName lastName email')
    .lean();

  if (!student) throw new AppError('Student not found for this application', 404);

  const sendTo = (data.sendTo || student.email || '').trim();
  if (!sendTo) throw new AppError('This student has no email address on file', 400);

  const { paymentPlanId, installmentIndex, installment } = await resolveInstallment(
    application,
    data.installmentIndex
  );

  // Amount: explicit, else the installment's outstanding portion, else the
  // whole unreserved balance.
  const balance = await balanceFor(application._id);
  const installmentOutstanding = installment
    ? round2((installment.amount || 0) - (installment.paidAmount || 0))
    : null;

  const amount = round2(
    data.amount !== undefined && data.amount !== null && data.amount !== ''
      ? Number(data.amount)
      : (installmentOutstanding ?? balance.available)
  );

  if (!amount || amount <= 0) {
    throw new AppError('Enter an amount greater than $0', 400);
  }
  if (balance.remaining <= 0) {
    throw new AppError('This application has no outstanding balance', 400);
  }
  if (amount > balance.available) {
    throw new AppError(
      balance.reserved > 0
        ? `Only ${money(balance.available)} can be requested — ${money(balance.reserved)} of the ${money(balance.remaining)} balance is already covered by ${balance.openLinkCount} open payment link${balance.openLinkCount === 1 ? '' : 's'}. Cancel one first, or request a smaller amount.`
        : `Amount cannot exceed the outstanding balance of ${money(balance.remaining)}`,
      400
    );
  }

  const days = Math.min(
    MAX_EXPIRY_DAYS,
    Math.max(MIN_EXPIRY_DAYS, Number(data.expiresInDays) || DEFAULT_EXPIRY_DAYS)
  );
  const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000);

  const qualName = application.qualificationId?.name || 'RPL Qualification';
  const description =
    (data.description || '').trim() ||
    (installment
      ? `Installment #${installmentIndex + 1} — ${qualName}`
      : `${qualName} — ${application.applicationId}`);

  const idempotencyKey = crypto.randomUUID();

  const squareLink = await createSquarePaymentLink({
    amount,
    name: description,
    idempotencyKey,
    buyerEmail: sendTo,
    note: `${application.applicationId}${installment ? ` · Installment ${installmentIndex + 1}` : ''}`,
    redirectUrl: redirectUrl(),
    expiresAt,
  });

  // Without an order id the webhook can never match this payment back to the
  // link, and the money would land as an unmatched event. Refuse now, loudly,
  // rather than discover it after a student has paid.
  if (!squareLink?.order_id) {
    throw new AppError(
      'Square returned a payment link without an order id — the payment could not be tracked back to this application. No link was created.',
      502
    );
  }

  const link = await PaymentLink.create({
    applicationId: application._id,
    studentId: student._id,
    paymentPlanId,
    installmentIndex,
    amount,
    description,
    squarePaymentLinkId: squareLink.id,
    squareOrderId: squareLink.order_id,
    url: squareLink.url,
    longUrl: squareLink.long_url || squareLink.url,
    idempotencyKey,
    status: 'pending',
    expiresAt,
    sentTo: sendTo,
    createdBy: actor?._id,
    sentBy: actor?._id,
  });

  if (data.sendEmail !== false) {
    await deliverEmail(link, student, application);
  }

  return getLink(link._id);
};

/**
 * Email the link to the student. Never throws — a delivery failure must not
 * destroy a working link, so it is recorded on the row and staff can resend or
 * copy the URL by hand.
 */
const deliverEmail = async (link, student, application) => {
  try {
    const result = await appEmails.sendPaymentLinkEmail(
      { ...student, email: link.sentTo || student.email },
      application,
      link
    );

    const ok = result?.success !== false;
    await PaymentLink.findByIdAndUpdate(link._id, {
      $set: {
        emailSent: ok,
        emailError: ok ? undefined : 'The email could not be delivered',
        sentAt: ok ? new Date() : undefined,
        updatedAt: new Date(),
      },
    });
    return ok;
  } catch (err) {
    console.error('[paymentLinkService] deliverEmail error:', err.message);
    await PaymentLink.findByIdAndUpdate(link._id, {
      $set: { emailSent: false, emailError: err.message, updatedAt: new Date() },
    });
    return false;
  }
};

/** Re-send the same link. The URL is unchanged — this is a nudge, not a reissue. */
const resendLink = async (id, actor = null, sendTo = null) => {
  const link = await PaymentLink.findById(id);
  if (!link) throw new AppError('Payment link not found', 404);
  if (link.status === 'paid') throw new AppError('This link has already been paid', 400);
  if (link.status === 'cancelled') throw new AppError('This link was cancelled — create a new one', 400);
  if (link.status === 'expired' || (link.expiresAt && link.expiresAt < new Date())) {
    throw new AppError('This link has expired — create a new one', 400);
  }

  const [student, application] = await Promise.all([
    User.findById(link.studentId).select('firstName lastName email').lean(),
    Application.findById(link.applicationId).populate('qualificationId', 'name').lean(),
  ]);

  if (!student) throw new AppError('Student not found', 404);

  if (sendTo) link.sentTo = String(sendTo).trim();
  link.resendCount = (link.resendCount || 0) + 1;
  link.lastResentAt = new Date();
  link.sentBy = actor?._id || link.sentBy;
  link.updatedAt = new Date();
  await link.save();

  const ok = await deliverEmail(link, student, application);
  if (!ok) throw new AppError('The payment link email could not be sent', 502);

  return getLink(link._id);
};

/**
 * Stop expecting this money.
 *
 * Square is asked to delete the checkout, but the portal-side cancel stands
 * even if that call fails — the row is the portal's record of intent, and a
 * payment that somehow still arrives is settled anyway (money received is
 * always recorded).
 */
const cancelLink = async (id, actor = null) => {
  const link = await PaymentLink.findById(id);
  if (!link) throw new AppError('Payment link not found', 404);
  if (link.status === 'paid') throw new AppError('This link has already been paid and cannot be cancelled', 400);
  if (link.status === 'cancelled') return getLink(link._id);

  await deleteSquarePaymentLink(link.squarePaymentLinkId);

  link.status = 'cancelled';
  link.cancelledAt = new Date();
  link.cancelledBy = actor?._id;
  link.updatedAt = new Date();
  await link.save();

  return getLink(link._id);
};

// ---------------------------------------------------------------------------
// Settlement (webhook)
// ---------------------------------------------------------------------------

const squareAmount = (sqPayment) => {
  const cents =
    sqPayment?.total_money?.amount ??
    sqPayment?.amount_money?.amount ??
    0;
  return round2(Number(cents) / 100);
};

/**
 * Settle a Square payment that came from one of our payment links.
 *
 * Called from the Square webhook when no existing Payment row matched by
 * `squarePaymentId` — i.e. a charge the portal did not initiate.
 *
 * Returns a small result object rather than throwing: the webhook must answer
 * 200 for anything it understood, or Square will retry a payment we have
 * already banked.
 */
const settleFromSquarePayment = async (sqPayment) => {
  const orderId = sqPayment?.order_id;
  if (!orderId) return { matched: false, reason: 'no_order_id' };

  // Only completed money settles. APPROVED/PENDING fire first and would bank
  // an authorisation that may never capture.
  if (sqPayment.status !== 'COMPLETED') {
    return { matched: false, reason: `status_${sqPayment.status || 'unknown'}` };
  }

  // Guard 1 — this exact Square payment is already in the ledger. Covers the
  // `payment.created` + `payment.updated` pair for the same money.
  const existing = await Payment.findOne({ squarePaymentId: sqPayment.id }).select('_id').lean();
  if (existing) {
    return { matched: true, alreadySettled: true, paymentId: String(existing._id) };
  }

  /* Guard 2 — atomic claim. Only the request that flips the link to `paid`
     writes the Payment; a concurrent retry finds nothing and returns.

     `cancelled` and `expired` links are deliberately still claimable: if the
     student's card went through, the money exists and must be recorded. What
     we refuse to do twice is bank it. */
  const link = await PaymentLink.findOneAndUpdate(
    { squareOrderId: orderId, status: { $ne: 'paid' } },
    {
      $set: {
        status: 'paid',
        paidAt: new Date(),
        paidAmount: squareAmount(sqPayment),
        squarePaymentId: sqPayment.id,
        updatedAt: new Date(),
      },
    },
    { new: true }
  );

  if (!link) {
    const alreadyPaid = await PaymentLink.findOne({ squareOrderId: orderId }).select('_id paymentId').lean();
    return alreadyPaid
      ? { matched: true, alreadySettled: true, paymentLinkId: String(alreadyPaid._id) }
      : { matched: false, reason: 'no_link_for_order' };
  }

  const amount = squareAmount(sqPayment) || link.amount;

  try {
    // Hand off to the ONE function every other collection path uses, so the
    // application flags, installment allocation, 21-day timer, lead-status hook
    // and receipt email are identical to any other payment.
    const { createPaymentRecord } = require('./paymentService');

    const payment = await createPaymentRecord({
      applicationId: link.applicationId,
      studentId: link.studentId,
      amount,
      // See the header note: `manualMarkPaid` keeps this money inside every
      // existing revenue rollup untouched; `paymentMethod` is what tells the
      // two apart.
      type: 'manualMarkPaid',
      paymentMethod: 'paymentLink',
      status: 'completed',
      ...(link.paymentPlanId ? { paymentPlanId: link.paymentPlanId } : {}),
      ...(link.installmentIndex !== null && link.installmentIndex !== undefined
        ? { installmentIndex: link.installmentIndex }
        : {}),
      paymentLinkId: link._id,
      squarePaymentId: sqPayment.id,
      squareTransactionId: sqPayment.id,
      manualPaymentReference: 'Square Payment Link',
      notes: link.description
        ? `Paid online via payment link — ${link.description}`
        : 'Paid online via payment link',
    });

    const paymentId = payment?._id || payment?.id;
    await PaymentLink.findByIdAndUpdate(link._id, {
      $set: { paymentId, updatedAt: new Date() },
    });

    return { matched: true, settled: true, paymentLinkId: String(link._id), paymentId: String(paymentId) };
  } catch (err) {
    /* The claim already succeeded, so the link now says `paid` while no Payment
       exists. Release it — leaving it claimed would make the money invisible
       AND unclaimable by Square's retry, which is the one outcome worse than a
       duplicate. */
    console.error('[paymentLinkService] settle failed after claim:', err.message);
    await PaymentLink.findByIdAndUpdate(link._id, {
      $set: {
        status: 'pending',
        emailError: `Payment received but could not be recorded: ${err.message}`,
        updatedAt: new Date(),
      },
      $unset: { paidAt: '', paidAmount: '', squarePaymentId: '' },
    });
    return { matched: true, settled: false, error: err.message };
  }
};

module.exports = {
  balanceFor,
  listLinks,
  getLink,
  createLink,
  resendLink,
  cancelLink,
  settleFromSquarePayment,
  expireStale,
  DEFAULT_EXPIRY_DAYS,
};
