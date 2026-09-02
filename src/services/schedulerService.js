const cron = require('node-cron');
const PaymentPlan = require('../models/PaymentPlan');
const Payment = require('../models/Payment');
const Application = require('../models/Application');
const Notification = require('../models/Notification');
const { createSquarePayment } = require('./squareService');
const { sendTemplatedEmail, buildEmail, sendEmail, heading2, greeting, paragraph, detailsTable, successCard, warningCard, infoCard, buttonGroup, signOff } = require('./emailService');
const appEmails = require('./applicationEmailService');
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
    // Exclude paused plans and plans with failed debit status
    const plans = await PaymentPlan.find({
      status: 'active',
      directDebitEnabled: true,
      directDebitStatus: { $nin: ['disabled', 'processing'] },
      'installments.status': { $in: ['pending', 'partiallyPaid'] },
      'installments.dueDate': { $lte: endOfDay },
    }).populate('studentId', 'firstName lastName email');

    let processed = 0;
    let succeeded = 0;
    let failed = 0;
    let skipped = 0;

    for (const plan of plans) {
      // Verify the plan has a saved card — skip if no card-on-file
      if (!plan.directDebitAccountDetails?.squareCardId) {
        console.log(`[Scheduler] Skipping plan ${plan._id} — no saved card`);
        skipped++;
        continue;
      }

      // Cross-reference with actual completed payments to detect early payments
      const existingPayments = await Payment.find({
        paymentPlanId: plan._id,
        status: 'completed',
        type: 'plan',
      }).lean();
      const totalAlreadyPaid = existingPayments.reduce((s, p) => s + (p.amount || 0), 0);

      // Recalculate what's actually outstanding per installment
      let runningPaid = totalAlreadyPaid;
      const installmentOutstanding = plan.installments.map((inst) => {
        if (inst.status === 'paid' || inst.status === 'skipped') return { inst, outstanding: 0 };
        const instAmount = inst.amount || 0;
        if (runningPaid >= instAmount) {
          runningPaid -= instAmount;
          return { inst, outstanding: 0 }; // Already covered by early payment
        }
        const owed = instAmount - runningPaid;
        runningPaid = 0;
        return { inst, outstanding: owed };
      });

      // Only charge installments that are due AND actually have outstanding balance
      const dueInstallments = installmentOutstanding.filter(
        ({ inst, outstanding }) =>
          outstanding > 0 &&
          (inst.status === 'pending' || inst.status === 'partiallyPaid') &&
          inst.dueDate <= endOfDay
      );

      for (const { inst: installment, outstanding } of dueInstallments) {
        processed++;

        // Mark plan as processing to prevent double-charges
        plan.directDebitStatus = 'processing';
        await plan.save();

        const result = await processAutoDebit(plan, installment, outstanding);

        if (result.success) {
          succeeded++;
          plan.directDebitStatus = 'scheduled';
          plan.directDebitFailedAt = null;
          plan.directDebitFailReason = null;
        } else {
          failed++;
          plan.directDebitStatus = 'failed';
          plan.directDebitFailedAt = new Date();
          plan.directDebitFailReason = result.error;
        }
        await plan.save();
      }

      if (dueInstallments.length === 0) {
        skipped++;
      }
    }

    console.log(
      `[Scheduler] Auto-debit complete: ${processed} processed, ${succeeded} succeeded, ${failed} failed, ${skipped} skipped (early payment or no card)`
    );

    return { processed, succeeded, failed, skipped };
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
      const baseUrl = process.env.APP_BASE_URL || 'http://localhost:5173';
      const body = heading2('Payment Confirmation') +
        greeting(student.firstName || 'there') +
        paragraph('Your scheduled payment has been successfully processed:') +
        successCard(null, 'Your payment was processed successfully.') +
        detailsTable('Payment Details', [
          { label: 'Installment', value: `#${installment.index + 1}` },
          { label: 'Amount', value: `$${amount.toFixed(2)} AUD` },
          { label: 'Date', value: new Date().toLocaleDateString('en-AU', { timeZone: 'Australia/Sydney' }) },
        ]) +
        buttonGroup({ text: 'View Payments', url: `${baseUrl}/student/payments` }) +
        signOff();
      const html = buildEmail(body, `Installment #${installment.index + 1} of $${amount.toFixed(2)} processed`);
      await sendEmail({ to: student.email, subject: 'Payment Processed - Certified Australia', html })
        .catch((err) => console.error('[Scheduler] Email send error:', err.message));
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

    // Send failure email to student
    if (student?.email) {
      const application = await Application.findById(plan.applicationId).lean();
      if (application) {
        appEmails.sendPaymentFailureEmail(student, application, installment, err.message)
          .catch((e) => console.error('[Scheduler] Payment failure email error:', e.message));
      }
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

        const dueDate = new Date(installment.dueDate).toLocaleDateString('en-AU', { timeZone: 'Australia/Sydney' });

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
        const baseUrl = process.env.APP_BASE_URL || 'http://localhost:5173';
        const reminderBody = heading2('Payment Reminder') +
          greeting(student.firstName || 'there') +
          paragraph('This is a friendly reminder that you have an upcoming payment:') +
          warningCard('Upcoming Payment', `Installment #${installment.index + 1} of <strong>$${outstanding.toFixed(2)} AUD</strong> is due on <strong>${dueDate}</strong>.`) +
          detailsTable('Payment Details', [
            { label: 'Installment', value: `#${installment.index + 1}` },
            { label: 'Amount Due', value: `$${outstanding.toFixed(2)} AUD` },
            { label: 'Due Date', value: dueDate },
          ]) +
          paragraph(plan.directDebitEnabled
            ? 'This payment will be automatically debited from your saved payment method.'
            : 'Please log in to your portal to make your payment before the due date.'
          ) +
          buttonGroup({ text: 'View Payment Plan', url: `${baseUrl}/student/payments` }) +
          signOff();
        const reminderHtml = buildEmail(reminderBody, `Installment of $${outstanding.toFixed(2)} due on ${dueDate}`);
        await sendEmail({ to: student.email, subject: 'Payment Reminder - Certified Australia', html: reminderHtml })
          .catch((err) => console.error('[Scheduler] Reminder email error:', err.message));

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

      // Send overdue email to student for each overdue installment
      if (student?.email) {
        for (const inst of overdueInstallments) {
          const daysOverdue = Math.floor((now - new Date(inst.dueDate)) / (1000 * 60 * 60 * 24));
          appEmails.sendPaymentOverdueEmail(student, plan.applicationId, inst, daysOverdue)
            .catch((e) => console.error('[Scheduler] Overdue email error:', e.message));
        }
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
const RESUBMISSION_REMINDER_DAYS = 3; // Days a resubmission request may sit unanswered before we chase

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

      const intakeBody = heading2('Intake Form Reminder') +
        greeting(student.firstName || 'there') +
        paragraph(`Your application <strong>${app.applicationId}</strong> has been paid, but we're still waiting for your intake form.`) +
        warningCard('Action Required', 'Please complete your Student Intake Form as soon as possible so we can move forward with your RPL assessment.') +
        buttonGroup({ text: 'Complete Intake Form', url: `${process.env.APP_BASE_URL || 'http://localhost:5173'}/student/intake` }) +
        signOff();
      await sendEmail({ to: student.email, subject: 'Action Required: Complete Your Intake Form - Certified Australia', html: buildEmail(intakeBody, 'Your intake form is pending') })
        .catch((err) => console.error('[Scheduler] Intake reminder email error:', err.message));

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

      const docsBody = heading2('Document Upload Reminder') +
        greeting(student.firstName || 'there') +
        successCard(null, `Your intake form for <strong>${app.applicationId}</strong> is complete — great work!`) +
        paragraph('The next step is to upload your supporting documents (evidence of prior learning, qualifications, work references, etc.).') +
        infoCard('Documents Needed', [
          'Evidence of prior learning and work experience',
          'Qualifications and certificates',
          'Work references or employer letters',
          'Any other supporting documentation',
        ]) +
        buttonGroup({ text: 'Upload Documents', url: `${process.env.APP_BASE_URL || 'http://localhost:5173'}/student/documents` }) +
        signOff();
      await sendEmail({ to: student.email, subject: 'Action Required: Upload Documents - Certified Australia', html: buildEmail(docsBody, 'We need your supporting documents') })
        .catch((err) => console.error('[Scheduler] Document reminder email error:', err.message));

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
          hour: '2-digit', minute: '2-digit', timeZone: 'Australia/Sydney',
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
    // This chases an ACTUAL admin-raised resubmission request. It must never
    // key off status/updatedAt alone: every application sitting in
    // UploadDocuments would then be told an admin had flagged their documents,
    // which is a lie and (with nothing bumping updatedAt) repeats every day.
    const resubCutoff = new Date(now);
    resubCutoff.setDate(resubCutoff.getDate() - RESUBMISSION_REMINDER_DAYS);

    const resubApps = await Application.find({
      status: { $nin: ['Archived', 'CertificateIssued', 'CertificateGenerated'] },
      isTest: { $ne: true },
      resubmissionRequests: {
        $elemMatch: {
          status: 'pending',
          requestedAt: { $lt: resubCutoff },
          // Re-chase at most once per RESUBMISSION_REMINDER_DAYS window.
          $or: [{ lastReminderAt: { $exists: false } }, { lastReminderAt: { $lt: resubCutoff } }],
        },
      },
    })
      .populate('studentId', 'firstName lastName email')
      .lean();

    let resubReminded = 0;

    for (const app of resubApps) {
      const student = app.studentId;
      if (!student?.email) continue;

      // Only the requests that are genuinely due — an application can carry
      // several, and a fresh one must not ride along on an old one.
      const dueRequests = (app.resubmissionRequests || []).filter(
        (r) =>
          r.status === 'pending' &&
          r.requestedAt &&
          new Date(r.requestedAt) < resubCutoff &&
          (!r.lastReminderAt || new Date(r.lastReminderAt) < resubCutoff)
      );
      if (!dueRequests.length) continue;

      await Notification.create({
        userId: student._id,
        type: 'status_changed',
        title: 'Resubmission Required',
        message: `Your application ${app.applicationId} has a pending resubmission request. Please address the feedback and resubmit.`,
        link: '/student/documents',
        relatedId: app._id,
      });

      const resubBody = heading2('Resubmission Required') +
        greeting(student.firstName || 'there') +
        warningCard('Changes Needed', `Your application <strong>${app.applicationId}</strong> requires some changes before it can proceed. Our team has provided feedback on what needs to be updated.`) +
        paragraph('Please review the feedback and resubmit your documents as soon as possible.') +
        buttonGroup({ text: 'View Feedback', url: `${process.env.APP_BASE_URL || 'http://localhost:5173'}/student/documents` }) +
        signOff();
      await sendEmail({ to: student.email, subject: 'Resubmission Required - Certified Australia', html: buildEmail(resubBody, 'Please address the feedback on your application') })
        .catch((err) => console.error('[Scheduler] Resubmission reminder email error:', err.message));

      // Stamp the requests we just chased so tomorrow's run skips them.
      // timestamps:false — this is scheduler bookkeeping, not application
      // activity, and bumping updatedAt would move the other reminder windows.
      await Application.updateOne(
        { _id: app._id },
        { $set: { 'resubmissionRequests.$[req].lastReminderAt': now } },
        {
          arrayFilters: [{ 'req._id': { $in: dueRequests.map((r) => r._id) } }],
          timestamps: false,
        }
      ).catch((err) => console.error('[Scheduler] Resubmission reminder stamp error:', err.message));

      resubReminded++;
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
        pendingResubmissions: resubReminded,
      },
    };
  } catch (err) {
    console.error('[Scheduler] Application reminder batch error:', err.message);
    return { sent: 0, error: err.message };
  }
};

