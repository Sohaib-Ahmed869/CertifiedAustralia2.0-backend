const crypto = require('crypto');
const AppError = require('../utils/AppError');
const buildCrud = require('./commonCrud');
const { createSquarePayment } = require('./squareService');
const Payment = require('../models/Payment');
const PaymentPlan = require('../models/PaymentPlan');
const Application = require('../models/Application');
const { tryAutoStartTimer, shouldMarkPaymentIntake } = require('./applicationService');
const appEmails = require('./applicationEmailService');

const paymentCrud = buildCrud(Payment, {
  populate: ['applicationId', 'studentId', 'paymentPlanId', 'authorizedBy', 'approvedByMFA'],
});

const paymentPlanCrud = buildCrud(PaymentPlan, {
  populate: ['applicationId', 'studentId', 'createdBy'],
});

const refreshPlan = async (id) => {
  return PaymentPlan.findById(id).populate('applicationId studentId createdBy').lean();
};

const refreshPayment = async (id) => {
  return Payment.findById(id)
    .populate('applicationId studentId paymentPlanId authorizedBy approvedByMFA')
    .lean();
};

const createPaymentPlan = async (data) => {
  const application = await Application.findById(data.applicationId);

  if (!application) {
    throw new AppError('Application not found', 404);
  }

  const paymentPlan = await PaymentPlan.create({
    ...data,
    studentId: data.studentId || application.studentId,
    status: data.status || 'active',
  });

  application.paymentPlanId = paymentPlan._id;
  application.status = 'StudentIntakeForm';
  await application.save();

  const freshPlan = await refreshPlan(paymentPlan._id);

  // Notify student of new payment plan (non-blocking)
  const User = require('../models/User');
  User.findById(freshPlan.studentId?._id || freshPlan.studentId)
    .select('firstName email')
    .lean()
    .then((student) => {
      if (student?.email) {
        appEmails
          .sendPaymentPlanCreatedEmail(student, freshPlan.applicationId || application, freshPlan)
          .catch((err) => console.error('[PaymentService] sendPaymentPlanCreatedEmail error:', err.message));
      }
    })
    .catch((err) => console.error('[PaymentService] sendPaymentPlanCreatedEmail lookup error:', err.message));

  return freshPlan;
};

const allocateToPlan = async (paymentPlan, paymentId, amount) => {
  let remaining = Number(amount);

  // Iterate directly on paymentPlan.installments (Mongoose subdocuments) — NOT a spread copy
  // Sorting in-place by index to ensure sequential allocation
  const sorted = paymentPlan.installments.sort((a, b) => a.index - b.index);

  for (let i = 0; i < sorted.length; i++) {
    if (remaining <= 0) break;

    const installment = sorted[i];

    // Skip already-paid and skipped installments
    if (installment.status === 'paid' || installment.status === 'skipped') continue;

    const alreadyPaid = Number(installment.paidAmount || 0);
    const outstanding = Math.max(0, Number(installment.amount) - alreadyPaid);

    if (outstanding <= 0) {
      installment.status = 'paid';
      continue;
    }

    const applied = Math.min(outstanding, remaining);
    installment.paidAmount = alreadyPaid + applied;
    if (!installment.paymentIds) installment.paymentIds = [];
    installment.paymentIds.push(paymentId);
    remaining -= applied;

    if (installment.paidAmount >= installment.amount) {
      installment.status = 'paid';
      installment.paymentDate = new Date();
    } else {
      installment.status = 'partiallyPaid';
    }
  }

  paymentPlan.totalPaidAmount = Number(paymentPlan.totalPaidAmount || 0) + Number(amount - remaining);

  if (paymentPlan.totalPaidAmount >= paymentPlan.totalAmount) {
    paymentPlan.status = 'completed';
  }

  // Mark installments array as modified so Mongoose saves the changes
  paymentPlan.markModified('installments');

  return paymentPlan;
};

