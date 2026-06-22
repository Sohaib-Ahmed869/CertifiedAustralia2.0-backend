const CallLog = require('../models/CallLog');
const Application = require('../models/Application');
const AppError = require('../utils/AppError');

/**
 * Log a call against an application.
 * Auto-increments contactAttempts or incomingCalls on the Application.
 */
const logCall = async (applicationId, { agentId, direction, outcome, notes }) => {
  const application = await Application.findById(applicationId);
  if (!application) throw new AppError('Application not found', 404);

  const callLog = await CallLog.create({
    applicationId,
    agentId,
    direction,
    outcome,
    notes: notes || '',
  });

  // Auto-increment counters on Application
  if (direction === 'outbound') {
    application.contactAttempts = (application.contactAttempts || 0) + 1;
  } else {
    application.incomingCalls = (application.incomingCalls || 0) + 1;
  }
  application.lastContactedAt = new Date();

  // Update contact status based on outcome
  const statusMap = {
    answered: 'Contacted',
    not_answered: 'No Answer',
    converted: 'Converted',
    follow_up_required: 'Follow-up Required',
    progressed: 'Progressed',
    support_completed: 'Support Completed',
    no_action: 'No Action',
  };
  application.contactStatus = statusMap[outcome] || application.contactStatus;
  await application.save();

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