// ---------------------------------------------------------------------------
// RTO payment timer — auto-transition after 21-day assessment period
// ---------------------------------------------------------------------------

const RTO_TIMER_DAYS = 21;

/**
 * Check all applications with an active 21-day timer.
 * When the timer has elapsed (>= 21 days) and the application is still in a
 * pre-payment status, auto-advance to ReadyForRTOPayment.
 *
 * Mirrors the old project's rtoPaymentScheduler.js.
 */
const checkRtoPaymentTimers = async () => {
  const now = new Date();
  console.log('[Scheduler] Checking RTO payment timers...');

  try {
    // Find applications with an active timer that haven't been stopped
    const apps = await Application.find({
      timerStartedAt: { $exists: true, $ne: null },
      timerStoppedAt: { $in: [null, undefined] },
      status: { $in: ['StudentCompleted', 'SentToRTO', 'WaitingForVerification'] },
    }).lean();

    let transitioned = 0;

    for (const app of apps) {
      const elapsed = Math.floor((now - new Date(app.timerStartedAt)) / (1000 * 60 * 60 * 24));

      if (elapsed >= RTO_TIMER_DAYS) {
        const applicationService = require('./applicationService');
        await applicationService.updateStatus(app._id, 'ReadyForRTOPayment');
        console.log(`[Scheduler] ${app.applicationId} → ReadyForRTOPayment (${elapsed} days elapsed)`);
        transitioned++;
      }
    }

    console.log(`[Scheduler] RTO timer check complete: ${apps.length} checked, ${transitioned} transitioned`);
    return { checked: apps.length, transitioned };
  } catch (err) {
    console.error('[Scheduler] RTO timer check error:', err.message);
    return { checked: 0, transitioned: 0, error: err.message };
  }
};