const createPaymentRecord = async (data) => {
  let squarePayment = null;

  if (data.paymentMethod === 'square') {
    squarePayment = await createSquarePayment({
      amount: data.amount,
      sourceId: data.squareSourceId,
      idempotencyKey: data.idempotencyKey || crypto.randomUUID(),
      note: data.notes || data.type,
    });
  }

  const payment = await Payment.create({
    ...data,
    status: data.status || 'completed',
    squareTransactionId: squarePayment?.id,
    squarePaymentId: squarePayment?.id,
    xeroSyncStatus: data.xeroSyncStatus || 'pending',
    xeroSyncedAt: data.xeroSyncedAt || null,
  });

  if (payment.applicationId) {
    const application = await Application.findById(payment.applicationId);

    if (application) {
      application.paymentIds = application.paymentIds || [];
      application.paymentIds.push(payment._id);

      /* Money in. Whether it settles installments is decided by WHETHER A PLAN
         EXISTS, not by the payment type — `type` records how the money arrived
         (upfront = paid in full, plan = an installment charge, manualMarkPaid =
         taken off-portal) and has to stay accurate for reporting and for the
         Payment History column, so it must not double as a control switch.
         Keying off the type meant a manual payment against a live plan settled
         no installment, left every row Pending, and flagged the whole
         application paymentCompleted regardless of how small it was. */
      if (['upfront', 'plan', 'manualMarkPaid'].includes(payment.type)) {
        let activePlan = null;

        if (application.paymentPlanId) {
          try {
            const planDoc = await PaymentPlan.findById(application.paymentPlanId);
            if (planDoc && planDoc.status !== 'cancelled') {
              await allocateToPlan(planDoc, payment._id, payment.amount);
              await planDoc.save();
              activePlan = planDoc;
            }
          } catch (err) {
            console.error('[PaymentService] Failed to allocate to plan:', err.message);
          }
        }

        if (activePlan) {
          // The plan is the authority on "is this paid off?" — one installment,
          // however it was collected, must never close out the application.
          application.partialPayment = true;
          if (activePlan.status === 'completed') application.paymentCompleted = true;
        } else if (payment.type === 'plan') {
          application.partialPayment = true;
        } else {
          application.paymentCompleted = true;
        }

        // Guarded: a final installment can land long after the student has moved
        // past intake. See shouldMarkPaymentIntake.
        if (application.paymentCompleted && shouldMarkPaymentIntake(application.status)) {
          application.status = 'StudentIntakeForm';
        }
      }

      await application.save();

      // Check if all 3 student obligations are met — auto-start 21-day timer
      await tryAutoStartTimer(application._id);
    }
  }

  const freshPayment = await refreshPayment(payment._id);

  // Send payment emails (non-blocking)
  if (freshPayment.status === 'completed') {
    const student = freshPayment.studentId;
    const application = freshPayment.applicationId;
    // Reflects what the money actually did, not what the type implies: a manual
    // payment against a live plan settles one installment, it doesn't close the sale.
    const isFullPayment =
      (freshPayment.type === 'upfront' || freshPayment.type === 'manualMarkPaid') &&
      freshPayment.applicationId?.paymentCompleted === true;

    if (student?.email && application?.applicationId) {
      if (freshPayment.type === 'manualMarkPaid') {
        // Manual mark paid — use the dedicated manual confirmation email
        appEmails
          .sendManualMarkPaidEmail(
            student,
            application,
            freshPayment.amount,
            freshPayment.manualPaymentReference || 'Manual'
          )
          .catch((err) => console.error('[PaymentService] sendManualMarkPaidEmail error:', err.message));
      } else {
        // Upfront / plan payment — standard receipt
        appEmails
          .sendPaymentReceivedEmail(student, application, freshPayment)
          .catch((err) => console.error('[PaymentService] sendPaymentReceivedEmail error:', err.message));
      }

      // Admin notification for all completed payments
      appEmails
        .sendAdminPaymentNotification(student, application, freshPayment, isFullPayment)
        .catch((err) => console.error('[PaymentService] sendAdminPaymentNotification error:', err.message));
    }
  }

  return freshPayment;
};

