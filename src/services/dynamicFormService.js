const DynamicForm = require('../models/DynamicForm');
const FormSubmission = require('../models/FormSubmission');
const buildCrud = require('./commonCrud');
const AppError = require('../utils/AppError');
const { sendTemplatedEmail } = require('./emailService');
const { notify } = require('./notificationService');
const appEmails = require('./applicationEmailService');

const forms = buildCrud(DynamicForm, {
  populate: [
    { path: 'qualificationIds', select: 'name' },
    { path: 'industryIds', select: 'name' },
    { path: 'createdBy', select: 'firstName lastName email' },
  ],
});

const submissions = buildCrud(FormSubmission, {
  populate: [
    { path: 'formId', select: 'name description fields version' },
    { path: 'applicationId', select: 'applicationId status' },
    { path: 'submittedBy', select: 'firstName lastName email' },
    { path: 'reviewedBy', select: 'firstName lastName email' },
  ],
});

/**
 * Duplicate a form — creates a copy with incremented version and draft status.
 */
const duplicateForm = async (id) => {
  const original = await DynamicForm.findById(id);
  if (!original) throw new AppError('Form not found', 404);

  const copy = original.toObject();
  delete copy._id;
  delete copy.createdAt;
  delete copy.updatedAt;
  copy.name = `${copy.name} (Copy)`;
  copy.status = 'draft';
  copy.version = (copy.version || 1) + 1;

  const created = await DynamicForm.create(copy);
  return created.toObject();
};

/**
 * Assign a form to one or more qualifications.
 */
const assignToQualifications = async (id, qualificationIds) => {
  const form = await DynamicForm.findByIdAndUpdate(
    id,
    { $addToSet: { qualificationIds: { $each: qualificationIds } } },
    { new: true, runValidators: true }
  ).populate('qualificationIds', 'name');

  if (!form) throw new AppError('Form not found', 404);
  return form.toObject();
};

/**
 * Detach a form from a qualification.
 */
const detachFromQualification = async (id, qualificationId) => {
  const form = await DynamicForm.findByIdAndUpdate(
    id,
    { $pull: { qualificationIds: qualificationId } },
    { new: true, runValidators: true }
  ).populate('qualificationIds', 'name');

  if (!form) throw new AppError('Form not found', 404);
  return form.toObject();
};

/**
 * List forms assigned to a specific qualification.
 */
const listByQualification = async (qualificationId) => {
  const items = await DynamicForm.find({
    qualificationIds: qualificationId,
    status: 'active',
  })
    .sort('displayOrder')
    .populate('qualificationIds', 'name')
    .lean();

  return { items };
};

/**
 * List submissions for a specific application.
 */
const listSubmissionsByApplication = async (applicationId) => {
  const items = await FormSubmission.find({ applicationId })
    .sort('-createdAt')
    .populate('formId', 'name description fields version')
    .populate('submittedBy', 'firstName lastName email')
    .populate('reviewedBy', 'firstName lastName email')
    .lean();

  return { items };
};

/**
 * Review a submission (approve/reject).
 */
const reviewSubmission = async (id, reviewData) => {
  const submission = await FormSubmission.findByIdAndUpdate(
    id,
    {
      status: reviewData.status,
      reviewedBy: reviewData.reviewedBy,
      reviewedAt: new Date(),
      reviewNotes: reviewData.reviewNotes || '',
    },
    { new: true, runValidators: true }
  )
    .populate('formId', 'name description fields version')
    .populate('submittedBy', 'firstName lastName email')
    .populate('reviewedBy', 'firstName lastName email');

  if (!submission) throw new AppError('Submission not found', 404);

  // Send email notification to student
  const student = submission.submittedBy;
  const formName = submission.formId?.name || 'Assessment Form';
  if (student?.email) {
    const isApproved = reviewData.status === 'approved';
    const statusLabel = isApproved ? 'Approved' : 'Rejected';
    const content = `
      <p>Hi ${student.firstName || 'Student'},</p>
      <p>Your submission for <strong>${formName}</strong> has been <strong>${statusLabel.toLowerCase()}</strong>.</p>
      ${reviewData.reviewNotes ? `<div style="background:${isApproved ? '#f0faf4' : '#fef2f2'};border-left:4px solid ${isApproved ? '#0a9d42' : '#ef4444'};border-radius:8px;padding:14px 18px;margin:16px 0;"><p style="margin:0;font-size:14px;color:#333;"><strong>Review notes:</strong> ${reviewData.reviewNotes}</p></div>` : ''}
      ${!isApproved ? '<p>Please review the feedback and resubmit your form.</p>' : '<p>No further action is required for this form.</p>'}
      <p>Warm regards,<br/><strong>Certified Australia Team</strong></p>
    `;
    sendTemplatedEmail({
      to: student.email,
      subject: `Form ${statusLabel}: ${formName}`,
      templateContent: content,
      ctaText: isApproved ? undefined : 'Resubmit Form',
      ctaUrl: isApproved ? undefined : `${process.env.APP_BASE_URL || 'http://localhost:5173'}/student`,
      preheader: `Your form "${formName}" has been ${statusLabel.toLowerCase()}`,
    }).catch(() => {}); // non-blocking
  }

  // In-portal notification
  if (submission.submittedBy?._id) {
    notify(submission.submittedBy._id, {
      type: 'form_review',
      title: `Form ${reviewData.status === 'approved' ? 'Approved' : 'Rejected'}: ${formName}`,
      message: reviewData.reviewNotes || `Your form "${formName}" has been ${reviewData.status}.`,
      link: '/student',
    }).catch(() => {});
  }

  return submission.toObject();
};

