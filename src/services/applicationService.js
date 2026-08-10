const crypto = require('crypto');
const AppError = require('../utils/AppError');
const buildCrud = require('./commonCrud');
const Application = require('../models/Application');
const IntakeForm = require('../models/IntakeForm');
const ScreeningForm = require('../models/ScreeningForm');
const Document = require('../models/Document');
const Certificate = require('../models/Certificate');
const Payment = require('../models/Payment');
const appEmails = require('./applicationEmailService');
const { SIGNUP_DISCOUNT_AMOUNT } = require('../config/pricing');

/**
 * Check if the student has completed their 3 obligations and advance status.
 * Then, if RTO is also assigned, start the 21-day KPI timer.
 *
 * Student completion (3 conditions): payment, intake form, documents uploaded.
 * Timer start (4th condition): RTO assigned.
 *
 * Called from: payment creation, intake form submission, document upload, RTO assignment.
 */
const tryAutoStartTimer = async (applicationId) => {
  const app = await Application.findById(applicationId);
  if (!app) return;

  // Check 3 student obligations via boolean flags
  // paymentCompleted = full payment only (not partial plan payments)
  const hasPaid = app.paymentCompleted;
  const hasIntake = app.intakeFormSubmitted || !!app.intakeFormId;
  const hasDocs = app.documentsUploaded === true;

  if (!hasPaid || !hasIntake || !hasDocs) return;

  // All 3 student obligations met — advance to StudentCompleted if still in a pre-completion status
  const preStudentStatuses = [
    'New', 'WaitingForPayment', 'StudentIntakeForm', 'UploadDocuments', 'DocumentsUploaded',
  ];
  if (preStudentStatuses.includes(app.status)) {
    // Use findByIdAndUpdate to avoid race conditions with concurrent saves
    await Application.findByIdAndUpdate(applicationId, {
      status: 'StudentCompleted',
      studentCompletionDate: app.studentCompletionDate || new Date(),
    });
  }

  // Check condition 4: RTO assigned — start the 21-day timer
  // Re-read to get latest state
  const refreshed = await Application.findById(applicationId);
  if (!refreshed || !refreshed.assignedRTOId || refreshed.timerStartedAt) return;

  refreshed.timerStartedAt = new Date();
  await refreshed.save();
};

const applicationCrud = buildCrud(Application, {
  populate: [
    'studentId',
    'industryId',
    'qualificationId',
    'assignedAgentId',
    'assignedRTOId',
    'paymentPlanId',
    'certificateId',
    'screeningFormId',
  ],
});

const intakeFormCrud = buildCrud(IntakeForm, {
  populate: ['applicationId'],
});

const screeningFormCrud = buildCrud(ScreeningForm, {
  populate: ['applicationId', 'industryId', 'qualificationId'],
});

const documentCrud = buildCrud(Document, {
  populate: ['applicationId', 'studentId', 'uploadedBy', 'verifiedBy'],
});

const certificateCrud = buildCrud(Certificate, {
  populate: ['applicationId', 'studentId', 'issuedBy'],
});

const generateApplicationId = async () => {
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const suffix = String(10000 + Math.floor(Math.random() * 90000));
    const applicationId = `APP${suffix}`;
    const existing = await Application.exists({ applicationId });

    if (!existing) {
      return applicationId;
    }
  }

  throw new AppError('Unable to generate application ID', 500);
};

const refreshApplication = async (applicationId) => {
  return Application.findById(applicationId)
    .populate('studentId industryId qualificationId assignedAgentId assignedRTOId paymentPlanId certificateId')
    .lean();
};

const createApplication = async (data) => {
  const applicationId = await generateApplicationId();

  // Copy marketing source attribution from the student
  let sourceAttribution = data.sourceAttribution || undefined;
  if (!sourceAttribution && data.studentId) {
    const Student = require('../models/Student');
    const student = await Student.findById(data.studentId).select('sourceAttribution').lean();
    if (student?.sourceAttribution?.source) {
      sourceAttribution = student.sourceAttribution;
    }
  }

  // The automatic signup discount applies to EVERY application a student starts, not just
  // their first one at registration. Only skip it when the caller supplied its own
  // discounts array (e.g. an import/backfill that already carries the discount).
  const hasCallerDiscounts = Array.isArray(data.discounts) && data.discounts.length > 0;
  const signupDiscount = hasCallerDiscounts
    ? {}
    : {
        discounts: [{
          amount: SIGNUP_DISCOUNT_AMOUNT,
          note: 'Signup discount',
          createdAt: new Date(),
        }],
        signupDiscountApplied: true,
      };

  const application = await Application.create({
    ...data,
    applicationId,
    status: data.status || 'New',
    ...(sourceAttribution ? { sourceAttribution } : {}),
    ...signupDiscount,
  });

  return refreshApplication(application._id);
};

const updateSource = async (applicationId, source) => {
  const normalized = (source || 'direct').toString().trim().toLowerCase();
  const application = await Application.findByIdAndUpdate(
    applicationId,
    { sourceAttribution: { source: normalized, timestamp: new Date() } },
    { new: true, runValidators: true }
  )
    .populate('studentId industryId qualificationId assignedAgentId assignedRTOId paymentPlanId certificateId')
    .lean();
  if (!application) throw new AppError('Application not found', 404);
  return application;
};

const LEAD_COLORS = ['red', 'orange', 'yellow', 'gray', 'green', 'pink', 'lightblue', 'turquoise', ''];

const updateLeadStatus = async (applicationId, color, actor = {}) => {
  const next = (color ?? '').toString().trim().toLowerCase();
  if (!LEAD_COLORS.includes(next)) {
    throw new AppError('Invalid lead status', 400);
  }

  const current = await Application.findById(applicationId).select('color').lean();
  if (!current) throw new AppError('Application not found', 404);

  const previousColor = current.color || '';
  // No-op if unchanged — don't pollute the history trail
  if (previousColor === next) {
    const unchanged = await Application.findById(applicationId)
      .populate('studentId industryId qualificationId assignedAgentId assignedRTOId paymentPlanId certificateId')
      .lean();
    return unchanged;
  }

  const historyEntry = {
    color: next,
    previousColor,
    changedAt: new Date(),
    changedBy: actor.userId || undefined,
    changedByName: actor.userName || undefined,
  };

  const application = await Application.findByIdAndUpdate(
    applicationId,
    { $set: { color: next }, $push: { leadStatusHistory: historyEntry } },
    { new: true, runValidators: true }
  )
    .populate('studentId industryId qualificationId assignedAgentId assignedRTOId paymentPlanId certificateId')
    .lean();

  if (!application) throw new AppError('Application not found', 404);
  return application;
};

const assignAgent = async (applicationId, assignedAgentId) => {
  const update = { assignedAgentId };
  if (assignedAgentId) update.agentAssignedAt = new Date();
  const application = await Application.findByIdAndUpdate(
    applicationId,
    update,
    { new: true, runValidators: true }
  )
    .populate('studentId industryId qualificationId assignedAgentId assignedRTOId paymentPlanId certificateId')
    .lean();

  if (!application) {
    throw new AppError('Application not found', 404);
  }

  // Notify assigned agent (non-fatal)
  if (assignedAgentId) {
    try {
      const { createNotification } = require('./notificationService');
      const student = application.studentId;
      const studentName = student ? `${student.firstName || ''} ${student.lastName || ''}`.trim() : 'a student';
      await createNotification({
        userId: assignedAgentId,
        type: 'application_assigned',
        title: 'New Application Assigned',
        message: `You've been assigned to ${application.applicationId} for ${studentName}.`,
        link: `/agent/applications`,
        relatedId: application._id,
      });
    } catch (err) {
      console.error('[AssignAgent] Failed to create notification:', err.message);
    }
  }

  return application;
};

const assignRTO = async (applicationId, assignedRTOId) => {
  const update = { assignedRTOId, rtoAssignmentDate: assignedRTOId ? new Date() : null };
  if (!assignedRTOId) {
    update.rtoAssignmentDate = null;
  }
  const application = await Application.findByIdAndUpdate(
    applicationId,
    update,
    { new: true, runValidators: true }
  )
    .populate('studentId industryId qualificationId assignedAgentId assignedRTOId paymentPlanId certificateId')
    .lean();

  if (!application) {
    throw new AppError('Application not found', 404);
  }

  // Notify assigned RTO — in-portal + email (non-fatal)
  if (assignedRTOId) {
    try {
      const { notifyWithEmail } = require('./notificationService');
      const student = application.studentId;
      const studentName = student ? `${student.firstName || ''} ${student.lastName || ''}`.trim() : 'a student';
      const qualName = application.qualificationId?.name || '';
      await notifyWithEmail(
        assignedRTOId,
        {
          type: 'application_assigned',
          title: 'Application Assigned for Review',
          message: `You've been assigned to review ${application.applicationId} for ${studentName}${qualName ? ` — ${qualName}` : ''}.`,
          link: `/rto/applications`,
          relatedId: application._id,
        },
        {
          subject: `New Application Assigned: ${application.applicationId} — ${studentName}`,
          ctaText: 'Review Application',
        }
      );
    } catch (err) {
      console.error('[AssignRTO] Failed to notify:', err.message);
    }

    // Try to start the 21-day timer — requires both student completion + RTO assignment
    await tryAutoStartTimer(applicationId);
  }

  return application;
};

