const asyncHandler = require('../utils/asyncHandler');
const service = require('../services/callScorecardService');

/** Agents may only ever see/act on their own scorecard; staff can pass ?agentId=. */
function resolveAgentId(req) {
  if (req.user.role === 'Agent') return req.user._id;
  return req.query.agentId || req.body.agentId || req.user._id;
}

module.exports = {
  // Targets
  getTargets: asyncHandler(async (req, res) => {
    res.json(await service.readTargets());
  }),
  updateTargets: asyncHandler(async (req, res) => {
    res.json(await service.updateTargets(req.body, req.user._id));
  }),

  // Events
  listEvents: asyncHandler(async (req, res) => {
    const { date, applicationId, from, to } = req.query;
    // Application-scoped lookups aren't agent-restricted; date/agent lookups are.
    const agentId = applicationId ? req.query.agentId : resolveAgentId(req);
    const events = await service.listEvents({ date, agentId, applicationId, from, to });
    res.json(events);
  }),
  createEvent: asyncHandler(async (req, res) => {
    // Agents can only log calls under their own identity.
    const body = req.user.role === 'Agent' ? { ...req.body, agentId: req.user._id } : req.body;
    const event = await service.createEvent(body, req.user);
    res.status(201).json(event);
  }),
  updateEvent: asyncHandler(async (req, res) => {
    const event = await service.updateEvent(req.params.id, req.body);
    res.json(event);
  }),
  deleteEvent: asyncHandler(async (req, res) => {
    res.json(await service.deleteEvent(req.params.id));
  }),

  // Typeahead
  searchApplications: asyncHandler(async (req, res) => {
    res.json(await service.searchApplications(req.query.q));
  }),

  // Scorecards
  getIndividualScorecard: asyncHandler(async (req, res) => {
    const result = await service.getIndividualScorecard({
      date: req.query.date,
      from: req.query.from,
      to: req.query.to,
      agentId: resolveAgentId(req),
    });
    res.json(result);
  }),
  getTeamScorecard: asyncHandler(async (req, res) => {
    res.json(await service.getTeamScorecard(req.query));
  }),
  getByTimeDashboard: asyncHandler(async (req, res) => {
    res.json(await service.getByTimeDashboard(req.query));
  }),
};
