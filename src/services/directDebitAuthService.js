const crypto = require('crypto');
const AppError = require('../utils/AppError');
const DirectDebitAuthority = require('../models/DirectDebitAuthority');
const Application = require('../models/Application');
const PaymentPlan = require('../models/PaymentPlan');
const User = require('../models/User');
const driveService = require('./googleDriveService');
const { generateDirectDebitPdf } = require('../utils/directDebitPdf');

const APP_BASE_URL = process.env.APP_BASE_URL || 'http://localhost:5173';

/* Derive the payment arrangement snapshot from the application's active plan. */
async function buildArrangement(applicationId) {
  const plan = await PaymentPlan.findOne({ applicationId, status: { $ne: 'cancelled' } })
    .sort({ createdAt: -1 })
    .lean();
  if (!plan) return {};

  const installments = [...(plan.installments || [])].sort((a, b) => a.index - b.index);
  const nextPending = installments.find((i) => i.status === 'pending' || i.status === 'partiallyPaid');
  const recurringAmount = nextPending?.amount
    || (installments.length ? Math.round((plan.totalAmount / installments.length) * 100) / 100 : plan.totalAmount);

  // Infer frequency from the gap between the first two installments
  let frequency = 'Per schedule';
  if (installments.length >= 2) {
    const days = Math.round(
      (new Date(installments[1].dueDate).getTime() - new Date(installments[0].dueDate).getTime()) / 86400000
    );
    if (days >= 5 && days <= 9) frequency = 'Weekly';
    else if (days >= 12 && days <= 16) frequency = 'Fortnightly';
    else if (days >= 26 && days <= 32) frequency = 'Monthly';
  }

  return {
    totalAmount: plan.totalAmount,
    recurringAmount,
    frequency,
    firstChargeDate: nextPending?.dueDate || installments[0]?.dueDate || null,
    numberOfPayments: installments.length,
    paidToDate: plan.totalPaidAmount || 0,
    outstanding: Math.max(0, (plan.totalAmount || 0) - (plan.totalPaidAmount || 0)),
    surcharge: 0,
  };
}

/* Enable (or re-enable) the Direct Debit Authority for an application. */
async function enableAuthority(applicationId, actor = {}) {
  const application = await Application.findById(applicationId).populate('studentId', 'firstName lastName email');
  if (!application) throw new AppError('Application not found', 404);

  const arrangement = await buildArrangement(applicationId);
  const student = application.studentId;

  let record = await DirectDebitAuthority.findOne({ applicationId });
  const token = record?.token || crypto.randomBytes(24).toString('hex');

  if (!record) {
    record = new DirectDebitAuthority({ applicationId, token });
  }
  record.studentId = student?._id;
  record.enabled = true;
  // Keep a submitted authority submitted; otherwise (re)set to pending
  if (record.status !== 'submitted') record.status = 'pending';
  record.arrangement = arrangement;
  record.enabledBy = actor.userId;
  record.enabledAt = new Date();
  await record.save();

  const link = `${APP_BASE_URL}/direct-debit-form/${token}`;

  // Email the student the authorisation link (non-fatal)
  try {
    const { sendTemplatedEmail } = require('./emailService');
    if (student?.email) {
      await sendTemplatedEmail({
        to: student.email,
        subject: 'Action required: Direct Debit Authorisation',
        preheader: 'Please review and sign your Direct Debit arrangement.',
        templateContent: `
          <h2 style="font-size:20px;color:#1f2937;margin:0 0 16px;">Hi ${student.firstName || 'there'},</h2>
          <p>To set up the recurring payments for your application <strong>${application.applicationId}</strong>,
          please review your payment arrangement and provide your Direct Debit authorisation with your signature.</p>
          <p>It only takes a minute — no card or bank numbers are required.</p>
        `,
        ctaText: 'Review & Sign Authorisation',
        ctaUrl: link,
      });
    }
  } catch (err) {
    console.error('[DirectDebit] enable email failed:', err.message);
  }

  // In-portal notification to the student (non-fatal)
  try {
    if (student?._id) {
      const { createNotification } = require('./notificationService');
      await createNotification({
        userId: student._id,
        type: 'direct_debit_authority',
        title: 'Direct Debit Authorisation',
        message: `Please review and sign your Direct Debit authorisation for ${application.applicationId}.`,
        // In-portal link → embedded student page (keeps header/sidebar). The email uses the public URL.
        link: `/student/direct-debit/${token}`,
        relatedId: application._id,
      });
    }
  } catch (err) {
    console.error('[DirectDebit] enable notification failed:', err.message);
  }

  return record.toObject();
}

async function disableAuthority(applicationId) {
  const record = await DirectDebitAuthority.findOneAndUpdate(
    { applicationId },
    { $set: { enabled: false, status: 'disabled' } },
    { new: true }
  ).lean();
  if (!record) throw new AppError('No Direct Debit authority found for this application', 404);
  return record;
}

async function resendEmail(applicationId, actor) {
  const existing = await DirectDebitAuthority.findOne({ applicationId }).lean();
  if (!existing) throw new AppError('No Direct Debit authority found for this application', 404);
  return enableAuthority(applicationId, actor);
}

