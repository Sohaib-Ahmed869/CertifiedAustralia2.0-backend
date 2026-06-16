const crypto = require('crypto');
const AppError = require('../utils/AppError');
const buildCrud = require('./commonCrud');
const Application = require('../models/Application');
const IntakeForm = require('../models/IntakeForm');
const ScreeningForm = require('../models/ScreeningForm');
const Document = require('../models/Document');
const Certificate = require('../models/Certificate');

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
    status: data.status || 'LeadCaptured',
  });

  return refreshApplication(application._id);
};

const assignAgent = async (applicationId, assignedAgentId) => {
  const application = await Application.findByIdAndUpdate(
    applicationId,
    { assignedAgentId, status: 'AgentAssigned' },
    { new: true, runValidators: true }
  )
    .populate('studentId industryId qualificationId assignedAgentId assignedRTOId paymentPlanId certificateId')
    .lean();

  if (!application) {
    throw new AppError('Application not found', 404);
  }

  return application;
};

const assignRTO = async (applicationId, assignedRTOId) => {
  const application = await Application.findByIdAndUpdate(
    applicationId,
    { assignedRTOId, status: 'SentToRTO' },
    { new: true, runValidators: true }
  )
    .populate('studentId industryId qualificationId assignedAgentId assignedRTOId paymentPlanId certificateId')
    .lean();

  if (!application) {
    throw new AppError('Application not found', 404);
  }

  return application;
};

const updateStatus = async (applicationId, status) => {
  const application = await Application.findByIdAndUpdate(
    applicationId,
    { status },
    { new: true, runValidators: true }
  )
    .populate('studentId industryId qualificationId assignedAgentId assignedRTOId paymentPlanId certificateId')
    .lean();

  if (!application) {
    throw new AppError('Application not found', 404);
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
    application.status = 'IntakeComplete';
  }
  await application.save();

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

  return documentCrud.getById(document._id);
};

const issueCertificate = async (applicationId, data) => {
  const application = await Application.findById(applicationId);

  if (!application) {
    throw new AppError('Application not found', 404);
  }

  const certificate = await Certificate.create({
    ...data,
    applicationId,
    studentId: application.studentId,
  });

  application.certificateId = certificate._id;
  application.status = 'CertificateIssued';
  await application.save();

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
    'Paid', 'OnPlan', 'IntakeComplete', 'DocumentsSubmitted',
    'UnderAdminReview', 'ResubmissionRequested', 'Resubmitted',
    'SentToRTO', 'UnderRTOReview', 'FeedbackRelayed',
    'AwaitingRTOCompletion', 'RTOCompleted', 'RTOPaid',
    'CertificateIssued', 'InDelivery', 'Delivered',
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

    const totalDiscount = payments
      .filter((p) => p && p.type === 'discount')
      .reduce((sum, p) => sum + (p.amount || 0), 0);

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
  applications: applicationCrud,
  intakeForms: intakeFormCrud,
  screeningForms: screeningFormCrud,
  documents: documentCrud,
  certificates: certificateCrud,
  createApplication,
  assignAgent,
  assignRTO,
  updateStatus,
  createIntakeForm,
  createScreeningForm,
  uploadDocument,
  issueCertificate,
  addNote,
  reviewDocument,
  updateTimer,
  getStats,
  exportCsv,
};
