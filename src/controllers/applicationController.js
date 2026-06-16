const { Parser } = require('json2csv');
const asyncHandler = require('../utils/asyncHandler');
const createCrudController = require('./crudController');
const service = require('../services/applicationService');

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
  issueCertificate: asyncHandler(async (req, res) => {
    const result = await service.issueCertificate(req.params.id, req.body);
    res.status(201).json({ item: result });
  }),
  addNote: asyncHandler(async (req, res) => {
    const result = await service.addNote(req.params.id, req.body);
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
