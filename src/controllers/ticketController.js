const fs = require('fs');
const asyncHandler = require('../utils/asyncHandler');
const createCrudController = require('./crudController');
const service = require('../services/ticketService');
const { uploadFileFromDisk, resolveFolderId } = require('../services/googleDriveService');

const tickets = createCrudController(service.tickets);

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
    res.status(201).json({ item: result });
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
    res.status(201).json({ item: result });
  }),

  resolveTicket: asyncHandler(async (req, res) => {
    const result = await service.resolveTicket(
      req.params.id,
      req.user._id,
      req.body.message
    );
    res.status(200).json({ item: result });
  }),

  getStats: asyncHandler(async (req, res) => {
    const userId = req.query.userId || req.user._id;
    const result = await service.getStats(userId);
    res.status(200).json(result);
  }),
};