const applyPaymentToPlan = async (paymentPlanId, data) => {
  const paymentPlan = await PaymentPlan.findById(paymentPlanId);

  if (!paymentPlan) {
    throw new AppError('Payment plan not found', 404);
  }

  const payment = await Payment.create({
    applicationId: paymentPlan.applicationId,
    studentId: paymentPlan.studentId,
    paymentPlanId,
    amount: data.amount,
    type: data.type || 'plan',
    paymentMethod: data.paymentMethod || 'manual',
    status: data.status || 'completed',
    manualPaymentReference: data.manualPaymentReference,
    manualPaymentReason: data.manualPaymentReason,
    notes: data.notes,
    xeroSyncStatus: data.xeroSyncStatus || 'pending',
  });

  if (payment.paymentMethod === 'square') {
    const squarePayment = await createSquarePayment({
      amount: data.amount,
      sourceId: data.squareSourceId,
      idempotencyKey: data.idempotencyKey || crypto.randomUUID(),
      note: data.notes || data.type || 'plan payment',
    });

    payment.squareTransactionId = squarePayment.id;
    payment.squarePaymentId = squarePayment.id;
    await payment.save();
  }

  await allocateToPlan(paymentPlan, payment._id, data.amount);
  await paymentPlan.save();

  // Set payment flags based on plan completion status
  const paymentFlags = { partialPayment: true };
  if (paymentPlan.status === 'completed') {
    paymentFlags.paymentCompleted = true;
  }
  await Application.findByIdAndUpdate(paymentPlan.applicationId, paymentFlags);

  // Check if all 3 student obligations are met — auto-start 21-day timer
  await tryAutoStartTimer(paymentPlan.applicationId);

  // Notify student of payment received (non-fatal)
  if (payment.status === 'completed' && paymentPlan.studentId) {
    try {
      const { createNotification } = require('./notificationService');
      await createNotification({
        userId: paymentPlan.studentId,
        type: 'payment_received',
        title: 'Payment Received',
        message: `Your payment of $${Number(data.amount).toLocaleString('en-AU', { minimumFractionDigits: 2 })} has been received.`,
        link: '/student/payments',
        relatedId: paymentPlan.applicationId,
      });
    } catch (err) {
      console.error('[PaymentService] Failed to create notification:', err.message);
    }
  }

  const freshPaymentForPlan = await refreshPayment(payment._id);

  // Send payment receipt + admin notification (non-blocking)
  if (freshPaymentForPlan.status === 'completed') {
    const student = freshPaymentForPlan.studentId;
    const application = freshPaymentForPlan.applicationId;
    if (student?.email && application?.applicationId) {
      appEmails
        .sendPaymentReceivedEmail(student, application, freshPaymentForPlan)
        .catch((err) => console.error('[PaymentService] applyPaymentToPlan sendPaymentReceivedEmail error:', err.message));
      appEmails
        .sendAdminPaymentNotification(student, application, freshPaymentForPlan, false)
        .catch((err) => console.error('[PaymentService] applyPaymentToPlan sendAdminPaymentNotification error:', err.message));
    }
  }

  return {
    payment: freshPaymentForPlan,
    paymentPlan: await refreshPlan(paymentPlan._id),
  };
};

