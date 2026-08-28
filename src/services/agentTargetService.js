const AgentTarget = require('../models/AgentTarget');
const User = require('../models/User');
const Application = require('../models/Application');
const Payment = require('../models/Payment');
const CallLog = require('../models/CallLog');
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

// "Paid" = money actually received on the application, not "advanced past the
// payment stage" — an admin can move a student forward without a payment, and
// counting those inflated every conversion figure. Mirrors the same rule in
// ceoDashboardService (see the PAID_MATCH comment there); partials count.
const PAID_MATCH = { $or: [{ paymentCompleted: true }, { partialPayment: true }] };

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

/**
 * Set or update a target for an agent.
 */
const upsertTarget = async (data) => {
  const { agentId, period, periodStart, ...fields } = data;

  const agent = await User.findOne({ _id: agentId, isSalesAgent: true, status: 'active' });
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

  // Get all active agents (anyone flagged as a sales agent, regardless of role)
  const agents = await User.find(
    { isSalesAgent: true, status: 'active' },
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
      isTest: { $ne: true }, isArchived: { $ne: true },
      status: { $ne: 'Archived' },
    });

    // Paid apps in period
    const paid = await Application.countDocuments({
      assignedAgentId: agent._id,
      ...PAID_MATCH,
      updatedAt: { $gte: periodStart, $lt: periodEnd },
      isTest: { $ne: true }, isArchived: { $ne: true },
    });

    // Revenue in period
    const revenueAgg = await Payment.aggregate([
      {
        $match: {
          status: 'completed',
          type: { $in: ['upfront', 'plan', 'manualMarkPaid'] },
          createdAt: { $gte: periodStart, $lt: periodEnd },
          isTest: { $ne: true }, isArchived: { $ne: true },
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

    // Call counts from CallLog (structured) in period
    const callsAgg = await CallLog.aggregate([
      {
        $match: {
          agentId: agent._id,
          createdAt: { $gte: periodStart, $lt: periodEnd },
        },
      },
      {
        $group: {
          _id: '$outcome',
          count: { $sum: 1 },
        },
      },
    ]);

    let calls = 0;
    const callOutcomes = {};
    for (const entry of callsAgg) {
      calls += entry.count;
      callOutcomes[entry._id] = entry.count;
    }

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
        callOutcomes,
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

/**
 * Get a single agent's performance for today + current period.
 * Used for agent self-view ("My Performance" card).
 */
const getMyPerformance = async (agentId) => {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const todayEnd = new Date(todayStart);
  todayEnd.setDate(todayEnd.getDate() + 1);

  const weekStart = getWeekStart(now);
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekEnd.getDate() + 7);

  const monthStart = getMonthStart(now);
  const monthEnd = new Date(monthStart);
  monthEnd.setMonth(monthEnd.getMonth() + 1);

  const mongoose = require('mongoose');
  const agentObjId = new mongoose.Types.ObjectId(agentId);

  // Today's calls from CallLog
  const todayCalls = await CallLog.aggregate([
    { $match: { agentId: agentObjId, createdAt: { $gte: todayStart, $lt: todayEnd } } },
    { $group: { _id: '$outcome', count: { $sum: 1 } } },
  ]);

  let todayTotal = 0;
  const todayOutcomes = {};
  for (const e of todayCalls) {
    todayTotal += e.count;
    todayOutcomes[e._id] = e.count;
  }

  // Weekly calls
  const weekCalls = await CallLog.countDocuments({
    agentId: agentObjId,
    createdAt: { $gte: weekStart, $lt: weekEnd },
  });

  // Monthly calls
  const monthCalls = await CallLog.countDocuments({
    agentId: agentObjId,
    createdAt: { $gte: monthStart, $lt: monthEnd },
  });

  // Weekly target
  const weekTarget = await AgentTarget.findOne({
    agentId: agentObjId,
    period: 'weekly',
    periodStart: weekStart,
  }).lean();

  // Monthly target
  const monthTarget = await AgentTarget.findOne({
    agentId: agentObjId,
    period: 'monthly',
    periodStart: monthStart,
  }).lean();

  // Applications assigned this month
  const assignedThisMonth = await Application.countDocuments({
    assignedAgentId: agentObjId,
    createdAt: { $gte: monthStart, $lt: monthEnd },
    isTest: { $ne: true }, isArchived: { $ne: true },
    status: { $ne: 'Archived' },
  });

  // Paid this month
  const paidThisMonth = await Application.countDocuments({
    assignedAgentId: agentObjId,
    ...PAID_MATCH,
    updatedAt: { $gte: monthStart, $lt: monthEnd },
    isTest: { $ne: true }, isArchived: { $ne: true },
  });

  return {
    today: {
      calls: todayTotal,
      outcomes: todayOutcomes,
    },
    week: {
      calls: weekCalls,
      callsTarget: weekTarget?.callsTarget || 0,
      callsProgress: weekTarget?.callsTarget ? Math.round((weekCalls / weekTarget.callsTarget) * 100) : null,
    },
    month: {
      calls: monthCalls,
      callsTarget: monthTarget?.callsTarget || 0,
      assigned: assignedThisMonth,
      paid: paidThisMonth,
      conversionPct: assignedThisMonth > 0 ? Math.round((paidThisMonth / assignedThisMonth) * 100) : 0,
    },
  };
};

module.exports = {
  upsertTarget,
  bulkSetTargets,
  getTargets,
  getTargetById,
  deleteTarget,
  getPerformanceVsTargets,
  getMyPerformance,
};