/**
 * Mark/unmark an application as a test application. Test applications (and their
 * payments) are excluded from all admin metrics, dashboards, reporting and
 * financial aggregations, but remain visible/manageable in the students list.
 * The flag is denormalized onto this application's Payments so revenue/cashflow
 * aggregations can filter without a lookup.
 */
const setTestFlag = async (applicationId, isTest) => {
  const flag = !!isTest;
  const application = await Application.findByIdAndUpdate(
    applicationId,
    { isTest: flag },
    { new: true, runValidators: true }
  )
    .populate('studentId industryId qualificationId assignedAgentId assignedRTOId paymentPlanId certificateId')
    .lean();

  if (!application) {
    throw new AppError('Application not found', 404);
  }

  // Keep the denormalized flag in sync on every child doc that carries it, so
  // revenue/cashflow/plan/certificate metrics exclude (or re-include) this app.
  const PaymentPlan = require('../models/PaymentPlan');
  await Promise.all([
    Payment.updateMany({ applicationId }, { $set: { isTest: flag } }),
    PaymentPlan.updateMany({ applicationId }, { $set: { isTest: flag } }),
    Certificate.updateMany({ applicationId }, { $set: { isTest: flag } }),
  ]);

  return application;
};

/**
 * Log an RTO activity against an application (CA-06 audit trail).
 */
const logRTOActivity = async (applicationId, { action, userId, detail }) => {
  const application = await Application.findById(applicationId);
  if (!application) throw new AppError('Application not found', 404);

  application.rtoActivityLog.push({
    action,
    userId,
    detail: detail || '',
    timestamp: new Date(),
  });
  await application.save();
  return { message: 'Activity logged' };
};

const sendToRTOPortal = async (applicationId, rtoUserId) => {
  const UserModel = require('../models/User');
  const rtoUser = await UserModel.findById(rtoUserId).lean();
  if (!rtoUser) throw new AppError('RTO user not found', 404);

  const rtoName = `${rtoUser.firstName || ''} ${rtoUser.lastName || ''}`.trim();

  const application = await Application.findByIdAndUpdate(
    applicationId,
    {
      assignedRTOId: rtoUserId,
      rtoAssignmentDate: new Date(),
      sentToRTOPortal: true,
      sentToRTOPortalAt: new Date(),
      portalRtoEmail: rtoUser.email,
      portalRtoName: rtoName,
      status: 'SentToRTO',
    },
    { new: true, runValidators: true }
  )
    .populate('studentId industryId qualificationId assignedAgentId assignedRTOId paymentPlanId certificateId')
    .lean();

  if (!application) throw new AppError('Application not found', 404);

  // Notify RTO user — in-portal + email (non-fatal)
  try {
    const { notifyWithEmail } = require('./notificationService');
    const student = application.studentId;
    const studentName = student ? `${student.firstName || ''} ${student.lastName || ''}`.trim() : 'a student';
    const qualName = application.qualificationId?.name || '';
    await notifyWithEmail(
      rtoUserId,
      {
        type: 'application_assigned',
        title: 'New Application Sent for Review',
        message: `Application ${application.applicationId} for ${studentName}${qualName ? ` — ${qualName}` : ''} has been sent to you for review.`,
        link: '/rto/applications',
        relatedId: application._id,
      },
      {
        subject: `New Application for Review: ${application.applicationId} — ${studentName}`,
        ctaText: 'Review Application',
      }
    );
  } catch (err) {
    console.error('[SendToRTOPortal] Failed to notify:', err.message);
  }

  // Try to start the 21-day timer — requires both student completion + RTO assignment
  await tryAutoStartTimer(applicationId);

  // Create RTO submission version record
  try {
    await createRTOSubmission(applicationId, {
      sentBy: rtoUserId,
      documentsIncluded: [],
      emailSent: false,
    });
  } catch (err) {
    console.error('[SendToRTOPortal] Failed to create submission record:', err.message);
  }

  return application;
};

const sendRTOSubmission = async (applicationId, { rtoEmail, rtoName }) => {
  const application = await Application.findByIdAndUpdate(
    applicationId,
    {
      sentToRTOEmail: true,
      sentToRTOEmailAt: new Date(),
      rtoSubmissionEmail: rtoEmail,
      rtoSubmissionName: rtoName || rtoEmail,
    },
    { new: true, runValidators: true }
  )
    .populate('studentId industryId qualificationId assignedAgentId assignedRTOId paymentPlanId certificateId')
    .lean();

  if (!application) throw new AppError('Application not found', 404);

  // ── Build and send the RTO assessment email ──
  // NOTE: No payment or internal process info is shared with external RTOs.
  // Generates Student Intake Form PDF + collects all document links.
  try {
    const {
      buildEmail, heading2, paragraph, detailsTable,
      divider, signOff, sendEmail, T,
    } = require('./emailService');
    const Document = require('../models/Document');
    const IntakeForm = require('../models/IntakeForm');
    const generateStudentIntakePdf = require('../utils/generateStudentIntakePdf');

    // Fetch intake form for student details
    const intakeForm = application.intakeFormId
      ? await IntakeForm.findById(application.intakeFormId).lean()
      : null;

    // Fetch all documents for this application
    const documents = await Document.find({ applicationId: application._id }).lean();

    // Student info
    const student = application.studentId || {};
    const studentName = `${student.firstName || ''} ${student.lastName || ''}`.trim() || 'Student';
    const qualification = application.qualificationId || {};

    // Generate Student Intake Form PDF
    const pdfAttachments = [];
    if (intakeForm) {
      try {
        const pdfBuffer = await generateStudentIntakePdf(
          intakeForm,
          application.applicationId,
          qualification.name || ''
        );
        pdfAttachments.push({
          filename: `Student_Intake_Form_${application.applicationId}.pdf`,
          content: pdfBuffer,
          contentType: 'application/pdf',
        });
      } catch (pdfErr) {
        console.error('[RTO Submission] PDF generation failed:', pdfErr.message);
      }
    }
    const industry = application.industryId || {};

    // Normalise Drive URL to a publicly accessible link
    const toPublicUrl = (raw) => {
      if (!raw) return null;
      const m = raw.match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
      if (m) return `https://drive.google.com/file/d/${m[1]}/view?usp=sharing`;
      const m2 = raw.match(/[?&]id=([a-zA-Z0-9_-]+)/);
      if (m2) return `https://drive.google.com/file/d/${m2[1]}/view?usp=sharing`;
      return raw;
    };

    // Build document links grouped by type
    const docsByType = {};
    documents.forEach((doc) => {
      const type = doc.fieldName || doc.documentType || 'Other';
      if (!docsByType[type]) docsByType[type] = [];
      const rawLink = doc.googleDriveLink
        || (doc.googleDriveFileId ? `https://drive.google.com/file/d/${doc.googleDriveFileId}/view` : null);
      const link = toPublicUrl(rawLink);
      if (link) {
        docsByType[type].push({ name: doc.fileName, link });
      }
    });

    // Build document links HTML — each doc as a clickable card-style link
    const docCount = Object.values(docsByType).reduce((s, d) => s + d.length, 0);
    const docLinksHtml = Object.entries(docsByType).map(([type, docs]) => {
      const links = docs.map((d) =>
        `<a href="${d.link}" target="_blank" style="display:block;padding:10px 14px;margin:4px 0;background:#f9fafb;border-radius:8px;border:1px solid #e5e7eb;color:${T.primary};text-decoration:none;font-family:${T.fontStack};font-size:13px;font-weight:500;">` +
          `&#128196; ${d.name}` +
        `</a>`
      ).join('');
      return `<tr>` +
        `<td style="padding:10px 0;border-bottom:1px solid ${T.dividerColor};font-family:${T.fontStack};font-size:13px;color:${T.textTertiary};font-weight:600;text-transform:uppercase;letter-spacing:0.4px;width:30%;vertical-align:top;">${type}</td>` +
        `<td style="padding:6px 0 6px 16px;border-bottom:1px solid ${T.dividerColor};vertical-align:top;">${links}</td>` +
      `</tr>`;
    }).join('');

    const docSection = docCount > 0
      ? `<table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="margin:20px 0;border-radius:12px;background:#fff;border:1px solid ${T.primaryBorder};overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.04);">` +
          `<tr><td style="padding:18px 20px 0 20px;border-bottom:2px solid ${T.primaryLight};">` +
            `<p style="margin:0 0 12px 0;font-family:${T.fontStack};font-size:14px;font-weight:700;color:${T.primary};text-transform:uppercase;letter-spacing:0.6px;">Supporting Documents (${docCount})</p>` +
            `<p style="margin:0 0 14px 0;font-family:${T.fontStack};font-size:13px;color:${T.textTertiary};">Click on any document below to view or download:</p>` +
          `</td></tr>` +
          `<tr><td style="padding:4px 20px 16px 20px;"><table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">${docLinksHtml}</table></td></tr>` +
        `</table>`
      : '';

    // PDF attachment notice for the email
    const pdfNotice = pdfAttachments.length > 0
      ? `<table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="margin:20px 0;border-radius:12px;background:#eff6ff;border:1px solid #93c5fd;border-left:4px solid #2563eb;overflow:hidden;">` +
          `<tr><td style="padding:16px 20px;">` +
            `<p style="margin:0 0 6px 0;font-family:${T.fontStack};font-size:14px;font-weight:700;color:#1e40af;">&#128206; Attached Documents (${pdfAttachments.length} PDF${pdfAttachments.length > 1 ? 's' : ''})</p>` +
            `<ul style="margin:4px 0 0 0;padding:0 0 0 18px;">` +
              pdfAttachments.map((att) =>
                `<li style="font-family:${T.fontStack};font-size:13px;color:#1e40af;margin-bottom:2px;"><strong>${att.filename}</strong></li>`
              ).join('') +
            `</ul>` +
            `<p style="margin:8px 0 0 0;font-family:${T.fontStack};font-size:12px;color:#3b82f6;">These forms are attached to this email for your convenience.</p>` +
          `</td></tr>` +
        `</table>`
      : '';

    // Compose the email body — NO payment or internal process info
    const emailBody = buildEmail(
      heading2(`New Application Submission`) +
      paragraph(`Application ID: <strong>${application.applicationId}</strong> &nbsp;|&nbsp; Submitted: ${new Date().toLocaleDateString('en-AU', { day: '2-digit', month: 'long', year: 'numeric' })}`) +
      paragraph(`Dear RTO Assessment Team,`) +
      paragraph(`Please find below the complete application details for your assessment. All supporting documents are securely hosted and accessible via the links provided.`) +
      pdfNotice +
      detailsTable('Student Information', [
        { label: 'Full Name', value: studentName },
        { label: 'Email', value: student.email || intakeForm?.email || '—' },
        { label: 'Phone', value: student.phone || intakeForm?.phoneNumber || '—' },
        { label: 'USI', value: student.usi || intakeForm?.usi || '—' },
        { label: 'State', value: intakeForm?.state || '—' },
        { label: 'Date of Birth', value: intakeForm?.dateOfBirth ? new Date(intakeForm.dateOfBirth).toLocaleDateString('en-AU') : '—' },
        ...(intakeForm?.employmentStatus ? [{ label: 'Employment', value: intakeForm.employmentStatus }] : []),
      ]) +
      detailsTable('Course Information', [
        { label: 'Industry', value: industry.name || '—' },
        { label: 'Qualification', value: qualification.name || '—' },
        { label: 'Qualification Code', value: qualification.code || '—' },
        { label: 'Application ID', value: application.applicationId },
      ]) +
      docSection +
      divider() +
      paragraph('Should you require any additional information or documentation, please do not hesitate to reply to this email or contact our team directly.') +
      signOff()
    );

    const subject = `[EXTERNAL] Application for ${studentName} — ${qualification.name || 'Assessment Ready'}`;

    await sendEmail({
      to: rtoEmail,
      subject,
      html: emailBody,
      attachments: pdfAttachments,
    });

    console.log('[RTO Submission] Email sent to %s for app %s (%d PDFs, %d doc links)', rtoEmail, application.applicationId, pdfAttachments.length, docCount);

    // Create RTO submission version record
    try {
      await createRTOSubmission(applicationId, {
        sentBy: null,
        documentsIncluded: documents.map((d) => d.fileName || d.fieldName || 'document'),
        emailSent: true,
      });
    } catch (vErr) {
      console.error('[RTO Submission] Version record failed:', vErr.message);
    }
  } catch (emailErr) {
    console.error('[RTO Submission] Email failed for app %s:', application.applicationId, emailErr.message);
    // Don't throw — the DB update succeeded, email is best-effort
  }

  return application;
};

