const CallLog = require('../models/CallLog');
const Application = require('../models/Application');
const User = require('../models/User');
const AppError = require('../utils/AppError');

// Outcome → scorecard booleans. Anything that implies a conversation took place
// counts as answered; only an explicit conversion counts as converted.
const ANSWERED_OUTCOMES = new Set([
  'answered',
  'converted',
  'follow_up_required',
  'progressed',
  'support_completed',
]);

const STATUS_MAP = {
  answered: 'Contacted',
  not_answered: 'No Answer',
  converted: 'Converted',
  follow_up_required: 'Follow-up Required',
  progressed: 'Progressed',
  support_completed: 'Support Completed',
  no_action: 'No Action',
};

/**
 * Log a call against an application (legacy agent-portal call log).
 *
 * Writes the CallLog row for that page's history AND mirrors it into the Call
 * Scorecard (CallEvent) so the one set of numbers drives everything: the
 * scorecard, CEO Call Tracking, and the Application's Contact Tracking
 * counters — which contactTrackingService then recomputes from those events.
 */
const logCall = async (applicationId, { agentId, direction, outcome, notes }) => {
  const application = await Application.findById(applicationId)
    .populate('studentId', 'firstName lastName')
    .populate('qualificationId', 'name');
  if (!application) throw new AppError('Application not found', 404);

  const callLog = await CallLog.create({
    applicationId,
    agentId,
    direction,
    outcome,
    notes: notes || '',
  });

  // Mirror into the scorecard — createEvent also resyncs the contact counters.
  try {
    const agent = agentId
      ? await User.findById(agentId).select('firstName lastName email').lean()
      : null;
    if (agent) {
      const callScorecardService = require('./callScorecardService');
      await callScorecardService.createEvent(
        {
          agentId,
          leadName:
            `${application.studentId?.firstName || ''} ${application.studentId?.lastName || ''}`.trim() ||
            null,
          qualification: application.qualificationId?.name || null,
          applicationId: application._id,
          displayApplicationId: application.applicationId || null,
          answered: ANSWERED_OUTCOMES.has(outcome),
          converted: outcome === 'converted',
          direction: direction === 'outbound' ? 'outbound' : 'incoming',
          note: notes || null,
          entryMethod: 'agent-call-log',
        },
        { ...agent, _id: agentId }
      );
    }
  } catch (err) {
    console.warn(`[callLog] scorecard mirror failed for ${applicationId}: ${err.message}`);
  }

  // Contact status stays a plain label off the outcome (the counters and
  // lastContactedAt are handled by the scorecard sync above).
  if (STATUS_MAP[outcome]) {
    await Application.updateOne(
      { _id: application._id },
      { $set: { contactStatus: STATUS_MAP[outcome] } }
    );
  }

  return CallLog.findById(callLog._id)
    .populate('agentId', 'firstName lastName')
    .populate('applicationId', 'applicationId');
};

/**
 * List call logs with filters.
 */
const list = async (query = {}) => {
  const filter = {};

  if (query.applicationId) filter.applicationId = query.applicationId;
  if (query.agentId) filter.agentId = query.agentId;
  if (query.direction) filter.direction = query.direction;
  if (query.outcome) filter.outcome = query.outcome;

  if (query.dateFrom || query.dateTo) {
    filter.createdAt = {};
    if (query.dateFrom) filter.createdAt.$gte = new Date(query.dateFrom);
    if (query.dateTo) {
      const to = new Date(query.dateTo);
      to.setHours(23, 59, 59, 999);
      filter.createdAt.$lte = to;
    }
  }

  const page = parseInt(query.page, 10) || 1;
  const limit = parseInt(query.limit, 10) || 50;
  const skip = (page - 1) * limit;

  const [items, total] = await Promise.all([
    CallLog.find(filter)
      .populate('agentId', 'firstName lastName')
      .populate('applicationId', 'applicationId studentId')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    CallLog.countDocuments(filter),
  ]);

  return {
    items,
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
  };
};

/**
 * Get daily call stats for an agent (for scorecards).
 */
const getAgentDailyStats = async (agentId, date) => {
  const dayStart = new Date(date);
  dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(date);
  dayEnd.setHours(23, 59, 59, 999);

  const stats = await CallLog.aggregate([
    {
      $match: {
        agentId: require('mongoose').Types.ObjectId.createFromHexString(agentId),
        createdAt: { $gte: dayStart, $lte: dayEnd },
      },
    },
    {
      $group: {
        _id: '$outcome',
        count: { $sum: 1 },
      },
    },
  ]);

  const result = {
    total: 0,
    answered: 0,
    not_answered: 0,
    converted: 0,
    follow_up_required: 0,
    progressed: 0,
    support_completed: 0,
    no_action: 0,
  };
  for (const s of stats) {
    result[s._id] = s.count;
    result.total += s.count;
  }
  return result;
};

module.exports = { logCall, list, getAgentDailyStats };
