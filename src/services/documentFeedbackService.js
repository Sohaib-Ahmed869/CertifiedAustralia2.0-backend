const AppError = require('../utils/AppError');
const DocumentFeedback = require('../models/DocumentFeedback');

/* ── Queries ── */

const listByApplication = async (applicationId, { source, status } = {}) => {
  const filter = { applicationId };
  if (source) filter.source = source;
  if (status) filter.status = status;
  const items = await DocumentFeedback.find(filter).sort('-createdAt').lean();
  return items;
};

const listForRto = async (applicationId) => {
  return DocumentFeedback.find({
    applicationId,
    source: 'rto',
  }).sort('-createdAt').lean();
};

const listForStudent = async (applicationId) => {
  return DocumentFeedback.find({
    applicationId,
    sentToStudent: true,
  }).sort('-createdAt').lean();
};

const getById = async (id) => {
  const item = await DocumentFeedback.findById(id);
  if (!item) throw new AppError('Feedback not found', 404);
  return item;
};

/* ── Create ── */

const createRtoFeedback = async (applicationId, data) => {
  const feedback = await DocumentFeedback.create({
    applicationId,
    documentField: data.documentField,
    documentLabel: data.documentLabel,
    source: 'rto',
    comment: data.comment,
    status: 'pending',
    rtoEmail: data.rtoEmail,
    rtoName: data.rtoName,
    thread: [{
      role: 'rto',
      authorName: data.rtoName,
      content: data.comment,
      sentToStudent: false,
      createdAt: new Date(),
    }],
  });
  return feedback;
};

const createAdminFeedback = async (applicationId, data) => {
  const feedback = await DocumentFeedback.create({
    applicationId,
    documentField: data.documentField,
    documentLabel: data.documentLabel,
    source: 'admin',
    comment: data.comment,
    status: 'forwarded_to_student',
    sentToStudent: true,
    sentToStudentAt: new Date(),
    studentForwardedMessage: data.comment,
    adminEmail: data.adminEmail,
    adminName: data.adminName,
    thread: [{
      role: 'admin',
      authorName: data.adminName,
      content: data.comment,
      sentToStudent: true,
      createdAt: new Date(),
    }],
  });

  // Notify student (non-fatal)
  try {
    const Application = require('../models/Application');
    const { createNotification } = require('./notificationService');
    const app = await Application.findById(applicationId).select('studentId').lean();
    if (app?.studentId) {
      await createNotification({
        userId: app.studentId,
        type: 'feedback_received',
        title: 'Document Correction Required',
        message: `A correction has been requested for your ${data.documentLabel || 'document'}.`,
        link: `/student/documents/${applicationId}`,
        relatedId: applicationId,
      });
    }
  } catch (err) {
    console.error('[DocFeedback] Failed to create notification:', err.message);
  }

  return feedback;
};

/* ── Thread Replies ── */

const addThreadReply = async (feedbackId, { role, authorName, content, sentToStudent = false }) => {
  const feedback = await getById(feedbackId);
  feedback.thread.push({ role, authorName, content, sentToStudent, createdAt: new Date() });

  if (role === 'admin' && feedback.status === 'pending') {
    feedback.status = 'agent_responded';
  }

  await feedback.save();
  return feedback;
};

const rtoReply = async (feedbackId, { content, rtoName }) => {
  return addThreadReply(feedbackId, { role: 'rto', authorName: rtoName, content });
};

const studentReply = async (feedbackId, { content, studentName }) => {
  const feedback = await getById(feedbackId);
  feedback.thread.push({
    role: 'student',
    authorName: studentName,
    content,
    sentToStudent: true,
    createdAt: new Date(),
  });
  feedback.status = 'student_replied';
  await feedback.save();
  return feedback;
};

/* ── Escalation: Forward to Student ── */

const forwardToStudent = async (feedbackId, { studentMessage, adminName }) => {
  const feedback = await getById(feedbackId);
  feedback.thread.push({
    role: 'admin',
    authorName: adminName,
    content: studentMessage,
    sentToStudent: true,
    createdAt: new Date(),
  });
  feedback.sentToStudent = true;
  feedback.sentToStudentAt = new Date();
  feedback.studentForwardedMessage = studentMessage;
  feedback.status = 'forwarded_to_student';
  await feedback.save();

  // Notify student (non-fatal)
  try {
    const Application = require('../models/Application');
    const { createNotification } = require('./notificationService');
    const app = await Application.findById(feedback.applicationId).select('studentId').lean();
    if (app?.studentId) {
      await createNotification({
        userId: app.studentId,
        type: 'feedback_received',
        title: 'Document Feedback',
        message: `You have new feedback on your ${feedback.documentLabel || 'document'}. Action required.`,
        link: '/student/applications',
        relatedId: feedback.applicationId,
      });
    }
  } catch (err) {
    console.error('[DocFeedback] Failed to create forward notification:', err.message);
  }

  return feedback;
};

