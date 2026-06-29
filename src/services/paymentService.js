const crypto = require('crypto');
const AppError = require('../utils/AppError');
const buildCrud = require('./commonCrud');
const { createSquarePayment } = require('./squareService');
const Payment = require('../models/Payment');
const PaymentPlan = require('../models/PaymentPlan');
const Application = require('../models/Application');
const { tryAutoStartTimer } = require('./applicationService');
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

      if (payment.type === 'upfront' || payment.type === 'manualMarkPaid') {
        // Full payment in one go
        application.paymentCompleted = true;
        application.status = 'StudentIntakeForm';
      } else if (payment.type === 'plan') {
        // Plan installment — allocate to plan installments
        application.partialPayment = true;

        // Auto-allocate to the payment plan if one exists
        if (application.paymentPlanId) {
          try {
            const planDoc = await PaymentPlan.findById(application.paymentPlanId);
            if (planDoc && planDoc.status !== 'cancelled') {
              await allocateToPlan(planDoc, payment._id, payment.amount);
              await planDoc.save();

              // If plan is now completed, mark application as fully paid
              if (planDoc.status === 'completed') {
                application.paymentCompleted = true;
                application.status = 'StudentIntakeForm';
              }
            }
          } catch (err) {
            console.error('[PaymentService] Failed to allocate to plan:', err.message);
          }
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
    const isFullPayment =
      freshPayment.type === 'upfront' ||
      freshPayment.type === 'manualMarkPaid';

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

const updatePaymentPlan = async (id, data) => {
  const paymentPlan = await PaymentPlan.findById(id);

  if (!paymentPlan) {
    throw new AppError('Payment plan not found', 404);
  }

  // Track whether direct debit is being enabled for the first time
  const directDebitJustEnabled =
    data.directDebitEnabled === true && !paymentPlan.directDebitEnabled;

  if (Array.isArray(data.installments)) {
    const currentByIndex = new Map(paymentPlan.installments.map((installment) => [installment.index, installment]));

    for (const installment of data.installments) {
      const current = currentByIndex.get(installment.index);

      if (current && current.status === 'paid') {
        const sameAmount = Math.abs(Number(current.amount) - Number(installment.amount)) < 0.01;
        // Compare dates by day only — ignore time/format differences
        const currentDate = current.dueDate ? new Date(current.dueDate).toISOString().slice(0, 10) : '';
        const newDate = installment.dueDate ? new Date(installment.dueDate).toISOString().slice(0, 10) : '';
        const sameDueDate = currentDate === newDate;

        if (!sameAmount || !sameDueDate) {
          throw new AppError('Paid installments cannot be changed', 400);
        }
      }
    }
  }

  Object.assign(paymentPlan, data);
  await paymentPlan.save();

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

const getStats = async () => {
  const now = new Date();
  const firstDayOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

  const [
    revenueTotals,
    revenueByType,
    revenueThisMonth,
    refundTotal,
    overdueInstallments,
    rtoPayables,
  ] = await Promise.all([
    // Total revenue + outstanding
    Payment.aggregate([
      {
        $group: {
          _id: '$status',
          total: { $sum: '$amount' },
          count: { $sum: 1 },
        },
      },
    ]),

    // Revenue by payment type (completed only)
    Payment.aggregate([
      { $match: { status: 'completed' } },
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

    // Total refunds
    Payment.aggregate([
      { $match: { type: 'refund' } },
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

    // RTO payables (rtoPayable or rtoPayment that are not completed)
    Payment.aggregate([
      {
        $match: {
          type: { $in: ['rtoPayable', 'rtoPayment'] },
          status: { $ne: 'completed' },
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
  const query = {};

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
  getStats,
  exportCsv,
};
