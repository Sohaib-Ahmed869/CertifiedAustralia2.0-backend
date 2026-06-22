const crypto = require('crypto');
const AppError = require('../utils/AppError');
const buildCrud = require('./commonCrud');
const Application = require('../models/Application');
const IntakeForm = require('../models/IntakeForm');
const ScreeningForm = require('../models/ScreeningForm');
const Document = require('../models/Document');
const Certificate = require('../models/Certificate');
const Payment = require('../models/Payment');

/**
 * Auto-start the 21-day KPI timer when all 3 student obligations are met:
 *   1. Payment received (at least one completed payment)
 *   2. Intake form submitted
 *   3. At least one document uploaded
 *
 * Skips if the timer has already been started.
 */
const tryAutoStartTimer = async (applicationId) => {
  const app = await Application.findById(applicationId);
  if (!app) return;

  // Already started — don't restart
  if (app.studentCompletionDate) return;

  // Check condition 1: has completed payment
  const hasPaid = app.paymentIds && app.paymentIds.length > 0
    ? await Payment.exists({
        _id: { $in: app.paymentIds },
        status: 'completed',
        type: { $in: ['upfront', 'plan', 'manualMarkPaid'] },
      })
    : false;
  if (!hasPaid) return;

  // Check condition 2: intake form submitted
  if (!app.intakeFormId) return;

  // Check condition 3: at least one document uploaded
  if (!app.documentIds || app.documentIds.length === 0) return;

  // All 3 conditions met — mark student as completed and start 21-day timer
  app.status = 'StudentCompleted';
  app.studentCompletionDate = new Date();
  app.rtoCompletionDeadline = new Date(Date.now() + 21 * 24 * 60 * 60 * 1000);
  await app.save();
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
  const application = await Application.create({
    ...data,
    applicationId,
    status: data.status || 'New',
  });

  return refreshApplication(application._id);
};