const updateStatus = async (applicationId, status) => {
  const update = { status };

  // Save previous status before archiving so it can be restored later
  if (status === 'Archived') {
    const currentApp = await Application.findById(applicationId).select('status').lean();
    if (currentApp && currentApp.status !== 'Archived') {
      update.previousStatus = currentApp.status;
    }
  }

  // Validate required documents before allowing DocumentsUploaded status
  if (status === 'DocumentsUploaded') {
    const app = await Application.findById(applicationId)
      .populate('qualificationId industryId')
      .lean();
    if (!app) throw new AppError('Application not found', 404);

    const docs = await Document.find({ applicationId }).select('fieldName').lean();
    const uploadedFields = new Set(docs.map((d) => d.fieldName));
    const fieldCount = (name) => docs.filter((d) => d.fieldName === name).length;

    const missing = [];

    // 1. ID Verification — need >= 100 points
    const idDocs = [
      { name: "Driver's License", points: 40 }, { name: 'ID Card', points: 40 },
      { name: 'Passport', points: 70 }, { name: 'Birth Certificate', points: 70 },
      { name: 'Medicare Card', points: 25 }, { name: 'Credit Card', points: 15 },
      { name: 'Australian Citizenship', points: 70 },
    ];
    const idPoints = idDocs.reduce((sum, d) => sum + (uploadedFields.has(d.name) ? d.points : 0), 0);
    if (idPoints < 100) missing.push(`ID Verification (${idPoints}/100 points)`);

    // 2. Educational Documents
    const qual = typeof app.qualificationId === 'object' ? app.qualificationId : null;
    const eduRequired = ['USI VET Transcript', 'USI Portal Screenshot'];
    if (qual?.requiresWhiteCard || qual?.category === 'trade') eduRequired.push('White Card');
    if (qual?.requiresFirstAid) eduRequired.push('First Aid Certificate');
    eduRequired.push('Previous Qualifications');
    eduRequired.forEach((name) => { if (!uploadedFields.has(name)) missing.push(name); });

    // 3. Employment Details
    const empRequired = [
      { name: 'Resume' }, { name: 'Employment Letter' }, { name: 'Reference One' },
      { name: 'Payslips/Invoices', min: 3 },
    ];
    empRequired.forEach((d) => {
      if (d.min) { if (fieldCount(d.name) < d.min) missing.push(`${d.name} (${fieldCount(d.name)}/${d.min})`); }
      else { if (!uploadedFields.has(d.name)) missing.push(d.name); }
    });

    // 4. Visual Evidence — only for specific industries
    const VISUAL_EVIDENCE_INDUSTRIES = [
      'automotive', 'building & construction', 'hospitality',
      'information & communications technology', 'beauty therapy & hairdressing',
    ];
    const industryName = (typeof app.industryId === 'object' ? app.industryId?.name : '').toLowerCase();
    if (VISUAL_EVIDENCE_INDUSTRIES.some((n) => industryName.includes(n))) {
      if (fieldCount('images') < 10) missing.push(`Photos (${fieldCount('images')}/10)`);
      if (fieldCount('videos') < 5) missing.push(`Videos (${fieldCount('videos')}/5)`);
    }

    if (missing.length > 0) {
      throw new AppError(`Cannot submit documents. Missing: ${missing.join(', ')}`, 400);
    }

    update.documentsUploaded = true;
  }

  // Stop the 21-day timer when RTO invoice is uploaded
  if (status === 'RTOInvoiceUploaded') {
    const app = await Application.findById(applicationId).lean();
    if (app?.timerStartedAt && !app.timerStoppedAt) {
      const now = new Date();
      update.timerStoppedAt = now;
      update.timerDaysElapsed = Math.floor(
        (now.getTime() - new Date(app.timerStartedAt).getTime()) / (1000 * 60 * 60 * 24)
      );
    }
  }

  await Application.findByIdAndUpdate(
    applicationId,
    update,
    { runValidators: true }
  );

  // Check if all student obligations are met — auto-advance to StudentCompleted
  await tryAutoStartTimer(applicationId);

  // Re-read after tryAutoStartTimer may have advanced the status
  const application = await Application.findById(applicationId)
    .populate('studentId industryId qualificationId assignedAgentId assignedRTOId paymentPlanId certificateId screeningFormId')
    .lean();

  if (!application) {
    throw new AppError('Application not found', 404);
  }

  const finalStatus = application.status;

  // Keep Payment.isArchived in sync so revenue/cashflow metrics exclude (or
  // re-include) this application's payments when it is archived/unarchived.
  await Payment.updateMany({ applicationId }, { $set: { isArchived: finalStatus === 'Archived' } });

  // Send notifications for key status changes (non-fatal)
  try {
    const { createNotification } = require('./notificationService');
    const studentId = application.studentId?._id || application.studentId;
    const rtoId = application.assignedRTOId?._id || application.assignedRTOId;
    const statusLabel = status.replace(/([A-Z])/g, ' $1').trim();

    // Notify student on important milestones
    const studentStatuses = {
      SentToRTO: 'Your application has been sent to the RTO for assessment.',
      WaitingForVerification: 'Your application is being verified.',
      CertificateGenerated: 'Great news — your certificate has been generated!',
      StudentCompleted: 'Your student requirements are now complete.',
    };
    // Also notify if auto-advanced to StudentCompleted
    if (finalStatus === 'StudentCompleted' && status !== 'StudentCompleted' && studentStatuses.StudentCompleted && studentId) {
      await createNotification({
        userId: studentId,
        type: 'status_changed',
        title: 'Status: Student Completed',
        message: studentStatuses.StudentCompleted,
        link: '/student/applications',
        relatedId: application._id,
      });
    }
    if (studentStatuses[status] && studentId) {
      await createNotification({
        userId: studentId,
        type: 'status_changed',
        title: `Status: ${statusLabel}`,
        message: studentStatuses[status],
        link: '/student/applications',
        relatedId: application._id,
      });
    }

    // Notify RTO when application is sent to them
    if (status === 'SentToRTO' && rtoId) {
      await createNotification({
        userId: rtoId,
        type: 'status_changed',
        title: 'Application Ready for Review',
        message: `${application.applicationId} has been sent to you for assessment.`,
        link: '/rto/applications',
        relatedId: application._id,
      });
    }
  } catch (err) {
    console.error('[UpdateStatus] Failed to create notification:', err.message);
  }

  // Auto-create RTO payable when invoice is uploaded — enters the AP queue
  if (status === 'RTOInvoiceUploaded') {
    try {
      const qual = application.qualificationId;
      const rto = application.assignedRTOId;
      if (qual && rto) {
        const rtoEntry = qual.rtoCosts?.find(
          (r) => r.rtoId && String(r.rtoId) === String(rto._id || rto)
        ) || qual.rtoCosts?.[0];
        const rtoCost = rtoEntry?.rtoCost || 0;

        if (rtoCost > 0) {
          await Payment.create({
            applicationId: application._id,
            studentId: application.studentId?._id || application.studentId,
            amount: rtoCost,
            type: 'rtoPayable',
            paymentMethod: 'manual',
            status: 'pending',
            notes: `Auto-created RTO payable for ${application.applicationId} — ${rtoEntry?.rtoName || 'RTO'}`,
          });

          // Link payment to application
          await Application.findByIdAndUpdate(applicationId, {
            $push: { paymentIds: (await Payment.findOne({ applicationId: application._id, type: 'rtoPayable' }).sort('-createdAt'))._id },
          });
        }
      }
    } catch (err) {
      console.error('[UpdateStatus] Failed to create RTO payable:', err.message);
    }
  }

  return application;
};