const updatePaymentPlan = async (id, data, actor = null) => {
  const paymentPlan = await PaymentPlan.findById(id);

  if (!paymentPlan) {
    throw new AppError('Payment plan not found', 404);
  }

  // Track whether direct debit is being enabled for the first time
  const directDebitJustEnabled =
    data.directDebitEnabled === true && !paymentPlan.directDebitEnabled;

  // ---- Installment reconciliation (merge-based; protects settled installments) ----
  // Rebuilds the schedule from the incoming rows while:
  //  - preserving already-paid / partially-paid installments verbatim (immutable),
  //  - treating a "skipped" row as a waived installment (dropped from the total owed),
  //  - recording a real manualMarkPaid payment when a pending row is set to "paid"
  //    (Completed) so totalPaidAmount / revenue reports / Xero stay consistent.
  let installmentsReconciled = false;
  const completedTransitions = [];

  if (Array.isArray(data.installments)) {
    const currentByIndex = new Map(
      paymentPlan.installments.map((installment) => [installment.index, installment])
    );

    const merged = [];

    data.installments.forEach((incoming, idx) => {
      const current = currentByIndex.get(incoming.index);
      const wasSettled =
        current && (current.status === 'paid' || current.status === 'partiallyPaid');

      // Settled installments cannot be changed — preserve the stored record as-is.
      if (wasSettled) {
        const sameAmount = Math.abs(Number(current.amount) - Number(incoming.amount)) < 0.01;
        const currentDate = current.dueDate ? new Date(current.dueDate).toISOString().slice(0, 10) : '';
        const newDate = incoming.dueDate ? new Date(incoming.dueDate).toISOString().slice(0, 10) : '';
        const incomingStatus = incoming.status || current.status;

        if (!sameAmount || currentDate !== newDate || incomingStatus !== current.status) {
          throw new AppError('Paid installments cannot be changed', 400);
        }

        merged.push({
          index: idx,
          amount: current.amount,
          dueDate: current.dueDate,
          status: current.status,
          paidAmount: current.paidAmount,
          paymentDate: current.paymentDate,
          paymentIds: current.paymentIds,
        });
        return;
      }

      const amount = Math.round(Number(incoming.amount || 0) * 100) / 100;
      const dueDate = incoming.dueDate ? new Date(incoming.dueDate) : current?.dueDate || new Date();
      const status = incoming.status || 'pending';

      if (status === 'paid') {
        // "Completed" chosen on a pending/new row — stage it as pending here and record
        // a proper payment against this exact installment below.
        completedTransitions.push(idx);
        merged.push({ index: idx, amount, dueDate, status: 'pending', paidAmount: 0, paymentIds: [] });
      } else {
        // 'pending' or 'skipped'
        merged.push({ index: idx, amount, dueDate, status, paidAmount: 0, paymentIds: [] });
      }
    });

    // Guard against over-scheduling (mirrors the legacy portal): the money still to be
    // collected (pending rows, incl. the ones about to be completed) must not exceed the
    // remaining balance. Prefer the caller's remaining (price − discount − paid, the same
    // basis the UI shows); fall back to the plan's own figures.
    const remainingBalance =
      data.remainingBalance != null
        ? Math.max(0, Number(data.remainingBalance))
        : Math.max(0, Number(paymentPlan.totalAmount || 0) - Number(paymentPlan.totalPaidAmount || 0));
    const scheduledTotal = merged
      .filter((m) => m.status === 'pending')
      .reduce((sum, m) => sum + Number(m.amount), 0);

    if (scheduledTotal > remainingBalance + 0.01) {
      throw new AppError('Pending payment schedule exceeds remaining balance. Reduce pending amounts before saving.', 400);
    }

    paymentPlan.installments = merged;
    paymentPlan.markModified('installments');

    // Record a manualMarkPaid payment for each "Completed" transition (targeted to the
    // specific installment, not sequentially allocated).
    for (const idx of completedTransitions) {
      const installment = paymentPlan.installments.find((m) => m.index === idx);
      if (!installment) continue;

      const payment = await Payment.create({
        applicationId: paymentPlan.applicationId,
        studentId: paymentPlan.studentId,
        paymentPlanId: paymentPlan._id,
        amount: installment.amount,
        type: 'manualMarkPaid',
        paymentMethod: 'manual',
        status: 'completed',
        notes: data.notes || 'Installment marked paid via payment plan edit',
        xeroSyncStatus: 'pending',
        ...(actor?.id ? { createdBy: actor.id } : {}),
      });

      installment.status = 'paid';
      installment.paidAmount = installment.amount;
      installment.paymentDate = new Date();
      installment.paymentIds = [payment._id];
      paymentPlan.totalPaidAmount = Number(paymentPlan.totalPaidAmount || 0) + Number(installment.amount);
    }
    if (completedTransitions.length) paymentPlan.markModified('installments');

    // Contract total = everything still owed or paid; skipped installments are waived off.
    paymentPlan.totalAmount = paymentPlan.installments
      .filter((m) => m.status !== 'skipped')
      .reduce((sum, m) => sum + Number(m.amount), 0);

    // Recompute plan status (mirrors the legacy portal): the plan is complete once no
    // pending/partially-paid installments remain — skipped rows are waived, not owed.
    const hasOutstanding = paymentPlan.installments.some(
      (m) => m.status === 'pending' || m.status === 'partiallyPaid'
    );
    if (!hasOutstanding) {
      paymentPlan.status = 'completed';
    } else if (paymentPlan.status === 'completed') {
      paymentPlan.status = 'active';
    }

    installmentsReconciled = true;
    // Don't let the generic Object.assign below clobber the reconciled schedule/totals.
    delete data.installments;
    delete data.totalAmount;
    delete data.totalPaidAmount;
    delete data.remainingBalance;
  }

  Object.assign(paymentPlan, data);
  await paymentPlan.save();

  // Keep the application in sync when installments were just marked paid.
  if (installmentsReconciled && completedTransitions.length) {
    try {
      const appFlags = { partialPayment: true };
      if (paymentPlan.status === 'completed') appFlags.paymentCompleted = true;
      await Application.findByIdAndUpdate(paymentPlan.applicationId, appFlags);
      await tryAutoStartTimer(paymentPlan.applicationId);
    } catch (err) {
      console.error('[PaymentService] updatePaymentPlan application sync error:', err.message);
    }
  }

  const freshUpdatedPlan = await refreshPlan(paymentPlan._id);

  // If direct debit was just enabled, send confirmation email (non-blocking)
  if (directDebitJustEnabled) {
    const User = require('../models/User');
    User.findById(freshUpdatedPlan.studentId?._id || freshUpdatedPlan.studentId)
      .select('firstName email')
      .lean()
      .then((student) => {
        if (student?.email && freshUpdatedPlan.applicationId?.applicationId) {
          appEmails
            .sendDirectDebitSetupEmail(student, freshUpdatedPlan.applicationId, freshUpdatedPlan)
            .catch((err) => console.error('[PaymentService] updatePaymentPlan sendDirectDebitSetupEmail error:', err.message));
        }
      })
      .catch((err) => console.error('[PaymentService] updatePaymentPlan student lookup error:', err.message));
  }

  return freshUpdatedPlan;
};

