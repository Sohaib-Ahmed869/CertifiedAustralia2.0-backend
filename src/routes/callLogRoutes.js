const express = require('express');
const asyncHandler = require('../utils/asyncHandler');
const callLogService = require('../services/callLogService');
const { protect, authorize } = require('../middleware/auth');

const router = express.Router();

// Call logs are internal staff data — never exposed to students.
router.use(protect);
router.use(authorize('Admin', 'CEOReportingManager', 'Agent'));

// List call logs with filters (agentId, applicationId, direction, outcome, dateFrom, dateTo)
router.get('/', asyncHandler(async (req, res) => {
  const result = await callLogService.list(req.query);
  res.status(200).json(result);
}));

// Get daily stats for an agent
router.get('/agent-daily', asyncHandler(async (req, res) => {
  const { agentId, date } = req.query;
  if (!agentId) return res.status(400).json({ message: 'agentId is required' });
  const stats = await callLogService.getAgentDailyStats(agentId, date || new Date());
  res.status(200).json({ stats });
}));

module.exports = router;
