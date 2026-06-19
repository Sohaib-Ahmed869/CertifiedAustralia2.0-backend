const asyncHandler = require('../utils/asyncHandler');
const service = require('../services/documentFeedbackService');

/* ── Admin / Agent endpoints ── */

const listForApplication = asyncHandler(async (req, res) => {
  const items = await service.listByApplication(req.params.applicationId, {
    source: req.query.source,
    status: req.query.status,
  });
  res.status(200).json({ items });
});

const listAdminDirect = asyncHandler(async (req, res) => {
  const items = await service.listByApplication(req.params.applicationId, { source: 'admin' });
  res.status(200).json({ items });
});

const createAdminFeedback = asyncHandler(async (req, res) => {
  const item = await service.createAdminFeedback(req.params.applicationId, {
    ...req.body,
    adminEmail: req.user?.email,
    adminName: req.user ? `${req.user.firstName || ''} ${req.user.lastName || ''}`.trim() : 'Admin',
  });
  res.status(201).json({ item });
});

const adminReply = asyncHandler(async (req, res) => {
  const item = await service.addThreadReply(req.params.id, {
    role: 'admin',
    authorName: req.user ? `${req.user.firstName || ''} ${req.user.lastName || ''}`.trim() : 'Admin',
    content: req.body.content,
    sentToStudent: req.body.sentToStudent || false,
  });
  res.status(200).json({ item });
});

const forwardToStudent = asyncHandler(async (req, res) => {
  const item = await service.forwardToStudent(req.params.id, {
    studentMessage: req.body.studentMessage || req.body.content,
    adminName: req.user ? `${req.user.firstName || ''} ${req.user.lastName || ''}`.trim() : 'Admin',
  });
  res.status(200).json({ item });
});

const approveResolution = asyncHandler(async (req, res) => {
  const adminName = req.user ? `${req.user.firstName || ''} ${req.user.lastName || ''}`.trim() : 'Admin';
  const item = await service.adminApproveResolution(req.params.id, adminName);
  res.status(200).json({ item });
});

const rejectResolution = asyncHandler(async (req, res) => {
  const item = await service.adminRejectResolution(req.params.id, {
    rejectionMessage: req.body.rejectionMessage || req.body.content,
    adminName: req.user ? `${req.user.firstName || ''} ${req.user.lastName || ''}`.trim() : 'Admin',
  });
  res.status(200).json({ item });
});

const resolveAdminDirect = asyncHandler(async (req, res) => {
  const adminName = req.user ? `${req.user.firstName || ''} ${req.user.lastName || ''}`.trim() : 'Admin';
  const item = await service.resolveAdminDirect(req.params.id, adminName);
  res.status(200).json({ item });
});

const getStats = asyncHandler(async (req, res) => {
  const stats = await service.getStats(req.params.applicationId);
  res.status(200).json(stats);
});

/* ── RTO endpoints ── */

const listForRto = asyncHandler(async (req, res) => {
  const items = await service.listForRto(req.params.applicationId);
  res.status(200).json({ items });
});

const createRtoFeedback = asyncHandler(async (req, res) => {
  const item = await service.createRtoFeedback(req.params.applicationId, {
    ...req.body,
    rtoEmail: req.user?.email,
    rtoName: req.user ? `${req.user.firstName || ''} ${req.user.lastName || ''}`.trim() : 'RTO',
  });
  res.status(201).json({ item });
});

const rtoReply = asyncHandler(async (req, res) => {
  const item = await service.rtoReply(req.params.id, {
    content: req.body.content,
    rtoName: req.user ? `${req.user.firstName || ''} ${req.user.lastName || ''}`.trim() : 'RTO',
  });
  res.status(200).json({ item });
});

const rtoResolve = asyncHandler(async (req, res) => {
  const rtoName = req.user ? `${req.user.firstName || ''} ${req.user.lastName || ''}`.trim() : 'RTO';
  const item = await service.rtoMarkResolved(req.params.id, rtoName);
  res.status(200).json({ item });
});

const rtoRejectResolution = asyncHandler(async (req, res) => {
  const item = await service.rtoRejectResolution(req.params.id, {
    rejectionMessage: req.body.rejectionMessage || req.body.content,
    rtoName: req.user ? `${req.user.firstName || ''} ${req.user.lastName || ''}`.trim() : 'RTO',
  });
  res.status(200).json({ item });
});

/* ── Student endpoints ── */

const listForStudent = asyncHandler(async (req, res) => {
  const items = await service.listForStudent(req.params.applicationId);
  res.status(200).json({ items });
});

const studentReply = asyncHandler(async (req, res) => {
  const item = await service.studentReply(req.params.id, {
    content: req.body.content,
    studentName: req.user ? `${req.user.firstName || ''} ${req.user.lastName || ''}`.trim() : 'Student',
  });
  res.status(200).json({ item });
});

const studentMarkComplete = asyncHandler(async (req, res) => {
  const item = await service.studentMarkComplete(req.params.id);
  res.status(200).json({ item });
});

module.exports = {
  listForApplication,
  listAdminDirect,
  createAdminFeedback,
  adminReply,
  forwardToStudent,
  approveResolution,
  rejectResolution,
  resolveAdminDirect,
  getStats,
  listForRto,
  createRtoFeedback,
  rtoReply,
  rtoResolve,
  rtoRejectResolution,
  listForStudent,
  studentReply,
  studentMarkComplete,
};
