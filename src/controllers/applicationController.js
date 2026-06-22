const fs = require('fs');
const crypto = require('crypto');
const { Parser } = require('json2csv');
const asyncHandler = require('../utils/asyncHandler');
const AppError = require('../utils/AppError');
const createCrudController = require('./crudController');
const service = require('../services/applicationService');
const Application = require('../models/Application');
const driveService = require('../services/googleDriveService');
const callLogService = require('../services/callLogService');

const applications = createCrudController(service.applications);
const intakeForms = createCrudController(service.intakeForms);
const screeningForms = createCrudController(service.screeningForms);
const documents = createCrudController(service.documents);
const certificates = createCrudController(service.certificates);

module.exports = {
  applications,
  intakeForms,
  screeningForms,
  documents,
  certificates,
  createApplication: asyncHandler(async (req, res) => {
    const result = await service.createApplication(req.body);
    res.status(201).json({ item: result });
  }),
  updateApplication: applications.update,
  deleteApplication: applications.remove,
  getApplication: applications.getById,
  assignAgent: asyncHandler(async (req, res) => {
    const result = await service.assignAgent(req.params.id, req.body.assignedAgentId);
    res.status(200).json({ item: result });
  }),
  assignRTO: asyncHandler(async (req, res) => {
    const result = await service.assignRTO(req.params.id, req.body.assignedRTOId);
    res.status(200).json({ item: result });
  }),
  sendToRTOPortal: asyncHandler(async (req, res) => {
    const result = await service.sendToRTOPortal(req.params.id, req.body.rtoUserId);
    res.status(200).json({ item: result });
  }),
  sendRTOSubmission: asyncHandler(async (req, res) => {
    const result = await service.sendRTOSubmission(req.params.id, {
      rtoEmail: req.body.rtoEmail,
      rtoName: req.body.rtoName,
    });
    res.status(200).json({ item: result });
  }),
  updateStatus: asyncHandler(async (req, res) => {
    const result = await service.updateStatus(req.params.id, req.body.status);
    res.status(200).json({ item: result });
  }),
  createIntakeForm: asyncHandler(async (req, res) => {
    const result = await service.createIntakeForm(req.params.id, req.body);
    res.status(201).json({ item: result });
  }),
  updateIntakeForm: asyncHandler(async (req, res) => {
    const result = await service.intakeForms.update(req.params.formId, req.body);
    res.status(200).json({ item: result });
  }),
  createScreeningForm: asyncHandler(async (req, res) => {
    const result = await service.createScreeningForm(req.params.id, req.body);
    res.status(201).json({ item: result });
  }),
  updateScreeningForm: asyncHandler(async (req, res) => {
    const result = await service.screeningForms.update(req.params.formId, req.body);
    res.status(200).json({ item: result });
  }),
  uploadDocument: asyncHandler(async (req, res) => {
    const result = await service.uploadDocument(req.params.id, req.body);
    res.status(201).json({ item: result });
  }),
  uploadCertificate: asyncHandler(async (req, res) => {
    const appId = req.params.id;

    if (!req.file) throw new AppError('Certificate file is required', 400);

    const application = await Application.findById(appId).populate('studentId');
    if (!application) {
      fs.unlink(req.file.path, () => {});
      throw new AppError('Application not found', 404);
    }

    // Ensure Google Drive folder exists
    let folderId = application.googleDriveFolderId;
    if (!folderId) {
      const s = application.studentId;
      const studentName = s ? `${s.firstName || ''} ${s.lastName || ''}`.trim() : '';
      const folder = await driveService.createApplicationFolder({
        applicationId: application.applicationId,
        studentName,
      });
      folderId = folder.id;
      application.googleDriveFolderId = folderId;
      await application.save();
    }

    // Upload to Google Drive
    const driveName = `Certificate_${crypto.randomUUID()}_${req.file.originalname}`;
    const driveFile = await driveService.uploadFileFromDisk({
      filePath: req.file.path,
      fileName: driveName,
      mimeType: req.file.mimetype,
      folderId,
    });

    // Cleanup temp file
    fs.unlink(req.file.path, () => {});

    const certData = {
      certificateLink: driveFile.webViewLink,
      googleDriveFileId: driveFile.id,
      issuedBy: req.user._id,
      trackingNumber: req.body.trackingId || null,
      trackingLink: req.body.trackingLink || null,
    };

    const result = await service.issueCertificate(appId, certData);
    res.status(201).json({ item: result });
  }),
  addNote: asyncHandler(async (req, res) => {
    const result = await service.addNote(req.params.id, req.body);
    res.status(201).json({ item: result });
  }),

  searchNotes: asyncHandler(async (req, res) => {
    const results = await service.searchNotes(req.query.q, {
      visibility: req.query.visibility,
      limit: parseInt(req.query.limit, 10) || 50,
    });
    res.status(200).json({ items: results });
  }),

  editNote: asyncHandler(async (req, res) => {
    const result = await service.editNote(req.params.id, req.params.noteId, {
      content: req.body.content,
      userId: req.user._id,
      userRole: req.user.role,
    });
    res.status(200).json({ item: result });
  }),

  deleteNote: asyncHandler(async (req, res) => {
    const result = await service.deleteNote(req.params.id, req.params.noteId, {
      userId: req.user._id,
      userRole: req.user.role,
    });
    res.status(200).json({ item: result });
  }),

  addDiscount: asyncHandler(async (req, res) => {
    const result = await service.addDiscount(req.params.id, {
      ...req.body,
      createdBy: req.user._id,
    });
    res.status(201).json({ item: result });
  }),

  removeDiscount: asyncHandler(async (req, res) => {
    const result = await service.removeDiscount(req.params.id, req.params.discountId);
    res.status(200).json({ item: result });
  }),

  createAdditionalDocRequest: asyncHandler(async (req, res) => {
    const result = await service.createAdditionalDocRequest(req.params.id, {
      ...req.body,
      requestedBy: req.user._id,
    });
    res.status(201).json({ item: result });
  }),

  submitAdditionalDocs: asyncHandler(async (req, res) => {
    const result = await service.submitAdditionalDocs(req.params.id, req.params.requestId);
    res.status(200).json({ item: result });
  }),

  reviewAdditionalDocs: asyncHandler(async (req, res) => {
    const result = await service.reviewAdditionalDocs(req.params.id, req.params.requestId, {
      ...req.body,
      reviewedBy: req.user._id,
    });
    res.status(200).json({ item: result });
  }),

  notifySoftCopy: asyncHandler(async (req, res) => {
    const result = await service.notifySoftCopy(req.params.certId);
    res.status(200).json({ item: result });
  }),

  dispatchHardCopy: asyncHandler(async (req, res) => {
    const result = await service.dispatchHardCopy(req.params.certId, req.body);
    res.status(200).json({ item: result });
  }),

  createRTOSubmission: asyncHandler(async (req, res) => {
    const result = await service.createRTOSubmission(req.params.id, {
      ...req.body,
      sentBy: req.user._id,
    });
    res.status(201).json({ item: result });
  }),

  logCall: asyncHandler(async (req, res) => {
    const result = await callLogService.logCall(req.params.id, {
      ...req.body,
      agentId: req.user._id,
    });
    res.status(201).json({ item: result });
  }),

  reviewDocument: asyncHandler(async (req, res) => {
    const result = await service.reviewDocument(req.params.id, req.params.docId, {
      ...req.body,
      verifiedBy: req.user._id,
    });
    res.status(200).json({ item: result });
  }),

  updateTimer: asyncHandler(async (req, res) => {
    const result = await service.updateTimer(req.params.id, req.body);
    res.status(200).json({ item: result });
  }),

  getStats: asyncHandler(async (req, res) => {
    const stats = await service.getStats(req.query);
    res.status(200).json({ stats });
  }),

  exportCsv: asyncHandler(async (req, res) => {
    const filters = {
      status: req.query.status,
      agentId: req.query.agentId,
      dateFrom: req.query.dateFrom,
      dateTo: req.query.dateTo,
    };

    const data = await service.exportCsv(filters);

    const fields = [
      'applicationId',
      'studentName',
      'studentEmail',
      'qualification',
      'industry',
      'status',
      'assignedAgent',
      'createdAt',
      'price',
      'discount',
      'paymentStatus',
    ];
    const parser = new Parser({ fields });
    const csv = parser.parse(data);

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=applications.csv');
    res.status(200).send(csv);
  }),
};