/**
 * Get or create a draft submission for a specific application + form.
 */
const getDraft = async (applicationId, formId) => {
  const draft = await FormSubmission.findOne({ applicationId, formId, status: 'draft' })
    .populate('formId', 'name description fields version')
    .lean();
  return draft;
};

/**
 * Save/upsert a draft — creates if not exists, updates if exists.
 */
const saveDraft = async (applicationId, formId, submittedBy, data) => {
  const existing = await FormSubmission.findOne({ applicationId, formId, status: 'draft' });
  if (existing) {
    existing.data = data;
    existing.updatedAt = new Date();
    await existing.save();
    return existing.toObject();
  }
  const created = await FormSubmission.create({
    applicationId,
    formId,
    submittedBy,
    data,
    status: 'draft',
  });
  return created.toObject();
};

/**
 * Delete a draft submission.
 */
const deleteDraft = async (applicationId, formId) => {
  const result = await FormSubmission.findOneAndDelete({ applicationId, formId, status: 'draft' });
  if (!result) throw new AppError('Draft not found', 404);
  return result.toObject();
};

/* ═══════════════════════════════════════════════════════
   THIRD-PARTY FORM ACCESS
   ═══════════════════════════════════════════════════════ */

const crypto = require('crypto');
const ThirdPartyFormAccess = require('../models/ThirdPartyFormAccess');
const Application = require('../models/Application');

/**
 * Set up third-party form access — creates tokens, sends invitation emails.
 */
const setupThirdPartyAccess = async ({ applicationId, formId, recipients, createdBy }) => {
  const app = await Application.findById(applicationId)
    .populate('studentId', 'firstName lastName')
    .lean();
  if (!app) throw new AppError('Application not found', 404);

  const form = await DynamicForm.findById(formId).lean();
  if (!form) throw new AppError('Form not found', 404);

  const studentName = app.studentId
    ? `${app.studentId.firstName || ''} ${app.studentId.lastName || ''}`.trim()
    : 'Student';

  const results = [];
  const baseUrl = process.env.APP_BASE_URL || 'http://localhost:5173';

  for (const r of recipients) {
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000); // 30 days

    const access = await ThirdPartyFormAccess.create({
      applicationId,
      formId,
      token,
      recipientName: r.name,
      recipientEmail: r.email,
      recipientCompany: r.company || '',
      recipientRole: r.role || 'referee',
      expiresAt,
      createdBy,
    });

    // Send invitation email
    const formLink = `${baseUrl}/third-party-form/${token}`;
    sendTemplatedEmail({
      to: r.email,
      subject: `Reference Form Request — ${studentName}`,
      templateContent: `
        <p>Hi ${r.name},</p>
        <p>You have been asked to complete a reference form for <strong>${studentName}</strong> as part of their RPL assessment for <strong>${form.name}</strong>.</p>
        <p>Please click the button below to access and complete the form. This link will expire in 30 days.</p>
        <p style="margin-top:24px;">Thank you for your time,<br/><strong>Certified Australia Team</strong></p>
      `,
      ctaText: 'Complete Reference Form',
      ctaUrl: formLink,
      preheader: `Reference form request from ${studentName}`,
    }).catch(() => {});

    results.push(access.toObject());
  }

  return results;
};

/**
 * Validate a third-party token — returns form + student info if valid.
 */