const getStats = async (query = {}) => {
  const now = new Date();
  const firstDayOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

  // Optional date-range scoping (dashboard date filter). When present, revenue
  // aggregations are limited to payments created within the range.
  const range = {};
  if (query.dateFrom) {
    const d = new Date(query.dateFrom);
    if (!isNaN(d.getTime())) { d.setHours(0, 0, 0, 0); range.$gte = d; }
  }
  if (query.dateTo) {
    const d = new Date(query.dateTo);
    if (!isNaN(d.getTime())) { d.setHours(23, 59, 59, 999); range.$lte = d; }
  }
  const rangeMatch = Object.keys(range).length
    ? { createdAt: range, isTest: { $ne: true }, isArchived: { $ne: true } }
    : { isTest: { $ne: true }, isArchived: { $ne: true } };

  const [
    revenueTotals,
    revenueByType,
    revenueThisMonth,
    refundTotal,
    overdueInstallments,
    rtoPayables,
  ] = await Promise.all([
    // Total revenue + outstanding (range-scoped)
    Payment.aggregate([
      { $match: rangeMatch },
      {
        $group: {
          _id: '$status',
          total: { $sum: '$amount' },
          count: { $sum: 1 },
        },
      },
    ]),

    // Revenue by payment type (completed only, range-scoped)
    Payment.aggregate([
      { $match: { status: 'completed', ...rangeMatch } },
      {
        $group: {
          _id: '$type',
          total: { $sum: '$amount' },
          count: { $sum: 1 },
        },
      },
      { $sort: { total: -1 } },
    ]),

    // Revenue this month (completed)
    Payment.aggregate([
      {
        $match: {
          status: 'completed',
          createdAt: { $gte: firstDayOfMonth },
          isTest: { $ne: true }, isArchived: { $ne: true },
        },
      },
      {
        $group: {
          _id: null,
          total: { $sum: '$amount' },
          count: { $sum: 1 },
        },
      },
    ]),

    // Total refunds (range-scoped)
    Payment.aggregate([
      { $match: { type: 'refund', ...rangeMatch } },
      {
        $group: {
          _id: null,
          total: { $sum: '$amount' },
          count: { $sum: 1 },
        },
      },
    ]),

    // Overdue installments (from PaymentPlan)
    PaymentPlan.aggregate([
      { $match: { isTest: { $ne: true }, isArchived: { $ne: true } } },
      { $unwind: '$installments' },
      {
        $match: {
          'installments.dueDate': { $lt: now },
          'installments.status': { $ne: 'paid' },
        },
      },
      {
        $group: {
          _id: null,
          count: { $sum: 1 },
          totalOutstanding: {
            $sum: {
              $subtract: [
                '$installments.amount',
                { $ifNull: ['$installments.paidAmount', 0] },
              ],
            },
          },
        },
      },
    ]),

    // RTO payables (rtoPayable or rtoPayment that are not completed, range-scoped)
    Payment.aggregate([
      {
        $match: {
          type: { $in: ['rtoPayable', 'rtoPayment'] },
          status: { $ne: 'completed' },
          ...rangeMatch,
        },
      },
      {
        $group: {
          _id: null,
          total: { $sum: '$amount' },
          count: { $sum: 1 },
        },
      },
    ]),
  ]);

  // Extract totals from aggregation results
  const statusMap = {};
  revenueTotals.forEach((r) => {
    statusMap[r._id] = { total: r.total, count: r.count };
  });

  const thisMonthData = revenueThisMonth[0] || { total: 0, count: 0 };
  const refundData = refundTotal[0] || { total: 0, count: 0 };
  const overdueData = overdueInstallments[0] || { count: 0, totalOutstanding: 0 };
  const rtoData = rtoPayables[0] || { total: 0, count: 0 };

  // Payment plan totals
  const [planTotals] = await Promise.all([
    PaymentPlan.aggregate([
      { $match: { isTest: { $ne: true }, isArchived: { $ne: true } } },
      {
        $group: {
          _id: null,
          planTotal: { $sum: '$totalAmount' },
          planPaid: { $sum: '$totalPaidAmount' },
          planCount: { $sum: 1 },
        },
      },
    ]),
  ]);

  const planData = planTotals[0] || { planTotal: 0, planPaid: 0, planCount: 0 };

  // Build per-type lookup from revenueByType aggregation
  const typeMap = {};
  revenueByType.forEach((r) => {
    typeMap[r._id] = { total: r.total, count: r.count };
  });

  return {
    totalRevenue: (statusMap.completed || { total: 0 }).total,
    outstandingBalance: (statusMap.pending || { total: 0 }).total,
    completedCount: (statusMap.completed || { count: 0 }).count,
    pendingCount: (statusMap.pending || { count: 0 }).count,
    revenueByType: revenueByType.map((r) => ({
      type: r._id,
      total: r.total,
      count: r.count,
    })),
    // Per-type totals for dashboard KPIs
    manualTotal: (typeMap.manualMarkPaid || { total: 0 }).total,
    manualCount: (typeMap.manualMarkPaid || { count: 0 }).count,
    upfrontTotal: (typeMap.upfront || { total: 0 }).total,
    upfrontCount: (typeMap.upfront || { count: 0 }).count,
    discountTotal: (typeMap.discount || { total: 0 }).total,
    discountCount: (typeMap.discount || { count: 0 }).count,
    revenueThisMonth: thisMonthData.total,
    revenueThisMonthCount: thisMonthData.count,
    totalRefunds: refundData.total,
    totalRefundCount: refundData.count,
    overdueInstallments: overdueData.count,
    overdueOutstanding: overdueData.totalOutstanding,
    rtoPayables: rtoData.total,
    rtoPayablesCount: rtoData.count,
    planTotal: planData.planTotal,
    planOutstanding: planData.planTotal - planData.planPaid,
    planCount: planData.planCount,
  };
};

