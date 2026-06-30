const express = require('express');
const controller = require('../controllers/ceoDashboardController');
const { protect, authorize } = require('../middleware/auth');

const router = express.Router();

// All routes require authentication + Admin, CEOReportingManager, or Marketing role
router.use(protect);
router.use(authorize('Admin', 'CEOReportingManager', 'Marketing'));

// ── Dashboard aggregation routes ──
router.get('/overview', controller.getOverview);
router.get('/leads', controller.getLeads);
router.get('/call-attempts', controller.getCallAttempts);
router.get('/agent-performance', controller.getAgentPerformance);
router.get('/marketing', controller.getMarketing);
router.get('/marketing/export', controller.exportMarketing);
router.post('/marketing/spend', controller.createMarketingSpend);
router.get('/supplier-liability', controller.getSupplierLiability);

// ── Expense Management routes ──
const Expense = require('../models/Expense');
const asyncHandler = require('../utils/asyncHandler');

router.get('/expenses', asyncHandler(async (req, res) => {
  const filter = {};
  if (req.query.startDate) filter.date = { ...filter.date, $gte: new Date(req.query.startDate) };
  if (req.query.endDate) filter.date = { ...filter.date, $lte: new Date(req.query.endDate) };
  if (req.query.category) filter.category = req.query.category;
  if (req.query.rtoName) filter.rtoName = req.query.rtoName;

  const page = parseInt(req.query.page, 10) || 1;
  const limit = parseInt(req.query.limit, 10) || 50;
  const [items, total] = await Promise.all([
    Expense.find(filter).populate('applicationId', 'applicationId status').populate('createdBy', 'firstName lastName')
      .sort({ date: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    Expense.countDocuments(filter),
  ]);
  res.json({ items, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
}));

router.get('/expenses/summary', asyncHandler(async (req, res) => {
  const filter = {};
  if (req.query.startDate) filter.date = { $gte: new Date(req.query.startDate) };
  if (req.query.endDate) filter.date = { ...filter.date, $lte: new Date(req.query.endDate) };

  const expenses = await Expense.find(filter).lean();
  const totals = { rtoCost: 0, studentRevenue: 0, profit: 0, count: expenses.length };
  const byRto = {};
  const byCategory = {};
  const byQualification = {};
  const monthly = {};

  for (const e of expenses) {
    totals.rtoCost += e.rtoCost || 0;
    totals.studentRevenue += e.studentRevenue || 0;
    totals.profit += e.profit || 0;

    const rto = e.rtoName || 'Unknown';
    if (!byRto[rto]) byRto[rto] = { rtoName: rto, rtoCost: 0, studentRevenue: 0, profit: 0, count: 0 };
    byRto[rto].rtoCost += e.rtoCost || 0;
    byRto[rto].studentRevenue += e.studentRevenue || 0;
    byRto[rto].profit += e.profit || 0;
    byRto[rto].count++;

    const cat = e.category || 'Other';
    if (!byCategory[cat]) byCategory[cat] = { category: cat, total: 0, count: 0 };
    byCategory[cat].total += e.rtoCost || 0;
    byCategory[cat].count++;

    const month = e.date ? new Date(e.date).toISOString().slice(0, 7) : 'Unknown';
    if (!monthly[month]) monthly[month] = { month, rtoCost: 0, studentRevenue: 0, profit: 0, count: 0 };
    monthly[month].rtoCost += e.rtoCost || 0;
    monthly[month].studentRevenue += e.studentRevenue || 0;
    monthly[month].profit += e.profit || 0;
    monthly[month].count++;

    const qual = e.qualification || 'Unspecified';
    if (!byQualification[qual]) byQualification[qual] = { qualification: qual, rtoCost: 0, studentRevenue: 0, profit: 0, count: 0 };
    byQualification[qual].rtoCost += e.rtoCost || 0;
    byQualification[qual].studentRevenue += e.studentRevenue || 0;
    byQualification[qual].profit += e.profit || 0;
    byQualification[qual].count++;
  }

  totals.avgMargin = totals.studentRevenue > 0 ? ((totals.profit / totals.studentRevenue) * 100).toFixed(1) : 0;

  res.json({
    totals,
    byRto: Object.values(byRto).sort((a, b) => b.rtoCost - a.rtoCost),
    byCategory: Object.values(byCategory).sort((a, b) => b.total - a.total),
    byQualification: Object.values(byQualification).sort((a, b) => b.rtoCost - a.rtoCost),
    monthly: Object.values(monthly).sort((a, b) => a.month.localeCompare(b.month)),
  });
}));

router.post('/expenses', asyncHandler(async (req, res) => {
  const item = await Expense.create({ ...req.body, createdBy: req.user._id });
  res.status(201).json({ item });
}));

router.patch('/expenses/:id', asyncHandler(async (req, res) => {
  const item = await Expense.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true });
  if (!item) return res.status(404).json({ message: 'Expense not found' });
  res.json({ item });
}));

router.delete('/expenses/:id', asyncHandler(async (req, res) => {
  const item = await Expense.findByIdAndDelete(req.params.id);
  if (!item) return res.status(404).json({ message: 'Expense not found' });
  res.json({ message: 'Expense deleted' });
}));

// ── Manual Revenue (Reconciliation) routes ──
const Payment = require('../models/Payment');
const Application = require('../models/Application');

// Get or create the reconciliation dummy application
async function getReconApp() {
  let app = await Application.findOne({ applicationId: 'RECONCILIATION' }).lean();
  if (!app) {
    app = await Application.create({
      applicationId: 'RECONCILIATION',
      status: 'New',
      notes: [{ content: 'Dummy application for off-portal revenue reconciliation', visibility: 'admin', addedAt: new Date() }],
    });
  }
  return app;
}

router.get('/manual-revenue', asyncHandler(async (req, res) => {
  const reconApp = await getReconApp();
  const filter = { applicationId: reconApp._id, type: 'manualMarkPaid' };
  if (req.query.dateFrom) filter.createdAt = { ...filter.createdAt, $gte: new Date(req.query.dateFrom) };
  if (req.query.dateTo) filter.createdAt = { ...filter.createdAt, $lte: new Date(req.query.dateTo) };

  const items = await Payment.find(filter)
    .populate('authorizedBy', 'firstName lastName')
    .sort({ createdAt: -1 })
    .limit(parseInt(req.query.limit, 10) || 100)
    .lean();
  res.json({ items, reconApplicationId: reconApp._id });
}));

router.post('/manual-revenue', asyncHandler(async (req, res) => {
  const reconApp = await getReconApp();
  const { amount, description, reference, date } = req.body;
  if (!amount || amount <= 0) return res.status(400).json({ message: 'Amount is required and must be positive' });

  const payment = await Payment.create({
    applicationId: reconApp._id,
    amount,
    type: 'manualMarkPaid',
    paymentMethod: 'manual',
    status: 'completed',
    manualPaymentReference: reference || '',
    manualPaymentReason: description || 'Off-portal revenue',
    notes: description || '',
    authorizedBy: req.user._id,
    createdAt: date ? new Date(date) : new Date(),
  });
  res.status(201).json({ item: payment });
}));

router.patch('/manual-revenue/:id', asyncHandler(async (req, res) => {
  const { amount, description, reference, date } = req.body;
  const update = {};
  if (amount !== undefined) update.amount = amount;
  if (description !== undefined) { update.manualPaymentReason = description; update.notes = description; }
  if (reference !== undefined) update.manualPaymentReference = reference;
  if (date !== undefined) update.createdAt = new Date(date);

  const item = await Payment.findByIdAndUpdate(req.params.id, update, { new: true, runValidators: true });
  if (!item) return res.status(404).json({ message: 'Revenue entry not found' });
  res.json({ item });
}));

router.delete('/manual-revenue/:id', asyncHandler(async (req, res) => {
  const item = await Payment.findByIdAndDelete(req.params.id);
  if (!item) return res.status(404).json({ message: 'Revenue entry not found' });
  res.json({ message: 'Revenue entry deleted' });
}));

// ── Cashflow routes ──
router.get('/cashflow/range', controller.getCashflowRange);
router.get('/cashflow/config', controller.getCashflowConfig);
router.patch('/cashflow/config', controller.updateCashflowConfig);
router.get('/cashflow/:weekKey', controller.getWeekSummary);
router.post('/cashflow/:weekKey/mark-paid', controller.markPaid);
router.post('/cashflow/:weekKey/undo-paid', controller.undoPaid);
router.post('/cashflow/:weekKey/flex-allocation', controller.setFlexAllocation);

module.exports = router;