// ---------------------------------------------------------------------------
// Scheduler initialization
// ---------------------------------------------------------------------------

let autoDebitJob = null;
let reminderJob = null;
let overdueJob = null;
let appReminderJob = null;
let xeroSyncJob = null;
let rtoTimerJob = null;
let campaignBounceJob = null;
let sequenceTickJob = null;
let batchReconcileJob = null;

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
        const callTime = new Date(call.scheduledFor).toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit', timeZone: 'Australia/Sydney' });
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

  // RTO 21-day timer check — daily at 1:00 AM
  rtoTimerJob = cron.schedule('0 1 * * *', async () => {
    console.log('[Scheduler] Running RTO payment timer check...');
    await checkRtoPaymentTimers();
  });

  // Xero daily sync — 10:00 PM (after business hours)
  xeroSyncJob = cron.schedule('0 22 * * *', async () => {
    try {
      const xeroService = require('./xeroService');
      const status = await xeroService.getConnectionStatus();
      if (!status.connected) return;

      console.log('[Scheduler] Running daily Xero sync...');
      const syncResult = await xeroService.syncAll();
      console.log(`[Scheduler] Xero sync: ${syncResult.synced} synced, ${syncResult.failed} failed, ${syncResult.skipped} skipped`);

      const reconcileResult = await xeroService.reconcile();
      console.log(`[Scheduler] Xero reconciliation: ${reconcileResult.reconciled} reconciled`);
    } catch (err) {
      console.error('[Scheduler] Xero sync error:', err.message);
    }
  });

  // Campaign bounce polling — every 5 minutes (IMAP DSN scan of sending mailboxes)
  campaignBounceJob = cron.schedule('*/5 * * * *', async () => {
    try {
      const bounceService = require('./campaignBounceService');
      await bounceService.pollAll();
    } catch (err) {
      console.error('[Scheduler] Campaign bounce poll error:', err.message);
    }
  });

  // RTO batch payment queue reconcile — daily at 1:30 AM, right after the timer
  // check. Batches are built on invoice upload; this is the safety net that
  // catches anything that slipped and refreshes the unpaid rows' snapshots.
  batchReconcileJob = cron.schedule('30 1 * * *', async () => {
    try {
      const paymentBatchService = require('./paymentBatchService');
      const result = await paymentBatchService.reconcile();
      console.log(`[Scheduler] Batch queue reconcile: ${result.added} queued, ${result.refreshed} refreshed, ${result.errors.length} errors`);
    } catch (err) {
      console.error('[Scheduler] Batch queue reconcile error:', err.message);
    }
  });

  // Email-sequence (drip) tick — every 5 minutes, unless disabled.
  if (process.env.SEQUENCE_SCHEDULER_ENABLED !== 'false') {
    sequenceTickJob = cron.schedule('*/5 * * * *', async () => {
      try {
        const sequenceService = require('./sequenceService');
        await sequenceService.runSequenceTick();
      } catch (err) {
        console.error('[Scheduler] Sequence tick error:', err.message);
      }
    });
  }

  // One-off boot tasks: recover interrupted sends, then a first bounce sweep,
  // and a first sequence tick once the DB is warm.
  (async () => {
    try {
      const sendService = require('./campaignSendService');
      await sendService.recoverInterrupted();
    } catch (err) {
      console.error('[Scheduler] Campaign send recovery error:', err.message);
    }
    setTimeout(async () => {
      try {
        const bounceService = require('./campaignBounceService');
        await bounceService.pollAll();
      } catch (err) {
        console.error('[Scheduler] Initial bounce poll error:', err.message);
      }
    }, 30 * 1000);
    if (process.env.SEQUENCE_SCHEDULER_ENABLED !== 'false') {
      setTimeout(async () => {
        try {
          const sequenceService = require('./sequenceService');
          await sequenceService.runSequenceTick();
        } catch (err) {
          console.error('[Scheduler] Initial sequence tick error:', err.message);
        }
      }, 20 * 1000);
    }
  })();

  console.log('[Scheduler] All schedulers started:');
  console.log('  - RTO 21-day timer: daily at 1:00 AM');
  console.log('  - Auto-debit: daily at 6:00 AM');
  console.log('  - Overdue flagging: daily at 7:00 AM');
  console.log('  - Application reminders: daily at 8:00 AM');
  console.log('  - Payment reminders: daily at 9:00 AM (3 days before due)');
  console.log('  - Follow-up call checks: every 2 hours (7AM–7PM)');
  console.log('  - Xero sync + reconciliation: daily at 10:00 PM');
  console.log('  - Campaign bounce polling: every 5 minutes');
  console.log('  - RTO batch queue reconcile: daily at 1:30 AM');
};

const stopScheduler = () => {
  if (rtoTimerJob) rtoTimerJob.stop();
  if (autoDebitJob) autoDebitJob.stop();
  if (reminderJob) reminderJob.stop();
  if (overdueJob) overdueJob.stop();
  if (appReminderJob) appReminderJob.stop();
  if (xeroSyncJob) xeroSyncJob.stop();
  if (campaignBounceJob) campaignBounceJob.stop();
  if (sequenceTickJob) sequenceTickJob.stop();
  if (batchReconcileJob) batchReconcileJob.stop();
  console.log('[Scheduler] All schedulers stopped');
};

module.exports = {
  startScheduler,
  stopScheduler,
  processDueInstallments,
  sendPaymentReminders,
  flagOverdueInstallments,
  sendApplicationReminders,
  checkRtoPaymentTimers,
};