/* ── Student Resolution ── */

const studentMarkComplete = async (feedbackId) => {
  const feedback = await getById(feedbackId);
  feedback.studentMarkedComplete = true;
  feedback.studentMarkedCompleteAt = new Date();
  feedback.status = 'student_resolved';
  feedback.thread.push({
    role: 'student',
    authorName: 'Student',
    content: 'Document re-uploaded — correction submitted.',
    sentToStudent: true,
    createdAt: new Date(),
  });
  await feedback.save();
  return feedback;
};

/* ── Admin Resolution Controls ── */

const adminApproveResolution = async (feedbackId, adminName) => {
  const feedback = await getById(feedbackId);
  if (feedback.source === 'admin') {
    feedback.status = 'resolved';
    feedback.resolvedAt = new Date();
    feedback.resolvedBy = adminName;
  } else {
    feedback.status = 'awaiting_rto_confirmation';
  }
  feedback.thread.push({
    role: 'admin',
    authorName: adminName,
    content: feedback.source === 'admin'
      ? 'Feedback resolved.'
      : 'Resolution approved — awaiting RTO confirmation.',
    sentToStudent: false,
    createdAt: new Date(),
  });
  await feedback.save();
  return feedback;
};

const adminRejectResolution = async (feedbackId, { rejectionMessage, adminName }) => {
  const feedback = await getById(feedbackId);
  feedback.status = 'forwarded_to_student';
  feedback.studentMarkedComplete = false;
  feedback.thread.push({
    role: 'admin',
    authorName: adminName,
    content: rejectionMessage || 'Resolution rejected — further correction needed.',
    sentToStudent: true,
    createdAt: new Date(),
  });
  await feedback.save();
  return feedback;
};

const resolveAdminDirect = async (feedbackId, adminName) => {
  const feedback = await getById(feedbackId);
  feedback.status = 'resolved';
  feedback.resolvedAt = new Date();
  feedback.resolvedBy = adminName;
  await feedback.save();
  return feedback;
};

/* ── RTO Resolution Controls ── */

const rtoMarkResolved = async (feedbackId, rtoName) => {
  const feedback = await getById(feedbackId);
  feedback.status = 'completed';
  feedback.resolvedAt = new Date();
  feedback.resolvedBy = rtoName;
  feedback.thread.push({
    role: 'rto',
    authorName: rtoName,
    content: 'RTO confirmed resolution.',
    createdAt: new Date(),
  });
  await feedback.save();
  return feedback;
};

const rtoRejectResolution = async (feedbackId, { rejectionMessage, rtoName }) => {
  const feedback = await getById(feedbackId);
  feedback.status = 'forwarded_to_student';
  feedback.studentMarkedComplete = false;
  feedback.thread.push({
    role: 'rto',
    authorName: rtoName,
    content: rejectionMessage || 'RTO rejected resolution — further correction required.',
    sentToStudent: true,
    createdAt: new Date(),
  });
  await feedback.save();
  return feedback;
};

/* ── Auto-resolve: called from documentController when student re-uploads ── */

const autoResolveOnReupload = async (applicationId, documentField) => {
  // Find ALL active (non-resolved) feedback for this document field
  const activeList = await DocumentFeedback.find({
    applicationId,
    documentField,
    status: { $nin: ['resolved', 'completed', 'student_resolved'] },
  });
  if (!activeList.length) return null;

  for (const active of activeList) {
    active.studentMarkedComplete = true;
    active.studentMarkedCompleteAt = new Date();
    active.status = 'student_resolved';
    active.thread.push({
      role: 'student',
      authorName: 'Student',
      content: 'Document re-uploaded — correction submitted.',
      sentToStudent: true,
      createdAt: new Date(),
    });
    await active.save();
  }
  return activeList[0];
};

/* ── Stats ── */

const getStats = async (applicationId) => {
  const all = await DocumentFeedback.find({ applicationId }).lean();
  const stats = { total: all.length, pending: 0, active: 0, resolved: 0 };
  for (const f of all) {
    if (['completed', 'resolved'].includes(f.status)) stats.resolved++;
    else if (f.status === 'pending') stats.pending++;
    else stats.active++;
  }
  return stats;
};

module.exports = {
  listByApplication,
  listForRto,
  listForStudent,
  getById,
  createRtoFeedback,
  createAdminFeedback,
  addThreadReply,
  rtoReply,
  studentReply,
  forwardToStudent,
  studentMarkComplete,
  adminApproveResolution,
  adminRejectResolution,
  resolveAdminDirect,
  rtoMarkResolved,
  rtoRejectResolution,
  autoResolveOnReupload,
  getStats,
};
