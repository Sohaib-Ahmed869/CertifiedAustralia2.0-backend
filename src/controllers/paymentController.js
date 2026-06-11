const { Parser } = require('json2csv');
const asyncHandler = require('../utils/asyncHandler');
const createCrudController = require('./crudController');
const service = require('../services/paymentService');

const payments = createCrudController(service.payments);
const paymentPlans = createCrudController(service.paymentPlans);

module.exports = {
  payments,
  paymentPlans,
  createPayment: asyncHandler(async (req, res) => {
    const result = await service.createPaymentRecord(req.body);
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
    const stats = await service.getStats();
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
