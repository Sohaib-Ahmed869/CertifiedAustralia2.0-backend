const asyncHandler = require('../utils/asyncHandler');
const AppError = require('../utils/AppError');
const service = require('../services/paymentLinkService');

/**
 * Ownership guard for the student portal.
 *
 * Students may READ their own links (so they can pay from inside the portal
 * instead of digging the email out) and nothing else. Every write path is
 * staff-only at the route layer — a student must never be able to mint, resend
 * or cancel a request for money.
 */
const scopeToStudent = (req, query) => {
  if (req.user.role === 'Student') {
    return { ...query, studentId: String(req.user._id) };
  }
  return query;
};

const assertOwnership = (req, link) => {
  if (req.user.role !== 'Student') return;
  const owner = String(link?.studentId?._id || link?.studentId || '');
  if (owner !== String(req.user._id)) {
    throw new AppError('Not authorized to access this payment link', 403);
  }
};

module.exports = {
  list: asyncHandler(async (req, res) => {
    const result = await service.listLinks(scopeToStudent(req, req.query));
    res.status(200).json(result);
  }),

  getById: asyncHandler(async (req, res) => {
    const link = await service.getLink(req.params.id);
    assertOwnership(req, link);
    res.status(200).json({ item: link });
  }),

  // What may still be requested on an application — drives the amount field's
  // default and its max, so the UI can't offer to over-collect.
  getBalance: asyncHandler(async (req, res) => {
    const Application = require('../models/Application');
    if (req.user.role === 'Student') {
      const app = await Application.findById(req.params.applicationId).select('studentId').lean();
      if (!app || String(app.studentId) !== String(req.user._id)) {
        throw new AppError('Not authorized to access this application', 403);
      }
    }
    const balance = await service.balanceFor(req.params.applicationId);
    res.status(200).json({ balance });
  }),

  create: asyncHandler(async (req, res) => {
    const link = await service.createLink(req.body, req.user);
    res.status(201).json({ item: link });
  }),

  resend: asyncHandler(async (req, res) => {
    const link = await service.resendLink(req.params.id, req.user, req.body?.sendTo);
    res.status(200).json({ item: link });
  }),

  cancel: asyncHandler(async (req, res) => {
    const link = await service.cancelLink(req.params.id, req.user);
    res.status(200).json({ item: link });
  }),
};