/**
 * Restore an archived application to its previous status.
 * Uses previousStatus if saved, otherwise derives from completion flags.
 */
const restoreFromArchive = async (applicationId) => {
  const app = await Application.findById(applicationId);
  if (!app) throw new AppError('Application not found', 404);
  if (app.status !== 'Archived') throw new AppError('Application is not archived', 400);

  let restoredStatus = app.previousStatus;

  // Fallback: derive status from completion flags if previousStatus not stored
  if (!restoredStatus) {
    if (app.certificateId) {
      restoredStatus = 'CertificateGenerated';
    } else if (app.documentsUploaded && app.intakeFormSubmitted && app.paymentCompleted) {
      restoredStatus = 'StudentCompleted';
    } else if (app.documentsUploaded) {
      restoredStatus = 'DocumentsUploaded';
    } else if (app.intakeFormSubmitted) {
      restoredStatus = 'UploadDocuments';
    } else if (app.paymentCompleted || app.partialPayment) {
      restoredStatus = 'StudentIntakeForm';
    } else {
      restoredStatus = 'New';
    }
  }

  app.status = restoredStatus;
  app.previousStatus = undefined;
  await app.save();

  // Re-include this application's payments in revenue/cashflow metrics.
  await Payment.updateMany({ applicationId }, { $set: { isArchived: false } });

  const application = await Application.findById(applicationId)
    .populate('studentId industryId qualificationId assignedAgentId assignedRTOId paymentPlanId certificateId screeningFormId')
    .lean();

  return application;
};

const createIntakeForm = async (applicationId, data) => {
  const application = await Application.findById(applicationId);

  if (!application) {
    throw new AppError('Application not found', 404);
  }

  const intakeForm = await IntakeForm.create({
    ...data,
    applicationId,
    submittedAt: data.submittedAt || new Date(),
    status: data.status || 'submitted',
  });

  application.intakeFormId = intakeForm._id;
  application.intakeFormSubmitted = true;
  if (data.markSubmitted !== false) {
    application.status = 'UploadDocuments';
  }
  await application.save();

  // Check if all 3 student obligations are met — auto-start 21-day timer
  await tryAutoStartTimer(application._id);

  return intakeFormCrud.getById(intakeForm._id);
};

const createScreeningForm = async (applicationId, data) => {
  const application = await Application.findById(applicationId);

  if (!application) {
    throw new AppError('Application not found', 404);
  }

  const screeningForm = await ScreeningForm.create({
    ...data,
    applicationId,
    submittedAt: data.submittedAt || new Date(),
    status: data.status || 'submitted',
  });

  application.screeningFormId = screeningForm._id;
  await application.save();

  return screeningFormCrud.getById(screeningForm._id);
};

const uploadDocument = async (applicationId, data) => {
  const application = await Application.findById(applicationId);

  if (!application) {
    throw new AppError('Application not found', 404);
  }

  const document = await Document.create({
    ...data,
    applicationId,
    studentId: application.studentId,
    rtoAccessExpiresAt: data.rtoAccessExpiresAt || new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
  });

  application.documentIds = application.documentIds || [];
  application.documentIds.push(document._id);
  await application.save();

  // Check if all 3 student obligations are met — auto-start 21-day timer
  await tryAutoStartTimer(application._id);

  return documentCrud.getById(document._id);
};

const issueCertificate = async (applicationId, data) => {
  const application = await Application.findById(applicationId).populate('studentId');

  if (!application) {
    throw new AppError('Application not found', 404);
  }

  const certificate = await Certificate.create({
    ...data,
    applicationId,
    studentId: application.studentId._id || application.studentId,
  });

  application.certificateId = certificate._id;
  application.status = 'CertificateIssued';
  await application.save();

  // Create in-portal notification only (email handled by notifySoftCopy)
  try {
    const { createNotification } = require('./notificationService');
    const studentId = application.studentId._id || application.studentId;
    await createNotification({
      userId: studentId,
      type: 'certificate_issued',
      title: 'Certificate Issued',
      message: 'Your certificate soft copy has been uploaded and is ready for download.',
      link: '/student/certificates',
      relatedId: application._id,
    });
  } catch (err) {
    console.error('[CertificateService] Failed to create notification:', err.message);
  }

  return certificateCrud.getById(certificate._id);
};

/**
 * Soft-copy certificate upload — triggers soft-copy email with Google review link.
 * Separate from hard-copy dispatch (CA-11).
 */
const notifySoftCopy = async (certificateId) => {
  const certificate = await Certificate.findById(certificateId).populate('studentId');
  if (!certificate) throw new AppError('Certificate not found', 404);

  certificate.softCopyUploadedAt = new Date();
  certificate.softCopyEmailSentAt = new Date();
  await certificate.save();

  const student = certificate.studentId;
  if (student?.email) {
    const { sendTemplatedEmail } = require('./emailService');
    await sendTemplatedEmail({
      to: student.email,
      subject: 'Your Certificate Soft Copy is Ready — Certified Australia',
      preheader: 'Your certificate has been uploaded and is available to view.',
      templateContent: `
        <h2 style="margin:0 0 8px;">Your Certificate is Ready!</h2>
        <p>Hi ${student.firstName || 'there'},</p>
        <p>Great news — your certificate soft copy has been uploaded and is now available for you to view and download from your student portal.</p>
        <p>Thank you for your patience and cooperation throughout the process.</p>
        <div style="background-color:#ecfdf5;border:1px solid #a7f3d0;border-radius:8px;padding:16px;margin:16px 0;">
          <p style="margin:0 0 8px;font-weight:600;color:#065f46;">We'd love your feedback!</p>
          <p style="margin:0;color:#047857;">If you had a great experience, we'd really appreciate a Google review:</p>
          <p style="margin:8px 0 0;"><a href="https://www.google.com/maps/search/Certified+Australia+Group" style="color:#059669;text-decoration:underline;font-weight:600;">Leave a Google Review &rarr;</a></p>
        </div>
        <p style="font-size:13px;color:#6b7280;">Note: Your hard-copy certificate will be posted separately. We'll send you a tracking number once it's dispatched.</p>
      `,
      ctaText: 'View Your Certificate',
      ctaUrl: `${process.env.APP_BASE_URL || 'http://localhost:5173'}/student/certificates`,
    }).catch((err) => console.error('[CertificateService] Soft-copy email error:', err.message));
  }

  return Certificate.findById(certificateId).lean();
};