const validateThirdPartyToken = async (token) => {
  const access = await ThirdPartyFormAccess.findOne({ token })
    .populate({
      path: 'applicationId',
      select: 'applicationId studentId',
      populate: { path: 'studentId', select: 'firstName lastName' },
    })
    .populate('formId')
    .lean();

  if (!access) throw new AppError('Invalid or expired link', 404);
  if (access.status === 'completed') throw new AppError('This form has already been submitted', 400);
  if (access.status === 'cancelled') throw new AppError('This invitation has been cancelled', 400);
  if (new Date() > new Date(access.expiresAt)) {
    await ThirdPartyFormAccess.updateOne({ _id: access._id }, { status: 'expired' });
    throw new AppError('This link has expired', 400);
  }

  return access;
};

/**
 * Submit a third-party form.
 */
const submitThirdPartyForm = async (token, data) => {
  const access = await validateThirdPartyToken(token);

  // Create submission
  const submission = await FormSubmission.create({
    formId: access.formId._id,
    applicationId: access.applicationId._id,
    submittedBy: access.applicationId.studentId?._id, // link to student
    data,
    status: 'submitted',
  });

  // Mark access as completed
  await ThirdPartyFormAccess.updateOne(
    { _id: access._id },
    { status: 'completed', completedAt: new Date(), submissionId: submission._id }
  );

  // Send confirmation emails (non-blocking)
  try {
    const studentObj = access.applicationId.studentId;
    const studentName = studentObj
      ? `${studentObj.firstName || ''} ${studentObj.lastName || ''}`.trim()
      : 'Student';
    const applicationId = access.applicationId.applicationId || String(access.applicationId._id);
    const formName = access.formId?.name || 'Reference Form';
    const submitterName = access.recipientName || access.recipientEmail || 'Third Party';

    // Confirm to the third-party submitter
    if (access.recipientEmail) {
      appEmails.sendThirdPartySubmissionConfirmEmail(
        access.recipientEmail,
        submitterName,
        studentName,
        formName
      ).catch((e) => console.error('[DynamicForms] Third-party confirm email error:', e.message));
    }

    // Notify admin
    appEmails.sendAdminThirdPartyNotification(studentName, applicationId, submitterName, formName)
      .catch((e) => console.error('[DynamicForms] Admin third-party notification error:', e.message));
  } catch (e) {
    console.error('[DynamicForms] Failed to send third-party submission emails:', e.message);
  }

  return submission.toObject();
};

/**
 * List third-party access records for an application.
 */
const listThirdPartyAccess = async (applicationId) => {
  const items = await ThirdPartyFormAccess.find({ applicationId })
    .populate('formId', 'name')
    .populate('createdBy', 'firstName lastName')
    .sort('-createdAt')
    .lean();
  return { items };
};

/* ═══════════════════════════════════════════════════════
   EMAIL TO RTO — PDF + ZIP BUNDLE
   ═══════════════════════════════════════════════════════ */

const PDFDocument = require('pdfkit');
const archiver = require('archiver');
const { PassThrough } = require('stream');
const Document = require('../models/Document');

/**
 * Generate a PDF from a form submission.
 */
const generateSubmissionPDF = (submission) => {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50, size: 'A4' });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const formName = submission.formId?.name || 'Form Submission';
    const submitter = submission.submittedBy;
    const studentName = submitter ? `${submitter.firstName || ''} ${submitter.lastName || ''}`.trim() : 'Student';

    // Header
    doc.fontSize(18).font('Helvetica-Bold').text('Certified Australia', { align: 'center' });
    doc.fontSize(10).font('Helvetica').fillColor('#888').text('RPL Assessment Form Submission', { align: 'center' });
    doc.moveDown(1.5);

    // Form title
    doc.fontSize(14).font('Helvetica-Bold').fillColor('#000').text(formName);
    doc.fontSize(10).font('Helvetica').fillColor('#555');
    doc.text(`Student: ${studentName}`);
    doc.text(`Submitted: ${submission.createdAt ? new Date(submission.createdAt).toLocaleDateString('en-AU') : 'N/A'}`);
    doc.text(`Status: ${submission.status}`);
    doc.moveDown(1);
    doc.moveTo(50, doc.y).lineTo(545, doc.y).stroke('#ddd');
    doc.moveDown(1);

    // Fields
    const fields = submission.formId?.fields || [];
    const data = submission.data instanceof Map ? Object.fromEntries(submission.data) : (submission.data || {});

    fields.forEach((f) => {
      if (f.type === 'heading') {
        doc.moveDown(0.5);
        doc.fontSize(12).font('Helvetica-Bold').fillColor('#0a9d42').text(f.label);
        doc.moveDown(0.3);
        return;
      }
      if (f.type === 'paragraph') {
        doc.fontSize(9).font('Helvetica').fillColor('#888').text(f.label);
        doc.moveDown(0.3);
        return;
      }
      const val = data[f.fieldId];
      const displayVal = val != null && val !== '' ? (Array.isArray(val) ? val.join(', ') : String(val)) : 'Not answered';
      doc.fontSize(9).font('Helvetica-Bold').fillColor('#333').text(f.label);
      doc.fontSize(10).font('Helvetica').fillColor('#000').text(displayVal);
      doc.moveDown(0.5);
    });

    doc.end();
  });
};

