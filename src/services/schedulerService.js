const cron = require('node-cron');
const PaymentPlan = require('../models/PaymentPlan');
const Payment = require('../models/Payment');
const Application = require('../models/Application');
const Notification = require('../models/Notification');
const { createSquarePayment } = require('./squareService');
const { sendTemplatedEmail } = require('./emailService');
const crypto = require('crypto');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const DEBIT_SCHEDULE = '0 6 * * *'; // Every day at 6:00 AM (server time)
const REMINDER_SCHEDULE = '0 9 * * *'; // Every day at 9:00 AM
const REMINDER_DAYS_BEFORE = 3; // Send reminder 3 days before due date
const MAX_RETRY_ATTEMPTS = 3;

// ---------------------------------------------------------------------------
// Auto-debit processor
// ---------------------------------------------------------------------------

/**
 * Find all active payment plans with installments due today or overdue,
 * where direct debit is enabled, and attempt to process them via Square.
 */
const processDueInstallments = async () => {
  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const endOfDay = new Date(startOfDay);
  endOfDay.setDate(endOfDay.getDate() + 1);

  console.log('[Scheduler] Processing due installments for', startOfDay.toISOString().slice(0, 10));

  try {
    // Find active plans with direct debit enabled and pending/overdue installments
    const plans = await PaymentPlan.find({
      status: 'active',
      directDebitEnabled: true,
      'installments.status': { $in: ['pending', 'partiallyPaid'] },
      'installments.dueDate': { $lte: endOfDay },
    }).populate('studentId', 'firstName lastName email');

    let processed = 0;
    let succeeded = 0;
    let failed = 0;

    for (const plan of plans) {
      const dueInstallments = plan.installments.filter(
        (inst) =>
          (inst.status === 'pending' || inst.status === 'partiallyPaid') &&
          inst.dueDate <= endOfDay
      );

      for (const installment of dueInstallments) {
        const outstanding = installment.amount - (installment.paidAmount || 0);
        if (outstanding <= 0) continue;

        processed++;
        const result = await processAutoDebit(plan, installment, outstanding);

        if (result.success) {
          succeeded++;
        } else {
          failed++;
        }
      }
    }

    console.log(
      `[Scheduler] Auto-debit complete: ${processed} processed, ${succeeded} succeeded, ${failed} failed`
    );

    return { processed, succeeded, failed };
  } catch (err) {
    console.error('[Scheduler] Auto-debit batch error:', err.message);
    return { processed: 0, succeeded: 0, failed: 0, error: err.message };
  }
};

/**
 * Process a single auto-debit for one installment.
 */
