const { Parser } = require('json2csv');
const asyncHandler = require('../utils/asyncHandler');
const AppError = require('../utils/AppError');
const createCrudController = require('./crudController');
const service = require('../services/paymentService');

const payments = createCrudController(service.payments);
const paymentPlans = createCrudController(service.paymentPlans);

// Ownership guard: a Student may only ever see records tied to their own account.
const ownerId = (doc) => String(doc?.studentId?._id || doc?.studentId || '');

const scopedList = (crudService) => asyncHandler(async (req, res) => {
  const query = { ...req.query };
  if (req.user.role === 'Student') query.studentId = String(req.user._id);
  const result = await crudService.list(query);
  res.status(200).json(result);
});

const scopedGetById = (crudService) => asyncHandler(async (req, res) => {
  const result = await crudService.getById(req.params.id);
  if (req.user.role === 'Student' && ownerId(result) !== String(req.user._id)) {
    throw new AppError('Not authorized to access this record', 403);
  }
  res.status(200).json({ item: result });
});

module.exports = {
  payments,
  paymentPlans,
  // Student-scoped read handlers (used by routes instead of the raw CRUD ones)
  listPayments: scopedList(service.payments),
  getPaymentById: scopedGetById(service.payments),
  listPaymentPlans: scopedList(service.paymentPlans),
  getPaymentPlanById: scopedGetById(service.paymentPlans),
  createPayment: asyncHandler(async (req, res) => {
    const body = { ...req.body };
    // A student may only record a payment against their OWN application.
    if (req.user.role === 'Student') {
      const Application = require('../models/Application');
      const app = await Application.findById(body.applicationId).select('studentId').lean();
      if (!app || String(app.studentId) !== String(req.user._id)) {
        throw new AppError('Not authorized to pay for this application', 403);
      }
      body.studentId = String(req.user._id);
    }
    const result = await service.createPaymentRecord(body);
    res.status(201).json({ item: result });
  }),
  createPaymentPlan: asyncHandler(async (req, res) => {
    const result = await service.createPaymentPlan(req.body);
    res.status(201).json({ item: result });
  }),
  updatePaymentPlan: asyncHandler(async (req, res) => {
    const result = await service.updatePaymentPlan(req.params.id, req.body);
    res.status(200).json({ item: result });
  }),
  applyPaymentToPlan: asyncHandler(async (req, res) => {
    const result = await service.applyPaymentToPlan(req.params.id, req.body);
    res.status(201).json(result);
  }),

  pausePlan: asyncHandler(async (req, res) => {
    const result = await service.pausePlan(req.params.id);
    res.status(200).json({ item: result });
  }),
  resumePlan: asyncHandler(async (req, res) => {
    const result = await service.resumePlan(req.params.id);
    res.status(200).json({ item: result });
  }),
  cancelPlan: asyncHandler(async (req, res) => {
    const result = await service.cancelPlan(req.params.id);
    res.status(200).json({ item: result });
  }),
  skipInstallment: asyncHandler(async (req, res) => {
    const result = await service.skipInstallment(req.params.id, req.params.index);
    res.status(200).json({ item: result });
  }),

  getStats: asyncHandler(async (req, res) => {
    const stats = await service.getStats(req.query);
    res.status(200).json({ stats });
  }),

  exportCsv: asyncHandler(async (req, res) => {
    const filters = {
      status: req.query.status,
      type: req.query.type,
      dateFrom: req.query.dateFrom,
      dateTo: req.query.dateTo,
    };

    const data = await service.exportCsv(filters);

    const fields = [
      'paymentId',
      'applicationId',
      'studentName',
      'type',
      'method',
      'amount',
      'status',
      'createdAt',
    ];
    const parser = new Parser({ fields });
    const csv = parser.parse(data);

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=payments.csv');
    res.status(200).send(csv);
  }),
};