const exportCsv = async (filters) => {
  const query = { isTest: { $ne: true }, isArchived: { $ne: true } };

  if (filters.status) {
    query.status = filters.status;
  }
  if (filters.type) {
    query.type = filters.type;
  }
  if (filters.dateFrom || filters.dateTo) {
    query.createdAt = {};
    if (filters.dateFrom) {
      query.createdAt.$gte = new Date(filters.dateFrom);
    }
    if (filters.dateTo) {
      query.createdAt.$lte = new Date(filters.dateTo);
    }
  }

  const payments = await Payment.find(query)
    .populate('applicationId', 'applicationId')
    .populate('studentId', 'firstName lastName email')
    .lean();

  return payments.map((p) => {
    const student = p.studentId || {};
    const application = p.applicationId || {};

    return {
      paymentId: p._id.toString(),
      applicationId: application.applicationId || '',
      studentName: `${student.firstName || ''} ${student.lastName || ''}`.trim(),
      type: p.type,
      method: p.paymentMethod,
      amount: p.amount,
      status: p.status,
      createdAt: p.createdAt,
    };
  });
};

const pausePlan = async (planId) => {
  const plan = await PaymentPlan.findById(planId);

  if (!plan) {
    throw new AppError('Payment plan not found', 404);
  }

  if (plan.status === 'paused') {
    throw new AppError('Payment plan is already paused', 400);
  }

  if (plan.status !== 'active') {
    throw new AppError(`Cannot pause a plan with status "${plan.status}"`, 400);
  }

  plan.status = 'paused';
  plan.pausedAt = new Date();
  await plan.save();

  const freshPausedPlan = await refreshPlan(plan._id);

  // Notify student that plan is paused (non-blocking)
  const User = require('../models/User');
  User.findById(freshPausedPlan.studentId?._id || freshPausedPlan.studentId)
    .select('firstName email')
    .lean()
    .then((student) => {
      if (student?.email && freshPausedPlan.applicationId?.applicationId) {
        appEmails
          .sendPaymentPlanStatusEmail(student, freshPausedPlan.applicationId, freshPausedPlan, 'paused')
          .catch((err) => console.error('[PaymentService] pausePlan sendPaymentPlanStatusEmail error:', err.message));
      }
    })
    .catch((err) => console.error('[PaymentService] pausePlan student lookup error:', err.message));

  return freshPausedPlan;
};