const processAutoDebit = async (plan, installment, amount) => {
  const student = plan.studentId;
  const studentName = student
    ? `${student.firstName || ''} ${student.lastName || ''}`.trim()
    : 'Student';

  try {
    // Use direct debit source via Square (card-on-file or saved payment method)
    const squarePayment = await createSquarePayment({
      amount,
      sourceId: plan.directDebitAccountDetails?.squareCardId || 'cnon:card-nonce-ok', // fallback for sandbox
      idempotencyKey: crypto.randomUUID(),
      note: `Auto-debit: Plan installment #${installment.index + 1} for ${studentName}`,
    });

    // Create payment record
    const payment = await Payment.create({
      applicationId: plan.applicationId,
      studentId: plan.studentId._id || plan.studentId,
      paymentPlanId: plan._id,
      installmentIndex: installment.index,
      amount,
      type: 'plan',
      paymentMethod: 'directDebit',
      status: 'completed',
      squareTransactionId: squarePayment.id,
      squarePaymentId: squarePayment.id,
      notes: `Auto-debit processed on ${new Date().toISOString().slice(0, 10)}`,
      xeroSyncStatus: 'pending',
    });

    // Update installment status
    installment.paidAmount = (installment.paidAmount || 0) + amount;
    installment.paymentIds = installment.paymentIds || [];
    installment.paymentIds.push(payment._id);

    if (installment.paidAmount >= installment.amount) {
      installment.status = 'paid';
      installment.paymentDate = new Date();
    } else {
      installment.status = 'partiallyPaid';
    }

    // Update plan totals
    plan.totalPaidAmount = (plan.totalPaidAmount || 0) + amount;
    if (plan.totalPaidAmount >= plan.totalAmount) {
      plan.status = 'completed';
    }
    await plan.save();

    // Link payment to application
    const application = await Application.findById(plan.applicationId);
    if (application) {
      application.paymentIds = application.paymentIds || [];
      application.paymentIds.push(payment._id);
      await application.save();
    }

    // Send success notification
    await Notification.create({
      userId: plan.studentId._id || plan.studentId,
      type: 'payment_received',
      title: 'Payment Processed',
      message: `Your installment #${installment.index + 1} of $${amount.toFixed(2)} has been automatically processed.`,
      link: '/student/payments',
      relatedId: payment._id,
    });

    // Send confirmation email
    if (student?.email) {
      await sendTemplatedEmail({
        to: student.email,
        subject: 'Payment Processed - Certified Australia',
        preheader: `Installment #${installment.index + 1} of $${amount.toFixed(2)} processed`,
        templateContent: `
          <h2 style="margin:0 0 16px 0;color:#0a9d42;">Payment Confirmation</h2>
          <p>Hi ${student.firstName || 'there'},</p>
          <p>Your scheduled payment has been successfully processed:</p>
          <table role="presentation" style="width:100%;border-collapse:collapse;margin:16px 0;">
            <tr><td style="padding:8px 0;color:#6b7280;">Installment</td><td style="padding:8px 0;font-weight:600;">#${installment.index + 1}</td></tr>
            <tr><td style="padding:8px 0;color:#6b7280;">Amount</td><td style="padding:8px 0;font-weight:600;">$${amount.toFixed(2)} AUD</td></tr>
            <tr><td style="padding:8px 0;color:#6b7280;">Date</td><td style="padding:8px 0;font-weight:600;">${new Date().toLocaleDateString('en-AU')}</td></tr>
          </table>
          <p>Log in to your portal to view your payment history.</p>
        `,
        ctaText: 'View Payments',
        ctaUrl: `${process.env.APP_BASE_URL || 'http://localhost:5173'}/student/payments`,
      }).catch((err) => console.error('[Scheduler] Email send error:', err.message));
    }

    console.log(
      `[Scheduler] Auto-debit success: Plan ${plan._id}, installment #${installment.index + 1}, $${amount.toFixed(2)}`
    );

    return { success: true, paymentId: payment._id };
  } catch (err) {
    console.error(
      `[Scheduler] Auto-debit failed: Plan ${plan._id}, installment #${installment.index + 1}:`,
      err.message
    );

    // Send failure notification
    await Notification.create({
      userId: plan.studentId._id || plan.studentId,
      type: 'payment_received',
      title: 'Payment Failed',
      message: `Your scheduled payment of $${amount.toFixed(2)} for installment #${installment.index + 1} could not be processed. Please update your payment method.`,
      link: '/student/payments',
      relatedId: plan._id,
    });

    // Notify admins about the failure
    const User = require('../models/User');
    const admins = await User.find(
      { role: { $in: ['Admin', 'CEOReportingManager'] }, status: 'active' },
      '_id'
    ).lean();

    for (const admin of admins) {
      await Notification.create({
        userId: admin._id,
        type: 'payment_received',
        title: 'Auto-Debit Failed',
        message: `Auto-debit failed for ${studentName} — installment #${installment.index + 1}, $${amount.toFixed(2)}. Reason: ${err.message}`,
        link: `/admin/payments`,
        relatedId: plan._id,
      });
    }

    return { success: false, error: err.message };
  }
};

// ---------------------------------------------------------------------------
// Payment reminder processor
// ---------------------------------------------------------------------------

/**
 * Send reminders for installments coming due in REMINDER_DAYS_BEFORE days.
 */
