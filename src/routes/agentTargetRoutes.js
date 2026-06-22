const express = require('express');
const { protect, authorize } = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');
const agentTargetService = require('../services/agentTargetService');

const router = express.Router();

router.use(protect);

// GET /api/agent-targets/my-performance — agent self-view (accessible to agents)
router.get(
  '/my-performance',
  authorize('Agent', 'Admin', 'CEOReportingManager'),
  asyncHandler(async (req, res) => {
    const result = await agentTargetService.getMyPerformance(req.user._id);
    res.json(result);
  })
);

// All routes below require Admin/CEO
router.use(authorize('Admin', 'CEOReportingManager'));

// GET /api/agent-targets/performance — performance vs targets comparison
router.get(
  '/performance',
  asyncHandler(async (req, res) => {
    const { period, date } = req.query;
    const result = await agentTargetService.getPerformanceVsTargets({
      period: period || 'weekly',
      date: date ? new Date(date) : new Date(),
    });
    res.json(result);
  })
);

// GET /api/agent-targets — list targets with optional filters
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const targets = await agentTargetService.getTargets(req.query);
    res.json({ items: targets });
  })
);

// GET /api/agent-targets/:id — get a single target
router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const target = await agentTargetService.getTargetById(req.params.id);
    res.json({ item: target });
  })
);

// POST /api/agent-targets — upsert a single target
router.post(
  '/',
  asyncHandler(async (req, res) => {
    const target = await agentTargetService.upsertTarget({
      ...req.body,
      setBy: req.user._id,
    });
    res.status(201).json({ item: target });
  })
);

// POST /api/agent-targets/bulk — set targets for multiple agents
router.post(
  '/bulk',
  asyncHandler(async (req, res) => {
    const results = await agentTargetService.bulkSetTargets({
      ...req.body,
      setBy: req.user._id,
    });
    res.json({ results });
  })
);

// DELETE /api/agent-targets/:id — delete a target
router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const result = await agentTargetService.deleteTarget(req.params.id);
    res.json(result);
  })
);

module.exports = router;