/**
 * Hard-copy certificate dispatch — triggers hard-copy email with AusPost tracking.
 * Separate from soft-copy upload (CA-11).
 */
const dispatchHardCopy = async (certificateId, { trackingNumber, trackingLink }) => {
  const certificate = await Certificate.findById(certificateId).populate('studentId');
  if (!certificate) throw new AppError('Certificate not found', 404);

  certificate.trackingNumber = trackingNumber;
  certificate.trackingLink = trackingLink;
  certificate.status = 'in_delivery';
  certificate.hardCopyDispatchedAt = new Date();
  certificate.hardCopyEmailSentAt = new Date();
  certificate.hardCopySentKPI = true;
  certificate.dispatchedAt = new Date();
  await certificate.save();

  const student = certificate.studentId;
  if (student?.email) {
    const { sendTemplatedEmail } = require('./emailService');
    await sendTemplatedEmail({
      to: student.email,
      subject: 'Your Hard-Copy Certificate Has Been Posted — Certified Australia',
      preheader: 'Your certificate has been dispatched via Australia Post.',
      templateContent: `
        <h2 style="margin:0 0 8px;">Your Certificate is On Its Way!</h2>
        <p>Hi ${student.firstName || 'there'},</p>
        <p>Your hard-copy certificate has been posted and is on its way to you via Australia Post.</p>
        <div style="background-color:#ecfdf5;border:1px solid #a7f3d0;border-radius:8px;padding:16px;margin:16px 0;">
          <p style="margin:0 0 4px;font-weight:600;color:#065f46;">Tracking Details</p>
          ${trackingNumber ? `<p style="margin:0;color:#047857;">Tracking Number: <strong>${trackingNumber}</strong></p>` : ''}
          ${trackingLink ? `<p style="margin:4px 0 0;"><a href="${trackingLink}" style="color:#059669;text-decoration:underline;">Track your delivery on AusPost &rarr;</a></p>` : ''}
        </div>
        <p>If you have any questions about your delivery, please don't hesitate to contact us.</p>
      `,
      ctaText: 'Track Delivery',
      ctaUrl: trackingLink || `${process.env.APP_BASE_URL || 'http://localhost:5173'}/student/certificates`,
    }).catch((err) => console.error('[CertificateService] Hard-copy email error:', err.message));
  }

  return Certificate.findById(certificateId).lean();
};

/**
 * Mark certificate as delivered — triggered by admin or student.
 */
const markCertificateDelivered = async (certificateId, { confirmedBy = 'staff' } = {}) => {
  const certificate = await Certificate.findById(certificateId);
  if (!certificate) throw new AppError('Certificate not found', 404);

  certificate.status = 'delivered';
  certificate.deliveredAt = new Date();
  certificate.deliveredConfirmedBy = confirmedBy;
  await certificate.save();

  return Certificate.findById(certificateId).lean();
};

const addNote = async (applicationId, note) => {
  const application = await Application.findById(applicationId);

  if (!application) {
    throw new AppError('Application not found', 404);
  }

  application.notes.push({
    content: note.content,
    addedBy: note.addedBy,
    authorRole: note.authorRole,
    authorName: note.authorName,
    visibility: note.visibility,
    addedAt: note.addedAt || new Date(),
  });

  await application.save();
  return refreshApplication(application._id);
};

/**
 * Search notes across all applications by keyword.
 */
const searchNotes = async (query, { visibility, limit = 50 } = {}) => {
  const filter = { 'notes.content': { $regex: query, $options: 'i' } };
  const apps = await Application.find(filter)
    .populate('studentId', 'firstName lastName')
    .populate('notes.addedBy', 'firstName lastName')
    .select('applicationId studentId notes')
    .lean();

  const results = [];
  for (const app of apps) {
    for (const note of app.notes || []) {
      if (!note.content?.match(new RegExp(query, 'i'))) continue;
      if (visibility && note.visibility !== visibility) continue;
      results.push({
        applicationId: app.applicationId,
        applicationObjId: app._id,
        studentName: app.studentId ? `${app.studentId.firstName} ${app.studentId.lastName}` : 'Unknown',
        noteId: note._id,
        content: note.content,
        addedBy: note.addedBy,
        addedAt: note.addedAt,
        visibility: note.visibility,
      });
    }
  }

  return results.sort((a, b) => new Date(b.addedAt) - new Date(a.addedAt)).slice(0, limit);
};

/**
 * Edit a note on an application (only author or admin).
 */
const editNote = async (applicationId, noteId, { content, userId, userRole }) => {
  const application = await Application.findById(applicationId);
  if (!application) throw new AppError('Application not found', 404);

  const note = application.notes.id(noteId);
  if (!note) throw new AppError('Note not found', 404);

  // Permission check: only author or admin can edit
  if (String(note.addedBy) !== String(userId) && userRole !== 'Admin' && userRole !== 'CEOReportingManager') {
    throw new AppError('You do not have permission to edit this note', 403);
  }

  note.content = content;
  await application.save();
  return refreshApplication(application._id);
};

/**
 * Delete a note from an application (only author or admin).
 */
const deleteNote = async (applicationId, noteId, { userId, userRole }) => {
  const application = await Application.findById(applicationId);
  if (!application) throw new AppError('Application not found', 404);

  const note = application.notes.id(noteId);
  if (!note) throw new AppError('Note not found', 404);

  if (String(note.addedBy) !== String(userId) && userRole !== 'Admin' && userRole !== 'CEOReportingManager') {
    throw new AppError('You do not have permission to delete this note', 403);
  }

  note.deleteOne();
  await application.save();
  return refreshApplication(application._id);
};

const addDiscount = async (applicationId, { amount, note, createdBy }) => {
  const application = await Application.findById(applicationId);
  if (!application) throw new AppError('Application not found', 404);
  if (!amount || amount <= 0) throw new AppError('Discount amount must be greater than 0', 400);

  // Ensure discounts array exists (legacy documents may not have it)
  if (!application.discounts) application.discounts = [];

  application.discounts.push({
    amount: Number(amount),
    note: note || '',
    createdBy: createdBy || undefined,
    createdAt: new Date(),
  });

  // Track the automatic signup discount. Registration sets this flag, so a later $500
  // is an additional admin discount rather than the signup one — allowed, but logged so
  // an accidental double-up is visible.
  if (Number(amount) === SIGNUP_DISCOUNT_AMOUNT) {
    if (application.signupDiscountApplied) {
      console.warn(
        '[ApplicationService] %s already has the $%d signup discount; adding another $%d discount as an additional discount.',
        application.applicationId,
        SIGNUP_DISCOUNT_AMOUNT,
        SIGNUP_DISCOUNT_AMOUNT
      );
    } else {
      application.signupDiscountApplied = true;
    }
  }

  await application.save();

  // Edge case: if this application already has a payment plan, fold the new discount into
  // it by re-splitting the reduced balance evenly across the pending installments. Paid
  // and partially-paid installments are left untouched. Wrapped so a redistribution hiccup
  // never blocks recording the discount itself. Lazy require avoids the paymentService ↔
  // applicationService circular dependency.
  if (application.paymentPlanId) {
    try {
      const paymentService = require('./paymentService');
      await paymentService.redistributePendingForDiscount(application.paymentPlanId, Number(amount));
    } catch (err) {
      console.error('[ApplicationService] addDiscount plan redistribution error:', err.message);
    }
  }

  const freshApp = await refreshApplication(application._id);

  // Send discount notification email to student (non-blocking)
  const User = require('../models/User');
  User.findById(application.studentId)
    .select('firstName email')
    .lean()
    .then((student) => {
      if (student?.email && freshApp.applicationId) {
        // caPrice is the qualification list price; derive original and new effective prices
        const caPrice = freshApp.qualificationId?.caPrice || 0;
        const totalDiscountAfter = (freshApp.discounts || []).reduce((s, d) => s + (d.amount || 0), 0);
        const newPrice = Math.max(0, caPrice - totalDiscountAfter);
        const originalPrice = newPrice + Number(amount);
        appEmails
          .sendDiscountAppliedEmail(student, freshApp, originalPrice, Number(amount), newPrice)
          .catch((err) => console.error('[ApplicationService] sendDiscountAppliedEmail error:', err.message));
      }
    })
    .catch((err) => console.error('[ApplicationService] addDiscount student lookup error:', err.message));

  return freshApp;
};