const sendPaymentReminders = async () => {
  const now = new Date();
  const reminderDate = new Date(now);
  reminderDate.setDate(reminderDate.getDate() + REMINDER_DAYS_BEFORE);

  const startOfReminderDay = new Date(
    reminderDate.getFullYear(),
    reminderDate.getMonth(),
    reminderDate.getDate()
  );
  const endOfReminderDay = new Date(startOfReminderDay);
  endOfReminderDay.setDate(endOfReminderDay.getDate() + 1);

  console.log(
    '[Scheduler] Sending payment reminders for due date:',
    startOfReminderDay.toISOString().slice(0, 10)
  );

  try {
    const plans = await PaymentPlan.find({
      status: 'active',
      'installments.status': 'pending',
      'installments.dueDate': { $gte: startOfReminderDay, $lt: endOfReminderDay },
    }).populate('studentId', 'firstName lastName email');

    let sent = 0;

    for (const plan of plans) {
      const upcomingInstallments = plan.installments.filter(
        (inst) =>
          inst.status === 'pending' &&
          inst.dueDate >= startOfReminderDay &&
          inst.dueDate < endOfReminderDay
      );

      for (const installment of upcomingInstallments) {
        const student = plan.studentId;
        if (!student?.email) continue;

        const outstanding = installment.amount - (installment.paidAmount || 0);
        if (outstanding <= 0) continue;

        const dueDate = new Date(installment.dueDate).toLocaleDateString('en-AU');

        // In-portal notification
        await Notification.create({
          userId: student._id,
          type: 'payment_received',
          title: 'Upcoming Payment',
          message: `Your installment #${installment.index + 1} of $${outstanding.toFixed(2)} is due on ${dueDate}.`,
          link: '/student/payments',
          relatedId: plan._id,
        });

        // Email reminder
        await sendTemplatedEmail({
          to: student.email,
          subject: 'Payment Reminder - Certified Australia',
          preheader: `Installment of $${outstanding.toFixed(2)} due on ${dueDate}`,
          templateContent: `
            <h2 style="margin:0 0 16px 0;color:#0a9d42;">Payment Reminder</h2>
            <p>Hi ${student.firstName || 'there'},</p>
            <p>This is a friendly reminder that you have an upcoming payment:</p>
            <table role="presentation" style="width:100%;border-collapse:collapse;margin:16px 0;">
              <tr><td style="padding:8px 0;color:#6b7280;">Installment</td><td style="padding:8px 0;font-weight:600;">#${installment.index + 1}</td></tr>
              <tr><td style="padding:8px 0;color:#6b7280;">Amount Due</td><td style="padding:8px 0;font-weight:600;">$${outstanding.toFixed(2)} AUD</td></tr>
              <tr><td style="padding:8px 0;color:#6b7280;">Due Date</td><td style="padding:8px 0;font-weight:600;">${dueDate}</td></tr>
            </table>
            ${plan.directDebitEnabled
              ? '<p>This payment will be automatically debited from your saved payment method.</p>'
              : '<p>Please log in to your portal to make your payment before the due date.</p>'
            }
          `,
          ctaText: 'View Payment Plan',
          ctaUrl: `${process.env.APP_BASE_URL || 'http://localhost:5173'}/student/payments`,
        }).catch((err) => console.error('[Scheduler] Reminder email error:', err.message));

        sent++;
      }
    }

    console.log(`[Scheduler] Payment reminders sent: ${sent}`);
    return { sent };
  } catch (err) {
    console.error('[Scheduler] Payment reminder batch error:', err.message);
    return { sent: 0, error: err.message };
  }
};

// ---------------------------------------------------------------------------
// Overdue installment flagging
// ---------------------------------------------------------------------------

/**
 * Flag overdue installments and notify admins about them.
 */
const flagOverdueInstallments = async () => {
  const now = new Date();

  try {
    const plans = await PaymentPlan.find({
      status: 'active',
      'installments.status': { $in: ['pending', 'partiallyPaid'] },
      'installments.dueDate': { $lt: now },
    })
      .populate('studentId', 'firstName lastName email')
      .populate('applicationId', 'applicationId');

    let flagged = 0;

    for (const plan of plans) {
      const overdueInstallments = plan.installments.filter(
        (inst) =>
          (inst.status === 'pending' || inst.status === 'partiallyPaid') &&
          inst.dueDate < now
      );

      if (overdueInstallments.length === 0) continue;

      const student = plan.studentId;
      const studentName = student
        ? `${student.firstName || ''} ${student.lastName || ''}`.trim()
        : 'Unknown';
      const appId = plan.applicationId?.applicationId || 'N/A';

      // Notify admins
      const User = require('../models/User');
      const admins = await User.find(
        { role: { $in: ['Admin', 'CEOReportingManager'] }, status: 'active' },
        '_id'
      ).lean();

      for (const admin of admins) {
        await Notification.create({
          userId: admin._id,
          type: 'payment_received',
          title: 'Overdue Payment',
          message: `${studentName} (${appId}) has ${overdueInstallments.length} overdue installment(s).`,
          link: '/admin/payments',
          relatedId: plan._id,
        });
      }

      flagged += overdueInstallments.length;
    }

    console.log(`[Scheduler] Overdue installments flagged: ${flagged}`);
    return { flagged };
  } catch (err) {
    console.error('[Scheduler] Overdue flagging error:', err.message);
    return { flagged: 0, error: err.message };
  }
};

