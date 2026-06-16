const asyncHandler = require('../utils/asyncHandler');
const ceoDashboardService = require('../services/ceoDashboardService');
const cashflowService = require('../services/cashflowService');

module.exports = {
  // ── Dashboard aggregation endpoints ──

  getOverview: asyncHandler(async (req, res) => {
    const result = await ceoDashboardService.getOverview(req.query);
    res.status(200).json(result);
  }),

  getLeads: asyncHandler(async (req, res) => {
    const result = await ceoDashboardService.getLeads(req.query);
    res.status(200).json(result);
  }),

  getCallAttempts: asyncHandler(async (req, res) => {
    const result = await ceoDashboardService.getCallAttempts(req.query);
    res.status(200).json(result);
  }),

  getAgentPerformance: asyncHandler(async (req, res) => {
    const result = await ceoDashboardService.getAgentPerformance(req.query);
    res.status(200).json(result);
  }),

  getMarketing: asyncHandler(async (req, res) => {
    const result = await ceoDashboardService.getMarketing(req.query);
    res.status(200).json(result);
  }),

  createMarketingSpend: asyncHandler(async (req, res) => {
    const data = { ...req.body, createdBy: req.user._id };
    const item = await ceoDashboardService.marketingSpend.create(data);
    res.status(201).json({ item });
  }),

  // ── Cashflow endpoints ──

  getCashflowConfig: asyncHandler(async (req, res) => {
    const config = await cashflowService.getConfig();
    res.status(200).json({ item: config });
  }),

  updateCashflowConfig: asyncHandler(async (req, res) => {
    const config = await cashflowService.updateConfig(req.body, req.user._id);
    res.status(200).json({ item: config });
  }),

  getWeekSummary: asyncHandler(async (req, res) => {
    const result = await cashflowService.getWeekSummary(req.params.weekKey);
    res.status(200).json(result);
  }),

  markPaid: asyncHandler(async (req, res) => {
    const { tierId, itemId, amount, notes } = req.body;
    const result = await cashflowService.markPaid(
      req.params.weekKey,
      tierId,
      itemId,
      amount,
      notes,
      req.user._id
    );
    res.status(200).json(result);
  }),

  undoPaid: asyncHandler(async (req, res) => {
    const { tierId, itemId } = req.body;
    const result = await cashflowService.undoPaid(
      req.params.weekKey,
      tierId,
      itemId,
      req.user._id
    );
    res.status(200).json(result);
  }),

  setFlexAllocation: asyncHandler(async (req, res) => {
    const { itemId, amount } = req.body;
    const result = await cashflowService.setFlexAllocation(
      req.params.weekKey,
      itemId,
      amount
    );
    res.status(200).json(result);
  }),
};
