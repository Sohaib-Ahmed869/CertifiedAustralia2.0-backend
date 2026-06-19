const AgentTarget = require('../models/AgentTarget');
const User = require('../models/User');
const Application = require('../models/Application');
const Payment = require('../models/Payment');
const AppError = require('../utils/AppError');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const getWeekStart = (date = new Date()) => {
  const d = new Date(date);
  const day = d.getDay();
  const diff = d.getDate() - day + (day === 0 ? -6 : 1); // Monday
  return new Date(d.getFullYear(), d.getMonth(), diff);
};

const getMonthStart = (date = new Date()) => {
  return new Date(date.getFullYear(), date.getMonth(), 1);
};

const PAID_STATUSES = [
  'StudentIntakeForm', 'UploadDocuments', 'DocumentsUploaded',
  'StudentCompleted', 'SentToRTO', 'WaitingForVerification',
  'ReadyForRTOPayment', 'RTOInvoiceUploaded',
  'CertificateGenerated', 'CertificateIssued',
];

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

/**
 * Set or update a target for an agent.
 */
const upsertTarget = async (data) => {
  const { agentId, period, periodStart, ...fields } = data;

  const agent = await User.findOne({ _id: agentId, role: 'Agent', status: 'active' });
  if (!agent) throw new AppError('Agent not found or inactive', 404);

  const target = await AgentTarget.findOneAndUpdate(
    { agentId, period, periodStart: new Date(periodStart) },
    { ...fields, agentId, period, periodStart: new Date(periodStart) },
    { upsert: true, new: true, runValidators: true }
  ).populate('agentId', 'firstName lastName email')
   .populate('setBy', 'firstName lastName');

  return target.toObject();
};

/**
 * Bulk set the same targets for multiple agents.
 */
const bulkSetTargets = async ({ agentIds, period, periodStart, ...fields }) => {
  const results = [];

  for (const agentId of agentIds) {
    try {
      const target = await upsertTarget({ agentId, period, periodStart, ...fields });
      results.push({ agentId, success: true, target });
    } catch (err) {
      results.push({ agentId, success: false, error: err.message });
    }
  }

  return results;
};

/**
 * Get targets for a specific period.
 */
const getTargets = async (query = {}) => {
  const filter = {};

  if (query.agentId) filter.agentId = query.agentId;
  if (query.period) filter.period = query.period;
  if (query.periodStart) filter.periodStart = new Date(query.periodStart);

  const targets = await AgentTarget.find(filter)
    .populate('agentId', 'firstName lastName email')
    .populate('setBy', 'firstName lastName')
    .sort({ periodStart: -1 })
    .lean();

  return targets;
};

/**
 * Get a single target by ID.
 */
const getTargetById = async (id) => {
  const target = await AgentTarget.findById(id)
    .populate('agentId', 'firstName lastName email')
    .populate('setBy', 'firstName lastName')
    .lean();

  if (!target) throw new AppError('Target not found', 404);
  return target;
};

/**
 * Delete a target.
 */
const deleteTarget = async (id) => {
  const target = await AgentTarget.findByIdAndDelete(id);
  if (!target) throw new AppError('Target not found', 404);
  return { message: 'Target deleted' };
};

// ---------------------------------------------------------------------------
// Performance vs Target comparison
// ---------------------------------------------------------------------------

/**
 * Get all agents' performance vs their targets for a given period.
 */
const getPerformanceVsTargets = async ({ period = 'weekly', date }) => {
  const periodStart = period === 'weekly' ? getWeekStart(date) : getMonthStart(date);
  const periodEnd = new Date(periodStart);

  if (period === 'weekly') {
    periodEnd.setDate(periodEnd.getDate() + 7);
  } else {
    periodEnd.setMonth(periodEnd.getMonth() + 1);
  }

  // Get all active agents
  const agents = await User.find(
    { role: 'Agent', status: 'active' },
    'firstName lastName email'
  ).lean();

  // Get targets for this period
  const targets = await AgentTarget.find({
    period,
    periodStart,
  }).lean();

  const targetMap = new Map(targets.map((t) => [t.agentId.toString(), t]));

  // Calculate actuals for each agent
  const results = [];

  for (const agent of agents) {
    const agentId = agent._id.toString();
    const target = targetMap.get(agentId) || {};

    // Assigned apps in period
    const assigned = await Application.countDocuments({
      assignedAgentId: agent._id,
      createdAt: { $gte: periodStart, $lt: periodEnd },
    });

    // Paid apps in period
    const paid = await Application.countDocuments({
      assignedAgentId: agent._id,
      status: { $in: PAID_STATUSES },
      updatedAt: { $gte: periodStart, $lt: periodEnd },
    });

    // Revenue in period
    const revenueAgg = await Payment.aggregate([
      {
        $match: {
          status: 'completed',
          type: { $in: ['upfront', 'plan', 'manualMarkPaid'] },
          createdAt: { $gte: periodStart, $lt: periodEnd },
        },
      },
      {
        $lookup: {
          from: 'applications',
          localField: 'applicationId',
          foreignField: '_id',
          as: 'app',
        },
      },
      { $unwind: '$app' },
      { $match: { 'app.assignedAgentId': agent._id } },
      { $group: { _id: null, total: { $sum: '$amount' } } },
    ]);

    const revenue = revenueAgg[0]?.total || 0;

    // Call attempts in period
    const callsAgg = await Application.aggregate([
      {
        $match: {
          assignedAgentId: agent._id,
          updatedAt: { $gte: periodStart, $lt: periodEnd },
        },
      },
      { $group: { _id: null, total: { $sum: '$contactAttempts' } } },
    ]);

    const calls = callsAgg[0]?.total || 0;
    const conversionPct = assigned > 0 ? Math.round((paid / assigned) * 100) : 0;

    results.push({
      agent: {
        _id: agent._id,
        firstName: agent.firstName,
        lastName: agent.lastName,
        email: agent.email,
      },
      target: {
        revenueTarget: target.revenueTarget || 0,
        paidAppsTarget: target.paidAppsTarget || 0,
        callsTarget: target.callsTarget || 0,
        conversionTarget: target.conversionTarget || 0,
        notes: target.notes || '',
        _id: target._id || null,
      },
      actual: {
        assigned,
        paid,
        revenue,
        calls,
        conversionPct,
      },
      progress: {
        revenue: target.revenueTarget ? Math.round((revenue / target.revenueTarget) * 100) : null,
        paidApps: target.paidAppsTarget ? Math.round((paid / target.paidAppsTarget) * 100) : null,
        calls: target.callsTarget ? Math.round((calls / target.callsTarget) * 100) : null,
        conversion: target.conversionTarget ? Math.round((conversionPct / target.conversionTarget) * 100) : null,
      },
    });
  }

  return {
    period,
    periodStart,
    periodEnd,
    agents: results,
  };
};

module.exports = {
  upsertTarget,
  bulkSetTargets,
  getTargets,
  getTargetById,
  deleteTarget,
  getPerformanceVsTargets,
};