// ---------------------------------------------------------------------------
// Application reminder processor
// ---------------------------------------------------------------------------

// Stale thresholds (days since last update with no progress)
const STALE_LEAD_DAYS = 3; // New applications with no contact
const INCOMPLETE_INTAKE_DAYS = 7; // Paid but intake not complete
const PENDING_DOCUMENTS_DAYS = 5; // Intake done but documents not submitted
const FOLLOW_UP_REMINDER_HOURS = 1; // Remind agent 1 hour before scheduled follow-up

/**
 * Send reminders for stale/incomplete applications.
 * Runs daily — targets agents and students based on application state.
 */
const sendApplicationReminders = async () => {
  const now = new Date();
  console.log('[Scheduler] Processing application reminders...');

  const User = require('../models/User');
  let sent = 0;

  try {
    // ── 1. Stale leads — no contact in STALE_LEAD_DAYS ─────────────────
    const staleLeadCutoff = new Date(now);
    staleLeadCutoff.setDate(staleLeadCutoff.getDate() - STALE_LEAD_DAYS);

    const staleLeads = await Application.find({
      status: 'New',
      assignedAgentId: { $exists: true, $ne: null },
      contactAttempts: { $lt: 1 },
      updatedAt: { $lt: staleLeadCutoff },
    })
      .populate('studentId', 'firstName lastName email')
      .populate('assignedAgentId', 'firstName lastName email')
      .lean();

    for (const app of staleLeads) {
      const agent = app.assignedAgentId;
      if (!agent?._id) continue;

      const studentName = app.studentId
        ? `${app.studentId.firstName || ''} ${app.studentId.lastName || ''}`.trim()
        : 'Unknown';

      await Notification.create({
        userId: agent._id,
        type: 'application_assigned',
        title: 'Stale Lead Reminder',
        message: `${studentName} (${app.applicationId}) has had no contact for ${STALE_LEAD_DAYS}+ days. Please reach out.`,
        link: `/admin/applications/${app._id}`,
        relatedId: app._id,
      });
      sent++;
    }

    // ── 2. Incomplete intake — paid but intake not done ─────────────────
    const incompleteIntakeCutoff = new Date(now);
    incompleteIntakeCutoff.setDate(incompleteIntakeCutoff.getDate() - INCOMPLETE_INTAKE_DAYS);

    const incompleteIntakes = await Application.find({
      status: 'StudentIntakeForm',
      intakeFormId: { $exists: false },
      updatedAt: { $lt: incompleteIntakeCutoff },
    })
      .populate('studentId', 'firstName lastName email')
      .lean();

    for (const app of incompleteIntakes) {
      const student = app.studentId;
      if (!student?.email) continue;

      // Notify student
      await Notification.create({
        userId: student._id,
        type: 'status_changed',
        title: 'Complete Your Intake Form',
        message: `Your application ${app.applicationId} is waiting for your intake form. Please complete it to proceed.`,
        link: '/student/intake',
        relatedId: app._id,
      });

      await sendTemplatedEmail({
        to: student.email,
        subject: 'Action Required: Complete Your Intake Form - Certified Australia',
        preheader: 'Your intake form is pending',
        templateContent: `
          <h2 style="margin:0 0 16px 0;color:#0a9d42;">Intake Form Reminder</h2>
          <p>Hi ${student.firstName || 'there'},</p>
          <p>Your application <strong>${app.applicationId}</strong> has been paid, but we're still waiting for your intake form.</p>
          <p>Please complete it as soon as possible so we can move forward with your RPL assessment.</p>
        `,
        ctaText: 'Complete Intake Form',
        ctaUrl: `${process.env.APP_BASE_URL || 'http://localhost:5173'}/student/intake`,
      }).catch((err) => console.error('[Scheduler] Intake reminder email error:', err.message));

      sent++;
    }

    // ── 3. Pending documents — intake done but docs missing ─────────────
    const pendingDocsCutoff = new Date(now);
    pendingDocsCutoff.setDate(pendingDocsCutoff.getDate() - PENDING_DOCUMENTS_DAYS);

    const pendingDocs = await Application.find({
      status: 'UploadDocuments',
      updatedAt: { $lt: pendingDocsCutoff },
    })
      .populate('studentId', 'firstName lastName email')
      .lean();

    for (const app of pendingDocs) {
      const student = app.studentId;
      if (!student?.email) continue;

      await Notification.create({
        userId: student._id,
        type: 'status_changed',
        title: 'Submit Your Documents',
        message: `Your application ${app.applicationId} needs supporting documents. Please upload them to continue.`,
        link: '/student/documents',
        relatedId: app._id,
      });

      await sendTemplatedEmail({
        to: student.email,
        subject: 'Action Required: Upload Documents - Certified Australia',
        preheader: 'We need your supporting documents',
        templateContent: `
          <h2 style="margin:0 0 16px 0;color:#0a9d42;">Document Upload Reminder</h2>
          <p>Hi ${student.firstName || 'there'},</p>
          <p>Your intake form for <strong>${app.applicationId}</strong> is complete — great work!</p>
          <p>The next step is to upload your supporting documents (evidence of prior learning, qualifications, work references, etc.).</p>
          <p>Please submit them so we can begin the assessment process.</p>
        `,
        ctaText: 'Upload Documents',
        ctaUrl: `${process.env.APP_BASE_URL || 'http://localhost:5173'}/student/documents`,
      }).catch((err) => console.error('[Scheduler] Document reminder email error:', err.message));

      sent++;
    }

    // ── 4. Upcoming follow-up calls — remind agent ──────────────────────
    const followUpStart = new Date(now);
    const followUpEnd = new Date(now);
    followUpEnd.setHours(followUpEnd.getHours() + 2); // Next 2 hours

    const appsWithFollowUps = await Application.find({
      'followUpCalls.scheduledFor': { $gte: followUpStart, $lt: followUpEnd },
      'followUpCalls.completedAt': { $exists: false },
      assignedAgentId: { $exists: true, $ne: null },
    })
      .populate('studentId', 'firstName lastName')
      .populate('assignedAgentId', '_id firstName lastName')
      .lean();

    for (const app of appsWithFollowUps) {
      const agent = app.assignedAgentId;
      if (!agent?._id) continue;

      const upcomingCalls = (app.followUpCalls || []).filter(
        (c) => !c.completedAt && c.scheduledFor >= followUpStart && c.scheduledFor < followUpEnd
      );

      for (const call of upcomingCalls) {
        const studentName = app.studentId
          ? `${app.studentId.firstName || ''} ${app.studentId.lastName || ''}`.trim()
          : 'Student';
        const callTime = new Date(call.scheduledFor).toLocaleTimeString('en-AU', {
          hour: '2-digit', minute: '2-digit',
        });

        await Notification.create({
          userId: agent._id,
          type: 'general',
          title: 'Upcoming Follow-Up Call',
          message: `You have a follow-up call with ${studentName} (${app.applicationId}) scheduled at ${callTime}.`,
          link: `/admin/applications/${app._id}`,
          relatedId: app._id,
        });
        sent++;
      }
    }

    // ── 5. Resubmission pending — student hasn't resubmitted ────────────
    const resubCutoff = new Date(now);
    resubCutoff.setDate(resubCutoff.getDate() - 3); // 3 days since resubmission request

    const resubApps = await Application.find({
      status: 'UploadDocuments',
      updatedAt: { $lt: resubCutoff },
    })
      .populate('studentId', 'firstName lastName email')
      .lean();

    for (const app of resubApps) {
      const student = app.studentId;
      if (!student?.email) continue;

      await Notification.create({
        userId: student._id,
        type: 'status_changed',
        title: 'Resubmission Required',
        message: `Your application ${app.applicationId} has a pending resubmission request. Please address the feedback and resubmit.`,
        link: '/student/documents',
        relatedId: app._id,
      });

      await sendTemplatedEmail({
        to: student.email,
        subject: 'Resubmission Required - Certified Australia',
        preheader: 'Please address the feedback on your application',
        templateContent: `
          <h2 style="margin:0 0 16px 0;color:#f59e0b;">Resubmission Required</h2>
          <p>Hi ${student.firstName || 'there'},</p>
          <p>Your application <strong>${app.applicationId}</strong> requires some changes before it can proceed. Our team has provided feedback on what needs to be updated.</p>
          <p>Please review the feedback and resubmit your documents as soon as possible.</p>
        `,
        ctaText: 'View Feedback',
        ctaUrl: `${process.env.APP_BASE_URL || 'http://localhost:5173'}/student/documents`,
      }).catch((err) => console.error('[Scheduler] Resubmission reminder email error:', err.message));

      sent++;
    }

    console.log(`[Scheduler] Application reminders sent: ${sent}`);
    return {
      sent,
      breakdown: {
        staleLeads: staleLeads.length,
        incompleteIntakes: incompleteIntakes.length,
        pendingDocuments: pendingDocs.length,
        upcomingFollowUps: appsWithFollowUps.length,
        pendingResubmissions: resubApps.length,
      },
    };
  } catch (err) {
    console.error('[Scheduler] Application reminder batch error:', err.message);
    return { sent: 0, error: err.message };
  }
};