const assignAgent = async (applicationId, assignedAgentId) => {
  const application = await Application.findByIdAndUpdate(
    applicationId,
    { assignedAgentId },
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

  // Notify assigned RTO (non-fatal)
  if (assignedRTOId) {
    try {
      const { createNotification } = require('./notificationService');
      const student = application.studentId;
      const studentName = student ? `${student.firstName || ''} ${student.lastName || ''}`.trim() : 'a student';
      await createNotification({
        userId: assignedRTOId,
        type: 'application_assigned',
        title: 'Application Assigned for Review',
        message: `You've been assigned to review ${application.applicationId} for ${studentName}.`,
        link: `/rto/applications`,
        relatedId: application._id,
      });
    } catch (err) {
      console.error('[AssignRTO] Failed to create notification:', err.message);
    }
  }

  return application;
};

const sendToRTOPortal = async (applicationId, rtoUserId) => {
  const UserModel = require('../models/User');
  const rtoUser = await UserModel.findById(rtoUserId).lean();
  if (!rtoUser) throw new AppError('RTO user not found', 404);

  const application = await Application.findByIdAndUpdate(
    applicationId,
    {
      sentToRTOPortal: true,
      sentToRTOPortalAt: new Date(),
      portalRtoEmail: rtoUser.email,
      portalRtoName: `${rtoUser.firstName || ''} ${rtoUser.lastName || ''}`.trim(),
      status: 'SentToRTO',
    },
    { new: true, runValidators: true }
  )
    .populate('studentId industryId qualificationId assignedAgentId assignedRTOId paymentPlanId certificateId')
    .lean();

  if (!application) throw new AppError('Application not found', 404);
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

  // TODO: Integrate actual email sending (PDF generation + branded email) when email service is ready
  return application;
};

const updateStatus = async (applicationId, status) => {
  const update = { status };

  // Auto-pause the 21-day timer when RTO invoice is uploaded
  if (status === 'RTOInvoiceUploaded') {
    update.timerPausedAt = new Date();
    update.timerPauseReason = 'RTO invoice uploaded';
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

  // Send email notification (non-fatal)
  try {
    const student = application.studentId;
    if (student?.email) {
      const { sendTemplatedEmail } = require('./emailService');
      const trackingHtml = data.trackingNumber
        ? `<div style="background-color:#ecfdf5;border:1px solid #a7f3d0;border-radius:8px;padding:16px;margin:16px 0;">
            <p style="margin:0 0 4px;font-weight:600;color:#065f46;">Certificate Tracking</p>
            ${data.trackingNumber ? `<p style="margin:0;color:#047857;">Tracking ID: <strong>${data.trackingNumber}</strong></p>` : ''}
            ${data.trackingLink ? `<p style="margin:4px 0 0;"><a href="${data.trackingLink}" style="color:#059669;text-decoration:underline;">Track your certificate &rarr;</a></p>` : ''}
          </div>`
        : '';

      await sendTemplatedEmail({
        to: student.email,
        subject: 'Your Certificate is Ready — Certified Australia',
        preheader: 'Congratulations! Your certificate has been issued.',
        templateContent: `
          <h2 style="margin:0 0 8px;">Congratulations! 🎉</h2>
          <p>Hi ${student.firstName || 'there'},</p>
          <p>Great news — your certificate has been issued and is ready for you! You can view and download it from your student portal.</p>
          ${trackingHtml}
          <p>If you have any questions, please don't hesitate to contact us.</p>
        `,
        ctaText: 'View Your Certificate',
        ctaUrl: `${process.env.APP_BASE_URL || 'http://localhost:5173'}/student/certificates`,
      });
    }
  } catch (err) {
    console.error('[CertificateService] Failed to send certificate email:', err.message);
  }

  // Create in-portal notification (non-fatal)
  try {
    const { createNotification } = require('./notificationService');
    const studentId = application.studentId._id || application.studentId;
    await createNotification({
      userId: studentId,
      type: 'certificate_issued',
      title: 'Certificate Issued',
      message: data.trackingNumber
        ? `Your certificate is ready! Tracking ID: ${data.trackingNumber}`
        : 'Your certificate has been issued and is ready for download.',
      link: '/student/certificates',
      relatedId: application._id,
    });
  } catch (err) {
    console.error('[CertificateService] Failed to create notification:', err.message);
  }

  return certificateCrud.getById(certificate._id);
};

const addNote = async (applicationId, note) => {
  const application = await Application.findById(applicationId);

  if (!application) {
    throw new AppError('Application not found', 404);
  }

  application.notes.push({
    content: note.content,
    addedBy: note.addedBy,
    visibility: note.visibility,
    addedAt: note.addedAt || new Date(),
  });

  await application.save();
  return refreshApplication(application._id);
};

const addDiscount = async (applicationId, { amount, note, createdBy }) => {
  const application = await Application.findById(applicationId);
  if (!application) throw new AppError('Application not found', 404);
  if (!amount || amount <= 0) throw new AppError('Discount amount must be greater than 0', 400);

  application.discounts.push({
    amount,
    note: note || '',
    createdBy,
    createdAt: new Date(),
  });

  await application.save();
  return refreshApplication(application._id);
};

const removeDiscount = async (applicationId, discountId) => {
  const application = await Application.findById(applicationId);
  if (!application) throw new AppError('Application not found', 404);

  const discount = application.discounts.id(discountId);
  if (!discount) throw new AppError('Discount not found', 404);

  discount.deleteOne();
  await application.save();
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
  const application = await Application.findById(applicationId);
  if (!application) throw new AppError('Application not found', 404);

  const request = application.additionalDocRequests.id(requestId);
  if (!request) throw new AppError('Request not found', 404);
  if (request.status !== 'open') throw new AppError('Request is not open for submission', 400);

  request.status = 'submitted';
  request.submittedAt = new Date();
  await application.save();
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
  return refreshApplication(application._id);
};

// ── RTO Submission Versioning (CA-08 duplicate prevention) ──

const createRTOSubmission = async (applicationId, { sentBy, documentsIncluded, emailSent }) => {
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
};

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

const updateTimer = async (applicationId, timerData) => {
  const application = await Application.findById(applicationId);
  if (!application) throw new AppError('Application not found', 404);

  if (timerData.action === 'pause') {
    application.timerPausedAt = new Date();
    application.timerPauseReason = timerData.reason || '';
  } else if (timerData.action === 'resume') {
    // Calculate paused duration and extend deadline
    if (application.timerPausedAt && application.rtoCompletionDeadline) {
      const pausedMs = Date.now() - application.timerPausedAt.getTime();
      application.rtoCompletionDeadline = new Date(
        application.rtoCompletionDeadline.getTime() + pausedMs
      );
    }
    application.timerPausedAt = undefined;
    application.timerPauseReason = undefined;
  } else if (timerData.action === 'start') {
    application.studentCompletionDate = new Date();
    application.rtoCompletionDeadline = new Date(
      Date.now() + 21 * 24 * 60 * 60 * 1000
    );
  }

  await application.save();
  return refreshApplication(application._id);
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

  // Build match filter for period-scoped queries
  const periodMatch = {};
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
      Application.countDocuments({ createdAt: { $gte: firstDayOfMonth } }),

      // Recent activity
      Application.find()
        .sort({ updatedAt: -1 })
        .limit(5)
        .select('applicationId status updatedAt studentId assignedAgentId')
        .populate('studentId', 'firstName lastName email')
        .populate('assignedAgentId', 'firstName lastName')
        .lean(),

      // Daily application counts (last 14 days) — paid vs pending per day
      Application.aggregate([
        { $match: { createdAt: { $gte: sevenDaysAgo } } },
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

      User.countDocuments({ role: 'Agent', status: 'active' }),
      Certificate.countDocuments(),

      // Unique student count
      Application.distinct('studentId').then((ids) => ids.length),

      // Top qualifications (top 8)
      Application.aggregate([
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

      // Lead status color distribution
      Application.aggregate([
        { $group: { _id: { $ifNull: ['$color', ''] }, count: { $sum: 1 } } },
        { $sort: { count: -1 } },
      ]),

      // Monthly application trend (last 12 months) — count + revenue
      Application.aggregate([
        { $match: { createdAt: { $gte: twelveMonthsAgo } } },
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
    { $match: { status: 'completed', createdAt: { $gte: twelveMonthsAgo } } },
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
  sendToRTOPortal,
  sendRTOSubmission,
  updateStatus,
  createIntakeForm,
  createScreeningForm,
  uploadDocument,
  issueCertificate,
  addNote,
  addDiscount,
  removeDiscount,
  reviewDocument,
  updateTimer,
  getStats,
  exportCsv,
  tryAutoStartTimer,
  createAdditionalDocRequest,
  submitAdditionalDocs,
  reviewAdditionalDocs,
  createRTOSubmission,
};
