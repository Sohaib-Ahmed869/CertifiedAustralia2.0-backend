const fs = require('fs');
const asyncHandler = require('../utils/asyncHandler');
const createCrudController = require('./crudController');
const service = require('../services/ticketService');
const { uploadFileFromDisk, resolveFolderId } = require('../services/googleDriveService');

const tickets = createCrudController(service.tickets);

// Only the support side may see internal notes. Everyone else (the requester —
// Student/Agent/RTO/Marketing) must never receive `isInternal` messages.
const STAFF_ROLES = ['Support', 'Admin', 'CEOReportingManager'];
const canSeeInternal = (user) => STAFF_ROLES.includes(user?.role);
const stripInternal = (ticket, user) => {
  if (!ticket || canSeeInternal(user)) return ticket;
  return { ...ticket, messages: (ticket.messages || []).filter((m) => !m.isInternal) };
};

// A ticket is "awaiting response" when it's unresolved and the last
// requester-visible message is from the requester (new ticket or a reply).
const computeAwaiting = (ticket) => {
  if (!ticket || ['resolved', 'closed'].includes(ticket.status)) return false;
  const visible = (ticket.messages || []).filter((m) => !m.isInternal);
  const last = visible[visible.length - 1];
  return last ? last.senderRole === 'requester' : false;
};
const decorate = (ticket, user) => ({ ...stripInternal(ticket, user), awaitingResponse: computeAwaiting(ticket) });

/**
 * Upload an array of multer files to Google Drive and return attachment metadata.
 * Failures are logged but do not reject — the request proceeds without attachments.
 */
const uploadFilesToDrive = async (files) => {
  const attachments = [];

  for (const file of files) {
    try {
      const result = await uploadFileFromDisk({
        filePath: file.path,
        fileName: file.originalname,
        mimeType: file.mimetype,
        folderId: resolveFolderId(),
      });

      attachments.push({
        fileName: file.originalname,
        fileUrl: result.webViewLink || `https://drive.google.com/file/d/${result.id}/view`,
        fileType: file.mimetype,
      });
    } catch (err) {
      console.error(`[TicketController] Google Drive upload failed for "${file.originalname}":`, err.message);
    } finally {
      // Always clean up the temp file
      fs.unlink(file.path, () => {});
    }
  }

  return attachments;
};

module.exports = {
  ...tickets,

  // Override CRUD reads to strip internal notes for the requester side.
  getById: asyncHandler(async (req, res) => {
    const item = await service.tickets.getById(req.params.id);
    res.status(200).json({ item: decorate(item, req.user) });
  }),

  list: asyncHandler(async (req, res) => {
    const result = await service.tickets.list(req.query);
    result.items = (result.items || []).map((t) => decorate(t, req.user));
    res.status(200).json(result);
  }),

  createTicket: asyncHandler(async (req, res) => {
    let attachments = [];

    if (req.files && req.files.length > 0) {
      attachments = await uploadFilesToDrive(req.files);
    }

    const result = await service.createTicket({
      ...req.body,
      requesterId: req.body.requesterId || req.user._id,
      senderRole: req.user.role === 'Support' ? 'support' : 'requester',
      attachments,
    });
    res.status(201).json({ item: stripInternal(result, req.user) });
  }),

  addMessage: asyncHandler(async (req, res) => {
    let attachments = [];

    if (req.files && req.files.length > 0) {
      attachments = await uploadFilesToDrive(req.files);
    }

    const result = await service.addMessage(req.params.id, {
      ...req.body,
      senderId: req.user._id,
      senderRole: req.user.role === 'Support' || req.user.role === 'Admin' || req.user.role === 'CEOReportingManager'
        ? 'support'
        : 'requester',
      attachments,
    });
    res.status(201).json({ item: stripInternal(result, req.user) });
  }),

  resolveTicket: asyncHandler(async (req, res) => {
    const result = await service.resolveTicket(
      req.params.id,
      req.user._id,
      req.body.message
    );
    res.status(200).json({ item: stripInternal(result, req.user) });
  }),

  getStats: asyncHandler(async (req, res) => {
    const userId = req.query.userId || req.user._id;
    const result = await service.getStats(userId);
    res.status(200).json(result);
  }),
};