// ---------------------------------------------------------------------------
// Scheduler initialization
// ---------------------------------------------------------------------------

let autoDebitJob = null;
let reminderJob = null;
let overdueJob = null;
let appReminderJob = null;

const startScheduler = () => {
  console.log('[Scheduler] Starting schedulers...');

  // Daily auto-debit processing at 6 AM
  autoDebitJob = cron.schedule(DEBIT_SCHEDULE, async () => {
    console.log('[Scheduler] Running auto-debit job...');
    await processDueInstallments();
  });

  // Daily payment reminders at 9 AM
  reminderJob = cron.schedule(REMINDER_SCHEDULE, async () => {
    console.log('[Scheduler] Running payment reminder job...');
    await sendPaymentReminders();
  });

  // Daily overdue flagging at 7 AM
  overdueJob = cron.schedule('0 7 * * *', async () => {
    console.log('[Scheduler] Running overdue flagging job...');
    await flagOverdueInstallments();
  });

  // Application reminders at 8 AM daily + follow-up check every 2 hours
  appReminderJob = cron.schedule('0 8 * * *', async () => {
    console.log('[Scheduler] Running application reminder job...');
    await sendApplicationReminders();
  });

  // Follow-up call reminders every 2 hours (7 AM – 7 PM)
  cron.schedule('0 7,9,11,13,15,17,19 * * *', async () => {
    console.log('[Scheduler] Checking upcoming follow-up calls...');
    // Re-use the follow-up check portion
    const now = new Date();
    const followUpStart = new Date(now);
    const followUpEnd = new Date(now);
    followUpEnd.setHours(followUpEnd.getHours() + 2);

    const appsWithFollowUps = await Application.find({
      'followUpCalls.scheduledFor': { $gte: followUpStart, $lt: followUpEnd },
      'followUpCalls.completedAt': { $exists: false },
      assignedAgentId: { $exists: true, $ne: null },
    })
      .populate('studentId', 'firstName lastName')
      .populate('assignedAgentId', '_id')
      .lean();

    let sent = 0;
    for (const app of appsWithFollowUps) {
      const agent = app.assignedAgentId;
      if (!agent?._id) continue;
      const upcomingCalls = (app.followUpCalls || []).filter(
        (c) => !c.completedAt && c.scheduledFor >= followUpStart && c.scheduledFor < followUpEnd
      );
      for (const call of upcomingCalls) {
        const studentName = app.studentId
          ? `${app.studentId.firstName || ''} ${app.studentId.lastName || ''}`.trim()
          : 'Student';
        const callTime = new Date(call.scheduledFor).toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit' });
        await Notification.create({
          userId: agent._id,
          type: 'general',
          title: 'Upcoming Follow-Up Call',
          message: `Follow-up call with ${studentName} (${app.applicationId}) at ${callTime}.`,
          link: `/admin/applications/${app._id}`,
          relatedId: app._id,
        });
        sent++;
      }
    }
    if (sent) console.log(`[Scheduler] Follow-up call reminders sent: ${sent}`);
  });

  console.log('[Scheduler] All schedulers started:');
  console.log('  - Auto-debit: daily at 6:00 AM');
  console.log('  - Overdue flagging: daily at 7:00 AM');
  console.log('  - Application reminders: daily at 8:00 AM');
  console.log('  - Payment reminders: daily at 9:00 AM (3 days before due)');
  console.log('  - Follow-up call checks: every 2 hours (7AM–7PM)');
};

const stopScheduler = () => {
  if (autoDebitJob) autoDebitJob.stop();
  if (reminderJob) reminderJob.stop();
  if (overdueJob) overdueJob.stop();
  if (appReminderJob) appReminderJob.stop();
  console.log('[Scheduler] All schedulers stopped');
};

module.exports = {
  startScheduler,
  stopScheduler,
  processDueInstallments,
  sendPaymentReminders,
  flagOverdueInstallments,
  sendApplicationReminders,
};