/**
 * Bundle all form submissions + documents for an application into a ZIP and email to RTO.
 */
const emailSubmissionsToRTO = async (applicationId, { rtoEmail, rtoName, subject, message }) => {
  const app = await Application.findById(applicationId)
    .populate('studentId', 'firstName lastName email')
    .populate('qualificationId', 'name')
    .lean();
  if (!app) throw new AppError('Application not found', 404);

  const studentName = app.studentId ? `${app.studentId.firstName || ''} ${app.studentId.lastName || ''}`.trim() : 'Student';

  // Get all submitted submissions
  const subs = await FormSubmission.find({ applicationId, status: { $in: ['submitted', 'approved'] } })
    .populate('formId', 'name fields version')
    .populate('submittedBy', 'firstName lastName')
    .lean();

  // Get all documents
  const docs = await Document.find({ applicationId }).lean();

  // Build ZIP
  const archive = archiver('zip', { zlib: { level: 9 } });
  const passThrough = new PassThrough();
  const chunks = [];
  passThrough.on('data', (c) => chunks.push(c));

  const zipReady = new Promise((resolve, reject) => {
    passThrough.on('end', () => resolve(Buffer.concat(chunks)));
    passThrough.on('error', reject);
    archive.on('error', reject);
  });

  archive.pipe(passThrough);

  // Add PDFs for each submission
  for (let i = 0; i < subs.length; i++) {
    const pdfBuffer = await generateSubmissionPDF(subs[i]);
    const name = `${(subs[i].formId?.name || 'form').replace(/[^a-zA-Z0-9]/g, '_')}_v${subs[i].formId?.version || 1}.pdf`;
    archive.append(pdfBuffer, { name: `Forms/${name}` });
  }

  // Add document metadata listing
  if (docs.length > 0) {
    const listing = docs.map((d) => `${d.originalName || d.fileName || 'document'} (${d.category || 'general'})`).join('\n');
    archive.append(listing, { name: 'Documents/document_list.txt' });
  }

  await archive.finalize();
  const zipBuffer = await zipReady;

  // Send email with ZIP attachment
  const qualName = app.qualificationId?.name || '';
  const emailSubject = subject || `RPL Assessment Package — ${studentName} — ${app.applicationId}`;

  const { sendEmail } = require('./emailService');
  const { buildEmailHtml } = require('./emailService');
  const html = buildEmailHtml(`
    <p>Hi ${rtoName || 'RTO Team'},</p>
    <p>${message || `Please find attached the RPL assessment package for <strong>${studentName}</strong> (${app.applicationId}).`}</p>
    <p><strong>Qualification:</strong> ${qualName}</p>
    <p><strong>Forms included:</strong> ${subs.length}</p>
    <p><strong>Documents referenced:</strong> ${docs.length}</p>
    <p>Warm regards,<br/><strong>Certified Australia Team</strong></p>
  `);

  const result = await sendEmail({
    to: rtoEmail,
    subject: emailSubject,
    html,
    attachments: [{
      filename: `${app.applicationId}_${studentName.replace(/\s/g, '_')}_package.zip`,
      content: zipBuffer,
      contentType: 'application/zip',
    }],
  });

  if (!result.success) throw new AppError('Failed to send email', 500);
  return { message: 'Package sent to RTO', formsCount: subs.length, documentsCount: docs.length };
};

module.exports = {
  forms,
  submissions,
  duplicateForm,
  assignToQualifications,
  detachFromQualification,
  listByQualification,
  listSubmissionsByApplication,
  reviewSubmission,
  getDraft,
  saveDraft,
  deleteDraft,
  setupThirdPartyAccess,
  validateThirdPartyToken,
  submitThirdPartyForm,
  listThirdPartyAccess,
  emailSubmissionsToRTO,
};