/* Public: fetch the authority + arrangement by token (for the customer form). */
async function getByToken(token) {
  const record = await DirectDebitAuthority.findOne({ token })
    .populate('applicationId', 'applicationId')
    .lean();
  if (!record) throw new AppError('Invalid or expired authorisation link', 404);
  if (!record.enabled) throw new AppError('This Direct Debit authorisation is no longer active', 410);

  // Always reflect the CURRENT payment schedule. The arrangement stored at enable-time can
  // be empty or stale if the payment plan was created or edited afterwards — recompute it
  // live so the form updates per schedule (matching the legacy portal). Fall back to the
  // stored snapshot only when there's no active plan to derive from.
  const appId = record.applicationId?._id || record.applicationId;
  const live = await buildArrangement(appId);
  if (Object.keys(live).length) record.arrangement = live;

  return record;
}

/* Public: student submits the signed form → generate + store the PDF. */
async function submit(token, { form, signature }) {
  if (!form || typeof form !== 'object') throw new AppError('Form data is required', 400);
  if (!signature || !signature.dataUrl) throw new AppError('A signature is required', 400);

  const record = await DirectDebitAuthority.findOne({ token });
  if (!record) throw new AppError('Invalid or expired authorisation link', 404);
  if (!record.enabled) throw new AppError('This Direct Debit authorisation is no longer active', 410);

  record.form = {
    fullName: form.fullName ?? null,
    studentClientId: form.studentClientId ?? null,
    address: form.address ?? null,
    phone: form.phone ?? null,
    email: form.email ?? null,
    authoriseRecurring: !!form.authoriseRecurring,
    understandRecurring: !!form.understandRecurring,
    confirmCardholder: !!form.confirmCardholder,
    acceptTerms: !!form.acceptTerms,
    signatureName: form.signatureName ?? null,
    signatureDate: form.signatureDate ?? null,
  };
  record.signature = {
    mode: signature.mode === 'drawn' ? 'drawn' : 'typed',
    dataUrl: signature.dataUrl,
    font: signature.font || null,
  };
  record.status = 'submitted';
  record.submittedAt = new Date();

  // Refresh the arrangement from the current plan so the signed PDF reflects exactly what
  // the student is authorising at signing time (keeps it in sync with schedule edits).
  try {
    const live = await buildArrangement(record.applicationId);
    if (Object.keys(live).length) record.arrangement = live;
  } catch (err) {
    console.error('[DirectDebit] arrangement refresh on submit failed:', err.message);
  }

  // Generate the PDF and upload to the application's Drive folder (non-fatal on Drive errors)
  try {
    const application = await Application.findById(record.applicationId)
      .populate('studentId', 'firstName lastName')
      .lean();
    const displayId = application?.applicationId || String(record.applicationId);
    const pdfBuffer = await generateDirectDebitPdf(record.toObject(), { applicationDisplayId: displayId });

    let folderId = application?.googleDriveFolderId;
    if (!folderId) {
      const s = application?.studentId;
      const studentName = s ? `${s.firstName || ''} ${s.lastName || ''}`.trim() : '';
      folderId = await driveService.getOrCreateAppFolder(displayId, [displayId, studentName].filter(Boolean).join(' - '));
      await Application.updateOne({ _id: record.applicationId }, { $set: { googleDriveFolderId: folderId } });
    }

    const fileName = `DirectDebitAuthority_${displayId}_${Date.now()}.pdf`;
    const uploaded = await driveService.uploadFileBuffer({
      buffer: pdfBuffer,
      fileName,
      mimeType: 'application/pdf',
      folderId,
      description: `Direct Debit Authority for ${displayId}`,
    });
    record.pdf = {
      driveFileId: uploaded.id,
      viewLink: uploaded.webViewLink,
      downloadLink: uploaded.downloadLink,
      fileName: uploaded.fileName || fileName,
      generatedAt: new Date(),
    };
  } catch (err) {
    console.error('[DirectDebit] PDF generation/upload failed:', err.message);
  }

  await record.save();

  // Notify admins that the authority was signed (non-fatal)
  try {
    const { createNotification } = require('./notificationService');
    const application = await Application.findById(record.applicationId).select('applicationId studentId assignedAgentId').lean();
    const recipients = new Set();
    if (application?.assignedAgentId) recipients.add(String(application.assignedAgentId));
    const staff = await User.find({ role: { $in: ['Admin', 'CEOReportingManager'] }, status: 'active' }).select('_id').lean();
    staff.forEach((u) => recipients.add(String(u._id)));
    await Promise.all([...recipients].map((userId) => createNotification({
      userId,
      type: 'direct_debit_signed',
      title: 'Direct Debit Authority Signed',
      message: `The Direct Debit authorisation for ${application?.applicationId || ''} has been signed.`,
      link: `/admin/students/${application?.studentId}`,
      relatedId: record.applicationId,
    })));
  } catch (err) {
    console.error('[DirectDebit] submit notification failed:', err.message);
  }

  return record.toObject();
}

async function getByApplication(applicationId) {
  return DirectDebitAuthority.findOne({ applicationId }).lean();
}

module.exports = {
  enableAuthority,
  disableAuthority,
  resendEmail,
  getByToken,
  submit,
  getByApplication,
};