const resumePlan = async (planId) => {
  const plan = await PaymentPlan.findById(planId);

  if (!plan) {
    throw new AppError('Payment plan not found', 404);
  }

  if (plan.status === 'active') {
    throw new AppError('Payment plan is already active', 400);
  }

  if (plan.status !== 'paused') {
    throw new AppError(`Cannot resume a plan with status "${plan.status}"`, 400);
  }

  plan.status = 'active';
  plan.pausedAt = null;
  await plan.save();

  const freshResumedPlan = await refreshPlan(plan._id);

  // Notify student that plan is resumed (non-blocking)
  const User = require('../models/User');
  User.findById(freshResumedPlan.studentId?._id || freshResumedPlan.studentId)
    .select('firstName email')
    .lean()
    .then((student) => {
      if (student?.email && freshResumedPlan.applicationId?.applicationId) {
        appEmails
          .sendPaymentPlanStatusEmail(student, freshResumedPlan.applicationId, freshResumedPlan, 'resumed')
          .catch((err) => console.error('[PaymentService] resumePlan sendPaymentPlanStatusEmail error:', err.message));
      }
    })
    .catch((err) => console.error('[PaymentService] resumePlan student lookup error:', err.message));

  return freshResumedPlan;
};

const cancelPlan = async (planId) => {
  const plan = await PaymentPlan.findById(planId);

  if (!plan) {
    throw new AppError('Payment plan not found', 404);
  }

  if (plan.status === 'cancelled') {
    throw new AppError('Payment plan is already cancelled', 400);
  }

  if (plan.status === 'completed') {
    throw new AppError('Cannot cancel a completed plan', 400);
  }

  plan.status = 'cancelled';

  for (const installment of plan.installments) {
    if (installment.status === 'pending') {
      installment.status = 'cancelled';
    }
  }

  await plan.save();

  const freshCancelledPlan = await refreshPlan(plan._id);

  // Notify student that plan is cancelled (non-blocking)
  const User = require('../models/User');
  User.findById(freshCancelledPlan.studentId?._id || freshCancelledPlan.studentId)
    .select('firstName email')
    .lean()
    .then((student) => {
      if (student?.email && freshCancelledPlan.applicationId?.applicationId) {
        appEmails
          .sendPaymentPlanStatusEmail(student, freshCancelledPlan.applicationId, freshCancelledPlan, 'cancelled')
          .catch((err) => console.error('[PaymentService] cancelPlan sendPaymentPlanStatusEmail error:', err.message));
      }
    })
    .catch((err) => console.error('[PaymentService] cancelPlan student lookup error:', err.message));

  return freshCancelledPlan;
};