const removeDiscount = async (applicationId, discountId) => {
  const application = await Application.findById(applicationId);
  if (!application) throw new AppError('Application not found', 404);

  const discount = application.discounts.id(discountId);
  if (!discount) throw new AppError('Discount not found', 404);

  const removedAmount = Number(discount.amount) || 0;
  discount.deleteOne();
  await application.save();

  // Inverse of addDiscount: give the removed amount back to the plan's pending
  // installments (evenly re-split). Non-blocking; skips when there is no plan.
  if (application.paymentPlanId && removedAmount > 0) {
    try {
      const paymentService = require('./paymentService');
      await paymentService.redistributePendingForDiscount(application.paymentPlanId, -removedAmount);
    } catch (err) {
      console.error('[ApplicationService] removeDiscount plan redistribution error:', err.message);
    }
  }

  return refreshApplication(application._id);
};

// ── Additional Document Requests (CA-08 gated upload) ──

const createAdditionalDocRequest = async (applicationId, { items, deadline, requestedBy }) => {
  const application = await Application.findById(applicationId);
  if (!application) throw new AppError('Application not found', 404);

  application.additionalDocRequests.push({
    requestedBy,
    requestedAt: new Date(),
    items: items || [],
    deadline: deadline || undefined,
    status: 'open',
  });
  await application.save();

  // Notify student
  const { notifyWithEmail } = require('./notificationService');
  if (application.studentId) {
    const student = await require('../models/User').findById(application.studentId).select('firstName').lean();
    const itemLabels = (items || []).map((i) => i.label).join(', ');
    await notifyWithEmail(
      application.studentId,
      {
        type: 'feedback_received',
        title: 'Additional Documents Required',
        message: `Please upload the following documents: ${itemLabels}`,
        link: `/student/documents`,
        relatedId: application._id,
      },
      { subject: 'Additional Documents Required — Certified Australia' }
    );
  }

  return refreshApplication(application._id);
};

const submitAdditionalDocs = async (applicationId, requestId) => {
  const application = await Application.findById(applicationId)
    .populate('studentId', 'firstName lastName');
  if (!application) throw new AppError('Application not found', 404);

  const request = application.additionalDocRequests.id(requestId);
  if (!request) throw new AppError('Request not found', 404);
  if (request.status !== 'open') throw new AppError('Request is not open for submission', 400);

  request.status = 'submitted';
  request.submittedAt = new Date();
  await application.save();

  // Notify admins that additional docs have been submitted
  const { notifyMany } = require('./notificationService');
  const User = require('../models/User');
  const admins = await User.find({ role: { $in: ['Admin', 'CEOReportingManager'] }, isActive: true }).select('_id').lean();
  const studentName = application.studentId
    ? `${application.studentId.firstName} ${application.studentId.lastName}`
    : 'Student';
  if (admins.length > 0) {
    await notifyMany(
      admins.map((a) => a._id),
      {
        type: 'feedback_received',
        title: 'Additional Documents Submitted',
        message: `${studentName} has submitted additional documents for ${application.applicationId}. Review required.`,
        link: `/admin/students/${application.studentId?._id || application.studentId}`,
        relatedId: application._id,
      }
    );
  }

  return refreshApplication(application._id);
};

const reviewAdditionalDocs = async (applicationId, requestId, { status, reviewNotes, reviewedBy }) => {
  const application = await Application.findById(applicationId);
  if (!application) throw new AppError('Application not found', 404);

  const request = application.additionalDocRequests.id(requestId);
  if (!request) throw new AppError('Request not found', 404);

  request.status = status; // 'approved' or 'rejected'
  request.reviewedBy = reviewedBy;
  request.reviewedAt = new Date();
  request.reviewNotes = reviewNotes || '';
  await application.save();

  // Notify student of approval/rejection
  const { notifyWithEmail } = require('./notificationService');
  if (application.studentId) {
    const isApproved = status === 'approved';
    await notifyWithEmail(
      application.studentId,
      {
        type: 'document_reviewed',
        title: isApproved ? 'Documents Approved' : 'Documents Need Attention',
        message: isApproved
          ? `Your additional documents for ${application.applicationId} have been approved.`
          : `Your additional documents for ${application.applicationId} were not approved. ${reviewNotes || 'Please check with admin.'}`,
        link: `/student/documents`,
        relatedId: application._id,
      },
      { subject: isApproved ? 'Documents Approved — Certified Australia' : 'Documents Need Attention — Certified Australia' }
    );
  }

  return refreshApplication(application._id);
};

// ── RTO Submission Versioning (CA-08 duplicate prevention) ──

async function createRTOSubmission(applicationId, { sentBy, documentsIncluded, emailSent }) {
  const application = await Application.findById(applicationId);
  if (!application) throw new AppError('Application not found', 404);

  // Supersede all previous submissions
  for (const sub of application.rtoSubmissions) {
    sub.superseded = true;
  }

  const version = (application.rtoSubmissions.length || 0) + 1;
  application.rtoSubmissions.push({
    sentAt: new Date(),
    sentBy,
    packageVersion: version,
    documentsIncluded: documentsIncluded || [],
    emailSent: emailSent || false,
    superseded: false,
  });

  await application.save();
  return refreshApplication(application._id);
}

const reviewDocument = async (applicationId, documentId, reviewData) => {
  const application = await Application.findById(applicationId);
  if (!application) throw new AppError('Application not found', 404);

  const document = await Document.findById(documentId);
  if (!document) throw new AppError('Document not found', 404);

  if (String(document.applicationId) !== String(applicationId)) {
    throw new AppError('Document does not belong to this application', 400);
  }

  if (reviewData.status) document.status = reviewData.status;
  if (reviewData.feedback) document.feedback = reviewData.feedback;
  if (reviewData.verifiedBy) document.verifiedBy = reviewData.verifiedBy;
  if (reviewData.status === 'verified') document.verifiedAt = new Date();

  await document.save();
  return documentCrud.getById(document._id);
};

/**
 * Get timer status for an application. Timer is AUTOMATIC — no manual pause/resume.
 * Count-up from timerStartedAt. Stops when timerStoppedAt is set (RTO invoice uploaded).
 * The timer is a KPI for internal management visibility only, not shown to RTOs.
 */
const getTimerStatus = async (applicationId) => {
  const application = await Application.findById(applicationId).lean();
  if (!application) throw new AppError('Application not found', 404);

  const now = new Date();

  // Not started
  if (!application.timerStartedAt) {
    return { status: 'not_started', daysElapsed: null, timerStartedAt: null, timerStoppedAt: null, timerDaysElapsed: null };
  }

  // Stopped (RTO invoice uploaded)
  if (application.timerStoppedAt) {
    return {
      status: 'stopped',
      daysElapsed: application.timerDaysElapsed,
      timerStartedAt: application.timerStartedAt,
      timerStoppedAt: application.timerStoppedAt,
      timerDaysElapsed: application.timerDaysElapsed,
    };
  }

  // Running — calculate live days elapsed
  const daysElapsed = Math.floor(
    (now.getTime() - new Date(application.timerStartedAt).getTime()) / (1000 * 60 * 60 * 24)
  );

  return {
    status: daysElapsed > 21 ? 'overdue' : 'running',
    daysElapsed,
    timerStartedAt: application.timerStartedAt,
    timerStoppedAt: null,
    timerDaysElapsed: null,
  };
};

