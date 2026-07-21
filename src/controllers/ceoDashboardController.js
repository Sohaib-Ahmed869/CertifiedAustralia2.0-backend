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

  exportMarketing: asyncHandler(async (req, res) => {
    const data = await ceoDashboardService.exportMarketingData(req.query);
    const { Parser } = require('json2csv');
    const fields = ['platform', 'spend', 'leads', 'conversions', 'revenue', 'cpaPerLead', 'cpaPerConversion', 'roas'];
    const parser = new Parser({ fields });
    const csv = parser.parse(data);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=marketing-data.csv');
    res.status(200).send(csv);
  }),

  createMarketingSpend: asyncHandler(async (req, res) => {
    const { weekKey, platforms } = req.body;
    if (!weekKey || !platforms?.length) {
      return res.status(400).json({ message: 'weekKey and platforms are required' });
    }

    // Upsert each (week, platform) cell — one record per cell, notes preserved,
    // amount 0 clears it. Prevents the duplicate rows the old create-only path made.
    const items = [];
    for (const p of platforms) {
      if (!p.platform) continue;
      const r = await ceoDashboardService.upsertMarketingSpend({
        weekKey,
        platform: p.platform,
        amount: p.amount,
        notes: p.notes,
        userId: req.user._id,
      });
      items.push(r);
    }

    res.status(201).json({ items });
  }),

  getMarketingSpendHistory: asyncHandler(async (req, res) => {
    const result = await ceoDashboardService.getMarketingSpendHistory({ weeks: req.query.weeks });
    res.status(200).json(result);
  }),

  deleteMarketingSpend: asyncHandler(async (req, res) => {
    const { weekKey, platform } = req.body;
    if (!weekKey || !platform) {
      return res.status(400).json({ message: 'weekKey and platform are required' });
    }
    const result = await ceoDashboardService.deleteMarketingSpend({ weekKey, platform });
    res.status(200).json(result);
  }),

  getWeeklyScorecard: asyncHandler(async (req, res) => {
    const result = await ceoDashboardService.getWeeklyScorecard(req.query);
    res.status(200).json(result);
  }),

  // ── Cashflow endpoints ──

  getSupplierLiability: asyncHandler(async (req, res) => {
    const result = await ceoDashboardService.getSupplierLiability(req.query);
    res.status(200).json(result);
  }),

  getCashflowRange: asyncHandler(async (req, res) => {
    const { dateFrom, dateTo } = req.query;
    if (!dateFrom || !dateTo) {
      return res.status(400).json({ message: 'dateFrom and dateTo are required' });
    }
    const result = await cashflowService.getRangeSummary(dateFrom, dateTo);
    res.status(200).json(result);
  }),

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