const skipInstallment = async (planId, installmentIndex) => {
  const plan = await PaymentPlan.findById(planId);

  if (!plan) {
    throw new AppError('Payment plan not found', 404);
  }

  if (plan.status !== 'active' && plan.status !== 'paused') {
    throw new AppError(`Cannot skip installment on a plan with status "${plan.status}"`, 400);
  }

  const index = Number(installmentIndex);
  const installment = plan.installments.find((inst) => inst.index === index);

  if (!installment) {
    throw new AppError(`Installment at index ${index} not found`, 404);
  }

  if (installment.status !== 'pending') {
    throw new AppError(
      `Cannot skip installment with status "${installment.status}". Only pending installments can be skipped`,
      400
    );
  }

  installment.status = 'skipped';
  await plan.save();

  return refreshPlan(plan._id);
};

// Fold a discount change into an existing plan by re-splitting the pending balance
// evenly across the still-unpaid installments. Called when a discount is added to or
// removed from an application that already has a payment plan.
//   discountDelta > 0  → a discount was applied  (lower the pending total)
//   discountDelta < 0  → a discount was removed   (raise the pending total)
// Only fully-unpaid ('pending') installments are touched — paid, partially-paid and
// skipped rows are immutable, matching updatePaymentPlan's settled-row rule. The
// rounding remainder lands on the last pending row (same as how plans are first split)
// and the contract total is recomputed. No-ops safely when there is nothing to rebalance.
const redistributePendingForDiscount = async (planId, discountDelta) => {
  const delta = Number(discountDelta) || 0;
  if (!planId || !delta) return null;

  const plan = await PaymentPlan.findById(planId);
  if (!plan) return null;
  // Never rewrite a cancelled plan; completed plans have no pending rows and no-op below.
  if (plan.status === 'cancelled') return null;

  const pending = plan.installments
    .filter((inst) => inst.status === 'pending')
    .sort((a, b) => a.index - b.index);
  if (pending.length === 0) return null; // no unpaid installments to absorb the change

  const currentPendingTotal = pending.reduce((sum, inst) => sum + Number(inst.amount || 0), 0);
  // Applying a discount lowers the pending total; removing one raises it. Never below 0.
  const newPendingTotal = Math.max(0, +(currentPendingTotal - delta).toFixed(2));

  const perInstallment = Math.floor((newPendingTotal / pending.length) * 100) / 100;
  const lastAdj = Math.round((newPendingTotal - perInstallment * (pending.length - 1)) * 100) / 100;
  pending.forEach((inst, i) => {
    inst.amount = i === pending.length - 1 ? lastAdj : perInstallment;
  });

  // Track the net discount actually reflected on the plan (clamped by what pending could
  // absorb), on the pre-existing informational field.
  const appliedDelta = +(currentPendingTotal - newPendingTotal).toFixed(2);
  plan.discountApplied = Math.max(0, +(Number(plan.discountApplied || 0) + appliedDelta).toFixed(2));

  // Contract total = everything still owed or paid; skipped rows are waived.
  plan.totalAmount = plan.installments
    .filter((inst) => inst.status !== 'skipped')
    .reduce((sum, inst) => sum + Number(inst.amount || 0), 0);

  plan.markModified('installments');
  await plan.save();
  return plan;
};

module.exports = {
  payments: paymentCrud,
  paymentPlans: paymentPlanCrud,
  createPaymentRecord,
  createPaymentPlan,
  applyPaymentToPlan,
  updatePaymentPlan,
  pausePlan,
  resumePlan,
  cancelPlan,
  skipInstallment,
  redistributePendingForDiscount,
  getStats,
  exportCsv,
};