const getStats = async (query = {}) => {
  const now = new Date();
  const firstDayOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

  const User = require('../models/User');
  const Certificate = require('../models/Certificate');

  // Period filter — compute dateFrom based on preset
  let periodFrom = null;
  const period = query.period || 'all';
  if (period === 'today') {
    periodFrom = new Date(now); periodFrom.setHours(0, 0, 0, 0);
  } else if (period === 'yesterday') {
    periodFrom = new Date(now); periodFrom.setDate(periodFrom.getDate() - 1); periodFrom.setHours(0, 0, 0, 0);
  } else if (period === 'this_week') {
    periodFrom = new Date(now); periodFrom.setDate(periodFrom.getDate() - periodFrom.getDay() + 1); periodFrom.setHours(0, 0, 0, 0);
  } else if (period === 'last_week') {
    periodFrom = new Date(now); periodFrom.setDate(periodFrom.getDate() - periodFrom.getDay() - 6); periodFrom.setHours(0, 0, 0, 0);
  } else if (period === 'last_30') {
    periodFrom = new Date(now); periodFrom.setDate(periodFrom.getDate() - 29); periodFrom.setHours(0, 0, 0, 0);
  } else if (period === 'custom' && query.from) {
    periodFrom = new Date(query.from);
  }
  let periodTo = null;
  if (period === 'yesterday') {
    periodTo = new Date(now); periodTo.setHours(0, 0, 0, 0);
  } else if (period === 'last_week') {
    periodTo = new Date(now); periodTo.setDate(periodTo.getDate() - periodTo.getDay() + 1); periodTo.setHours(0, 0, 0, 0);
  } else if (period === 'custom' && query.to) {
    periodTo = new Date(query.to); periodTo.setDate(periodTo.getDate() + 1);
  }

  // Explicit date range (from the uniform DateFilterBar) takes priority over presets.
  if (query.dateFrom) {
    const d = new Date(query.dateFrom);
    if (!isNaN(d.getTime())) { d.setHours(0, 0, 0, 0); periodFrom = d; }
  }
  if (query.dateTo) {
    const d = new Date(query.dateTo);
    if (!isNaN(d.getTime())) { d.setHours(0, 0, 0, 0); d.setDate(d.getDate() + 1); periodTo = d; }
  }

  // Build match filter for period-scoped queries. Test applications AND archived
  // applications are excluded from every dashboard stat built on this match — the
  // dashboard reflects the active pipeline, matching the Students list (which also
  // hides archived). Archived apps have their own page.
  const periodMatch = { isTest: { $ne: true }, status: { $ne: 'Archived' } };
  if (periodFrom) periodMatch.createdAt = { $gte: periodFrom };
  if (periodTo) periodMatch.createdAt = { ...periodMatch.createdAt, $lt: periodTo };

  // 7-day window for daily chart (Mon–Sun current week)
  const sevenDaysAgo = new Date(now);
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 6);
  sevenDaysAgo.setHours(0, 0, 0, 0);

  // 12-month window for trend chart
  const twelveMonthsAgo = new Date(now);
  twelveMonthsAgo.setMonth(twelveMonthsAgo.getMonth() - 11);
  twelveMonthsAgo.setDate(1);
  twelveMonthsAgo.setHours(0, 0, 0, 0);

  const PAID_STATUSES = [
    'StudentIntakeForm', 'UploadDocuments', 'DocumentsUploaded',
    'StudentCompleted', 'SentToRTO', 'WaitingForVerification',
    'ReadyForRTOPayment', 'RTOInvoiceUploaded',
    'CertificateGenerated', 'CertificateIssued',
  ];

  const [
    byStatus, byAgent, totalCount, unassignedCount,
    thisMonthCount, recentActivity, dailyApps,
    agentCount, certificateCount, studentCount,
    topQualifications, byColor, monthlyTrend,
  ] = await Promise.all([
      // Count by status (period-filtered)
      Application.aggregate([
        ...(Object.keys(periodMatch).length ? [{ $match: periodMatch }] : []),
        { $group: { _id: '$status', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
      ]),

      // Count by agent (period-filtered)
      Application.aggregate([
        { $match: { assignedAgentId: { $ne: null }, ...periodMatch } },
        { $group: { _id: '$assignedAgentId', count: { $sum: 1 } } },
        {
          $lookup: {
            from: 'users',
            localField: '_id',
            foreignField: '_id',
            as: 'agent',
          },
        },
        { $unwind: '$agent' },
        {
          $project: {
            _id: 1,
            count: 1,
            agentName: {
              $concat: [
                { $ifNull: ['$agent.firstName', ''] },
                ' ',
                { $ifNull: ['$agent.lastName', ''] },
              ],
            },
            agentEmail: '$agent.email',
          },
        },
        { $sort: { count: -1 } },
      ]),

      Application.countDocuments(periodMatch),
      Application.countDocuments({ assignedAgentId: null, ...periodMatch }),
      Application.countDocuments({ isTest: { $ne: true }, status: { $ne: 'Archived' }, createdAt: { $gte: firstDayOfMonth } }),

      // Recent activity
      Application.find({ isTest: { $ne: true } })
        .sort({ updatedAt: -1 })
        .limit(5)
        .select('applicationId status updatedAt studentId assignedAgentId')
        .populate('studentId', 'firstName lastName email')
        .populate('assignedAgentId', 'firstName lastName')
        .lean(),

      // Daily application counts (last 14 days) — paid vs pending per day
      Application.aggregate([
        { $match: { isTest: { $ne: true }, status: { $ne: 'Archived' }, createdAt: { $gte: sevenDaysAgo } } },
        {
          $group: {
            _id: {
              date: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
              isPaid: { $cond: [{ $in: ['$status', PAID_STATUSES] }, true, false] },
            },
            count: { $sum: 1 },
          },
        },
        { $sort: { '_id.date': 1 } },
      ]),

      User.countDocuments({ isSalesAgent: true, status: 'active' }),
      Certificate.countDocuments(periodMatch),

      // Unique student count (period-scoped)
      Application.distinct('studentId', periodMatch).then((ids) => ids.length),

      // Top qualifications (top 8, period-scoped)
      Application.aggregate([
        ...(Object.keys(periodMatch).length ? [{ $match: periodMatch }] : []),
        { $group: { _id: '$qualificationId', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 8 },
        {
          $lookup: {
            from: 'qualifications',
            localField: '_id',
            foreignField: '_id',
            as: 'qualification',
          },
        },
        { $unwind: { path: '$qualification', preserveNullAndEmptyArrays: true } },
        {
          $project: {
            _id: 1,
            count: 1,
            name: { $ifNull: ['$qualification.name', 'Unknown'] },
            code: { $ifNull: ['$qualification.code', ''] },
          },
        },
      ]),

      // Lead status color distribution (period-scoped)
      Application.aggregate([
        ...(Object.keys(periodMatch).length ? [{ $match: periodMatch }] : []),
        { $group: { _id: { $ifNull: ['$color', ''] }, count: { $sum: 1 } } },
        { $sort: { count: -1 } },
      ]),

      // Monthly application trend (last 12 months) — count + revenue
      Application.aggregate([
        { $match: { isTest: { $ne: true }, status: { $ne: 'Archived' }, createdAt: { $gte: twelveMonthsAgo } } },
        {
          $group: {
            _id: {
              year: { $year: '$createdAt' },
              month: { $month: '$createdAt' },
            },
            count: { $sum: 1 },
          },
        },
        { $sort: { '_id.year': 1, '_id.month': 1 } },
      ]),
    ]);

  // Build byStatus map
  const byStatusMap = {};
  byStatus.forEach((s) => { byStatusMap[s._id] = s.count; });

  // Build daily data — fill all 14 days, include day-of-week label
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const dailyData = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(sevenDaysAgo);
    d.setDate(d.getDate() + i);
    const dateStr = d.toISOString().split('T')[0];
    const dayPaid = dailyApps.find((r) => r._id.date === dateStr && r._id.isPaid) || { count: 0 };
    const dayPending = dailyApps.find((r) => r._id.date === dateStr && !r._id.isPaid) || { count: 0 };
    dailyData.push({
      date: dateStr,
      day: DAYS[d.getDay()],
      dayDate: `${d.getDate()} ${d.toLocaleString('en-AU', { month: 'short' })}`,
      paid: dayPaid.count,
      pending: dayPending.count,
    });
  }

  // Build monthly trend data — fill all 12 months
  const Payment = require('../models/Payment');
  const monthlyRevenue = await Payment.aggregate([
    { $match: { isTest: { $ne: true }, isArchived: { $ne: true }, status: 'completed', createdAt: { $gte: twelveMonthsAgo } } },
    {
      $group: {
        _id: { year: { $year: '$createdAt' }, month: { $month: '$createdAt' } },
        revenue: { $sum: '$amount' },
      },
    },
  ]);
  const revenueMap = {};
  monthlyRevenue.forEach((r) => {
    revenueMap[`${r._id.year}-${r._id.month}`] = r.revenue;
  });

  const trendData = [];
  for (let i = 0; i < 12; i++) {
    const d = new Date(twelveMonthsAgo);
    d.setMonth(d.getMonth() + i);
    const y = d.getFullYear();
    const m = d.getMonth() + 1;
    const mt = monthlyTrend.find((t) => t._id.year === y && t._id.month === m);
    trendData.push({
      year: y,
      month: m,
      label: d.toLocaleString('en-AU', { month: 'short' }),
      applications: mt ? mt.count : 0,
      revenue: revenueMap[`${y}-${m}`] || 0,
    });
  }

  return {
    total: totalCount,
    unassigned: unassignedCount,
    thisMonth: thisMonthCount,
    studentCount,
    byStatus: byStatus.map((s) => ({ status: s._id, count: s.count })),
    byStatusMap,
    byAgent: byAgent.map((a) => ({
      agentId: a._id,
      agentName: a.agentName.trim(),
      agentEmail: a.agentEmail,
      count: a.count,
    })),
    recentActivity,
    dailyData,
    trendData,
    topQualifications: topQualifications.map((q) => ({
      name: q.name,
      code: q.code,
      count: q.count,
    })),
    colorDistribution: byColor.map((c) => ({ color: c._id || '', count: c.count })),
    agentCount,
    certificateCount,
  };
};

const exportCsv = async (filters) => {
  const query = {};

  if (filters.status) {
    query.status = filters.status;
  }
  if (filters.agentId) {
    query.assignedAgentId = filters.agentId;
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

  const applications = await Application.find(query)
    .populate('studentId', 'firstName lastName email')
    .populate('qualificationId', 'name code')
    .populate('industryId', 'name')
    .populate('assignedAgentId', 'firstName lastName')
    .populate('paymentIds')
    .lean();

  return applications.map((app) => {
    const student = app.studentId || {};
    const qualification = app.qualificationId || {};
    const industry = app.industryId || {};
    const agent = app.assignedAgentId || {};

    // Derive payment summary from populated paymentIds
    const payments = app.paymentIds || [];
    const totalPaid = payments
      .filter((p) => p && p.status === 'completed')
      .reduce((sum, p) => sum + (p.amount || 0), 0);

    const totalDiscount = (app.discounts || [])
      .reduce((sum, d) => sum + (d.amount || 0), 0);

    const hasCompleted = payments.some((p) => p && p.status === 'completed');

    return {
      applicationId: app.applicationId,
      studentName: `${student.firstName || ''} ${student.lastName || ''}`.trim(),
      studentEmail: student.email || '',
      qualification: qualification.name || '',
      industry: industry.name || '',
      status: app.status,
      assignedAgent: `${agent.firstName || ''} ${agent.lastName || ''}`.trim(),
      createdAt: app.createdAt,
      price: totalPaid,
      discount: totalDiscount,
      paymentStatus: hasCompleted ? 'paid' : 'unpaid',
    };
  });
};

/* ═══════════════════════════════════════════════════════
   STUDENT DETAIL — OPTIMIZED SINGLE-APP LOAD
   ═══════════════════════════════════════════════════════ */

// Build a { status → Date } map for the Timeline tab. Aggregates dates from
// the application's own milestone fields plus related documents (payments,
// uploaded documents, intake form, certificate), then overlays statusHistory
// as the authoritative source of exact transition times when it exists. The
// derived dates are what let legacy applications (created before statusHistory
// tracking) still show meaningful stage dates.
const buildStageDates = (app, payments = [], documents = []) => {
  const dates = {};
  const set = (key, val) => { if (val && !dates[key]) dates[key] = val; };

  // Student phase
  set('New', app.createdAt);

  // Payment — earliest completed payment (fallback: earliest payment of any status)
  const completed = payments.filter((p) => p.status === 'completed');
  const pool = completed.length ? completed : payments;
  if (pool.length) {
    const earliest = pool.reduce((a, b) =>
      new Date(a.completedAt || a.createdAt) <= new Date(b.completedAt || b.createdAt) ? a : b);
    set('WaitingForPayment', earliest.completedAt || earliest.createdAt);
  }

  // Intake form — submitted (fallback: created)
  const intake = app.intakeFormId && typeof app.intakeFormId === 'object' ? app.intakeFormId : null;
  set('StudentIntakeForm', intake?.submittedAt || intake?.createdAt);

  // Documents — first upload marks "Upload Docs", last upload approximates "Docs Uploaded"
  if (documents.length) {
    const times = documents.map((d) => new Date(d.createdAt).getTime()).filter((t) => !Number.isNaN(t));
    if (times.length) {
      set('UploadDocuments', new Date(Math.min(...times)));
      set('DocumentsUploaded', new Date(Math.max(...times)));
    }
  }

  set('StudentCompleted', app.studentCompletionDate);

  // RTO phase
  set('SentToRTO', app.sentToRTOPortalAt || app.sentToRTOEmailAt);
  set('RTOInvoiceUploaded', app.timerStoppedAt); // timer stops when the RTO invoice is uploaded

  // Completion phase — from the linked certificate
  const cert = app.certificateId && typeof app.certificateId === 'object' ? app.certificateId : null;
  set('CertificateGenerated', cert?.createdAt);
  set('CertificateIssued', cert?.issuedAt || cert?.updatedAt);

  // statusHistory wins: exact transition times (first occurrence of each status)
  const historyDates = {};
  (app.statusHistory || []).forEach((h) => {
    if (h?.status && h?.changedAt && !historyDates[h.status]) historyDates[h.status] = h.changedAt;
  });

  return { ...dates, ...historyDates };
};

const getStudentDetail = async (studentId, applicationId) => {
  // 1. Full details for the selected application
  const selectedApp = await Application.findOne({
    _id: applicationId,
    studentId,
  })
    .populate('studentId industryId qualificationId assignedAgentId assignedRTOId paymentPlanId certificateId intakeFormId screeningFormId')
    .lean();

  if (!selectedApp) throw new AppError('Application not found', 404);

  // 2. Payments, documents for this application only
  const [payments, documents] = await Promise.all([
    Payment.find({ applicationId }).sort('-createdAt').lean(),
    Document.find({ applicationId }).sort('-createdAt').lean(),
  ]);

  // Derive per-stage dates for the Timeline tab (aggregated across related docs)
  selectedApp.stageDates = buildStageDates(selectedApp, payments, documents);

  // 3. Lightweight snapshots of sibling applications
  const siblings = await Application.find({
    studentId,
    _id: { $ne: applicationId },
  })
    .select('applicationId status qualificationId industryId createdAt')
    .populate('qualificationId', 'name code')
    .populate('industryId', 'name')
    .sort('-createdAt')
    .lean();

  return {
    application: selectedApp,
    payments,
    documents,
    siblings,
  };
};

/* ═══════════════════════════════════════════════════════
   FOLLOW-UP CALLS
   ═══════════════════════════════════════════════════════ */

const addFollowUp = async (applicationId, { scheduledFor, notes, loggedBy }) => {
  const application = await Application.findById(applicationId);
  if (!application) throw new AppError('Application not found', 404);

  application.followUpCalls.push({ scheduledFor, notes, loggedBy });
  await application.save();

  // Sync to connected calendars (non-blocking)
  if (loggedBy) {
    try {
      const { syncFollowUp } = require('./calendarService');
      const studentName = await Application.findById(applicationId)
        .populate('studentId', 'firstName lastName')
        .lean()
        .then((a) => {
          const s = a?.studentId;
          return s ? `${s.firstName || ''} ${s.lastName || ''}`.trim() : '';
        });

      await syncFollowUp(loggedBy, {
        title: `Follow-up: ${studentName || application.applicationId}`,
        description: notes || '',
        scheduledFor,
      });
    } catch (err) {
      // Calendar sync is non-fatal
      console.error('[FollowUp] Calendar sync failed:', err.message);
    }
  }

  // Send follow-up scheduled email to student (non-blocking)
  try {
    const User = require('../models/User');
    const student = await User.findById(application.studentId).select('firstName email').lean();
    if (student?.email) {
      appEmails.sendFollowUpScheduledEmail(student, application, scheduledFor, notes)
        .catch((e) => console.error('[FollowUp] Follow-up email error:', e.message));
    }
  } catch (e) {
    console.error('[FollowUp] Failed to send follow-up scheduled email:', e.message);
  }

  return refreshApplication(application._id);
};

const completeFollowUp = async (applicationId, followUpId, { outcome, notes }) => {
  const application = await Application.findById(applicationId);
  if (!application) throw new AppError('Application not found', 404);

  const followUp = application.followUpCalls.id(followUpId);
  if (!followUp) throw new AppError('Follow-up not found', 404);

  followUp.completedAt = new Date();
  if (outcome) followUp.outcome = outcome;
  if (notes) followUp.notes = notes;
  await application.save();
  return refreshApplication(application._id);
};

const deleteFollowUp = async (applicationId, followUpId) => {
  const application = await Application.findById(applicationId);
  if (!application) throw new AppError('Application not found', 404);

  const followUp = application.followUpCalls.id(followUpId);
  if (!followUp) throw new AppError('Follow-up not found', 404);

  followUp.deleteOne();
  await application.save();
  return refreshApplication(application._id);
};

module.exports = {
  applications: {
    ...applicationCrud,
    // Override list to support state filter via ScreeningForm lookup
    async list(query = {}) {
      if (query.state) {
        const stateVal = query.state;
        delete query.state;
        // Find screening forms for the given state
        const screeningForms = await ScreeningForm.find({ state: stateVal }).select('applicationId').lean();
        const appIds = screeningForms.map((sf) => sf.applicationId);
        query._id = { $in: appIds };
      }
      return applicationCrud.list(query);
    },
  },
  intakeForms: intakeFormCrud,
  screeningForms: screeningFormCrud,
  documents: documentCrud,
  certificates: certificateCrud,
  createApplication,
  assignAgent,
  assignRTO,
  setTestFlag,
  updateSource,
  updateLeadStatus,
  sendToRTOPortal,
  sendRTOSubmission,
  updateStatus,
  restoreFromArchive,
  createIntakeForm,
  createScreeningForm,
  uploadDocument,
  issueCertificate,
  addNote,
  searchNotes,
  editNote,
  deleteNote,
  addDiscount,
  removeDiscount,
  reviewDocument,
  getTimerStatus,
  getStats,
  exportCsv,
  tryAutoStartTimer,
  logRTOActivity,
  notifySoftCopy,
  dispatchHardCopy,
  markCertificateDelivered,
  createAdditionalDocRequest,
  submitAdditionalDocs,
  reviewAdditionalDocs,
  createRTOSubmission,
  addFollowUp,
  completeFollowUp,
  deleteFollowUp,
  getStudentDetail,
};
