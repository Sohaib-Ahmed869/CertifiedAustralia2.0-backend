const Application = require('../models/Application');
const Payment = require('../models/Payment');
const User = require('../models/User');
const Certificate = require('../models/Certificate');
const MarketingSpend = require('../models/MarketingSpend');
const CallEvent = require('../models/CallEvent');
const buildCrud = require('./commonCrud');

const marketingSpendCrud = buildCrud(MarketingSpend, {
  populate: ['createdBy'],
});

const PAID_STATUSES = [
  'StudentIntakeForm',
  'UploadDocuments',
  'DocumentsUploaded',
  'StudentCompleted',
  'SentToRTO',
  'WaitingForVerification',
  'ReadyForRTOPayment',
  'RTOInvoiceUploaded',
  'CertificateGenerated',
  'CertificateIssued',
];

const COMPLETED_STATUSES = [
  'CertificateGenerated',
  'CertificateIssued',
];

const REVENUE_PAYMENT_TYPES = ['upfront', 'plan', 'manualMarkPaid'];

const COLOR_SOURCE_MAP = {
  red: 'Hot Lead',
  orange: 'Warm Lead',
  purple: 'Neutral Lead',
  gray: 'Cold Lead',
  yellow: 'Proceeded',
  lightblue: 'Impacted',
  pink: 'Agent',
  green: 'Completed',
  turquoise: 'New Year',
  '': 'Direct',
};

/**
 * Canonical marketing source platforms (matches ?source= query param keys).
 */
const SOURCE_PLATFORMS = [
  { key: 'tiktok',         name: 'TikTok' },
  { key: 'facebook',       name: 'Facebook' },
  { key: 'facebook_ads',   name: 'Facebook Ads' },
  { key: 'instagram',      name: 'Instagram' },
  { key: 'instagram_ads',  name: 'Instagram Ads' },
  { key: 'linkedin',       name: 'LinkedIn' },
  { key: 'google',         name: 'Google' },
  { key: 'print',          name: 'Print / QR' },
  { key: 'mainline',       name: 'Mainline' },
  { key: 'vip',            name: 'VIP Line' },
  { key: 'gabby',          name: "Gabby's Line" },
  { key: 'rsg',            name: 'Rehman Sheriff Group' },
];

/**
 * Map legacy MarketingSpend platform keys to canonical source keys.
 * Allows spend logged under either the old or new key to be attributed correctly.
 */
const SPEND_KEY_TO_SOURCE = {
  tiktok: 'tiktok',
  // Legacy meta keys → map to facebook for backwards compatibility
  meta: 'facebook',
  meta_paid: 'facebook',
  meta_ads: 'facebook_ads',
  // New separate keys
  facebook: 'facebook',
  facebook_ads: 'facebook_ads',
  instagram: 'instagram',
  instagram_ads: 'instagram_ads',
  linkedin: 'linkedin',
  google: 'google',
  print: 'print',
  print_qr: 'print',
  mainline: 'mainline',
  vip: 'vip',
  vip_line: 'vip',
  gabby: 'gabby',
  gabby_line: 'gabby',
  rsg: 'rsg',
};

/**
 * Compute a dateFrom based on the period query parameter.
 * Also supports explicit `dateFrom` query param override.
 */
function getDateFrom(period, query = {}) {
  // Explicit dateFrom takes priority over preset period
  if (query.dateFrom) {
    const d = new Date(query.dateFrom);
    return isNaN(d.getTime()) ? null : d;
  }
  if (!period || period === 'all') return null;

  const now = new Date();
  switch (period) {
    case '7d':
      return new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    case '15d':
      return new Date(now.getTime() - 15 * 24 * 60 * 60 * 1000);
    case '1m':
      return new Date(now.setMonth(now.getMonth() - 1));
    case '3m':
      return new Date(now.setMonth(now.getMonth() - 3));
    case '6m':
      return new Date(now.setMonth(now.getMonth() - 6));
    case '1y':
      return new Date(now.setFullYear(now.getFullYear() - 1));
    default:
      return null;
  }
}

/**
 * Parse optional dateTo from query.
 */
function getDateTo(query = {}) {
  if (!query.dateTo) return null;
  const d = new Date(query.dateTo);
  return isNaN(d.getTime()) ? null : d;
}

/**
 * Build a date filter for createdAt queries. Supports optional dateTo.
 */
function dateFilter(dateFrom, dateTo) {
  // Test applications/payments/certs are excluded from every metric built on this base filter.
  const base = { isTest: { $ne: true }, isArchived: { $ne: true }, status: { $ne: 'Archived' } };
  if (!dateFrom && !dateTo) return base;
  const filter = {};
  if (dateFrom) filter.$gte = dateFrom;
  if (dateTo) filter.$lte = dateTo;
  return { ...base, createdAt: filter };
}

/**
 * Get ISO week label (e.g. '2026-W24') from a Date.
 */
function getISOWeekLabel(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7));
  const week1 = new Date(d.getFullYear(), 0, 4);
  const weekNum = 1 + Math.round(((d - week1) / 86400000 - 3 + ((week1.getDay() + 6) % 7)) / 7);
  return `${d.getFullYear()}-W${String(weekNum).padStart(2, '0')}`;
}

/**
 * Get month label (e.g. 'Jan 2026') from a Date.
 */
function getMonthLabel(date) {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[date.getMonth()]} ${date.getFullYear()}`;
}

/**
 * Generate an array of the last N weeks as { week, label } objects.
 */
function getLastNWeeks(n) {
  const weeks = [];
  const now = new Date();
  for (let i = n - 1; i >= 0; i -= 1) {
    const d = new Date(now.getTime() - i * 7 * 24 * 60 * 60 * 1000);
    const label = getISOWeekLabel(d);
    weeks.push({ week: label, label });
  }
  return weeks;
}

/**
 * Generate an array of the last N months as { month, label } objects.
 */
function getLastNMonths(n) {
  const months = [];
  const now = new Date();
  for (let i = n - 1; i >= 0; i -= 1) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    months.push({ month: key, label: getMonthLabel(d) });
  }
  return months;
}

/**
 * CEO Dashboard Overview
 */
async function getOverview(query = {}) {
  const dateFrom = getDateFrom(query.period, query);
  const dateTo = getDateTo(query);
  const filter = dateFilter(dateFrom, dateTo);

  // Core stats
  const [totalLeads, paidApps, completedApps, certificateCount] = await Promise.all([
    Application.countDocuments(filter),
    Application.countDocuments({ ...filter, status: { $in: PAID_STATUSES } }),
    Application.countDocuments({ ...filter, status: { $in: COMPLETED_STATUSES } }),
    Certificate.countDocuments(filter),
  ]);

  // Revenue from completed payments
  const revenueAgg = await Payment.aggregate([
    {
      $match: {
        ...filter,
        status: 'completed',
        type: { $in: REVENUE_PAYMENT_TYPES },
      },
    },
    {
      $group: {
        _id: null,
        totalRevenue: { $sum: '$amount' },
      },
    },
  ]);
  const totalRevenue = revenueAgg[0]?.totalRevenue || 0;

  // Paid-app revenue (payments linked to paid-status applications)
  const paidRevenueAgg = await Payment.aggregate([
    {
      $match: {
        ...filter,
        status: 'completed',
        type: { $in: REVENUE_PAYMENT_TYPES },
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
    { $match: { 'app.status': { $in: PAID_STATUSES } } },
    {
      $group: {
        _id: null,
        paidRevenue: { $sum: '$amount' },
      },
    },
  ]);
  const paidRevenue = paidRevenueAgg[0]?.paidRevenue || 0;

  const avgPerApp = paidApps > 0 ? Math.round(totalRevenue / paidApps) : 0;
  const conversionRate = totalLeads > 0 ? Math.round((paidApps / totalLeads) * 10000) / 100 : 0;

  // Weekly leads vs paid (last 8 weeks)
  const weekBuckets = getLastNWeeks(8);
  const weeklyLeadsVsPaid = await Promise.all(
    weekBuckets.map(async (w) => {
      const weekStart = getWeekStartFromLabel(w.week);
      const weekEnd = new Date(weekStart.getTime() + 7 * 24 * 60 * 60 * 1000);
      const wFilter = { isTest: { $ne: true }, isArchived: { $ne: true }, status: { $ne: 'Archived' }, createdAt: { $gte: weekStart, $lt: weekEnd } };
      const [leads, paid] = await Promise.all([
        Application.countDocuments(wFilter),
        Application.countDocuments({ ...wFilter, status: { $in: PAID_STATUSES } }),
      ]);
      return { week: w.week, label: w.label, leads, paid };
    })
  );

  // Pipeline funnel
  const pipelineFunnel = {
    totalLeads,
    paid: paidApps,
    completed: completedApps,
    certified: certificateCount,
    leadToPaidPct: totalLeads > 0 ? Math.round((paidApps / totalLeads) * 10000) / 100 : 0,
    paidToCompletedPct: paidApps > 0 ? Math.round((completedApps / paidApps) * 10000) / 100 : 0,
    completedToCertifiedPct: completedApps > 0 ? Math.round((certificateCount / completedApps) * 10000) / 100 : 0,
  };

  // Revenue trend (last 12 months)
  const monthBuckets = getLastNMonths(12);
  const revenueByMonth = await Payment.aggregate([
    {
      $match: {
        isTest: { $ne: true }, isArchived: { $ne: true },
        status: 'completed',
        type: { $in: REVENUE_PAYMENT_TYPES },
        createdAt: { $gte: new Date(new Date().getFullYear(), new Date().getMonth() - 11, 1) },
      },
    },
    {
      $group: {
        _id: {
          year: { $year: '$createdAt' },
          month: { $month: '$createdAt' },
        },
        revenue: { $sum: '$amount' },
      },
    },
  ]);
  const revenueMap = {};
  revenueByMonth.forEach((r) => {
    const key = `${r._id.year}-${String(r._id.month).padStart(2, '0')}`;
    revenueMap[key] = r.revenue;
  });
  const revenueTrend = monthBuckets.map((m) => ({
    month: m.month,
    label: m.label,
    revenue: revenueMap[m.month] || 0,
  }));

  // Lead sources (grouped by color)
  const leadSourceAgg = await Application.aggregate([
    { $match: filter },
    {
      $group: {
        _id: '$color',
        count: { $sum: 1 },
      },
    },
  ]);
  // Get revenue per source via payments
  const sourceRevAgg = await Payment.aggregate([
    {
      $match: {
        ...filter,
        status: 'completed',
        type: { $in: REVENUE_PAYMENT_TYPES },
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
    {
      $group: {
        _id: '$app.color',
        revenue: { $sum: '$amount' },
      },
    },
  ]);
  const sourceRevMap = {};
  sourceRevAgg.forEach((s) => {
    sourceRevMap[s._id || ''] = s.revenue;
  });
  const leadSources = leadSourceAgg.map((s) => ({
    source: s._id || '',
    label: COLOR_SOURCE_MAP[s._id || ''] || 'Direct',
    count: s.count,
    revenue: sourceRevMap[s._id || ''] || 0,
  }));

  // Top agents by revenue
  const topAgentsAgg = await Payment.aggregate([
    {
      $match: {
        ...filter,
        status: 'completed',
        type: { $in: REVENUE_PAYMENT_TYPES },
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
    { $match: { 'app.assignedAgentId': { $ne: null } } },
    {
      $group: {
        _id: '$app.assignedAgentId',
        revenue: { $sum: '$amount' },
        paidCount: { $addToSet: '$applicationId' },
      },
    },
    { $sort: { revenue: -1 } },
    { $limit: 10 },
    {
      $lookup: {
        from: 'users',
        localField: '_id',
        foreignField: '_id',
        as: 'agent',
      },
    },
    { $unwind: '$agent' },
    {
      $lookup: {
        from: 'applications',
        let: { agentId: '$_id' },
        pipeline: [
          { $match: { $expr: { $eq: ['$assignedAgentId', '$$agentId'] }, ...filter } },
          { $count: 'total' },
        ],
        as: 'totalAssigned',
      },
    },
    {
      $project: {
        agentName: { $concat: ['$agent.firstName', ' ', '$agent.lastName'] },
        revenue: 1,
        paidCount: { $size: '$paidCount' },
        totalAssigned: { $ifNull: [{ $arrayElemAt: ['$totalAssigned.total', 0] }, 0] },
      },
    },
    {
      $addFields: {
        conversion: {
          $cond: [
            { $gt: ['$totalAssigned', 0] },
            { $round: [{ $multiply: [{ $divide: ['$paidCount', '$totalAssigned'] }, 100] }, 1] },
            0,
          ],
        },
      },
    },
  ]);

  // Weekly paid revenue (last 8 weeks)
  const weeklyPaidRevenue = await Promise.all(
    weekBuckets.map(async (w) => {
      const weekStart = getWeekStartFromLabel(w.week);
      const weekEnd = new Date(weekStart.getTime() + 7 * 24 * 60 * 60 * 1000);
      const agg = await Payment.aggregate([
        {
          $match: {
            isTest: { $ne: true }, isArchived: { $ne: true },
            status: 'completed',
            type: { $in: REVENUE_PAYMENT_TYPES },
            createdAt: { $gte: weekStart, $lt: weekEnd },
          },
        },
        { $group: { _id: null, revenue: { $sum: '$amount' } } },
      ]);
      return { week: w.week, label: w.label, revenue: agg[0]?.revenue || 0 };
    })
  );

  // Funnel trend (last 5 weeks): New Leads + Paid Apps + Scorecard calls, to
  // visualise how top-of-funnel calling drives leads → paid conversions.
  // CallEvent.date is an AEST 'YYYY-MM-DD' string, so we match on a date-string
  // range; calls = outbound only (mirrors the Call Scorecard's "calls" metric).
  const toDateStr = (d) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const funnelWeeks = getLastNWeeks(5);
  const funnelTrend = await Promise.all(
    funnelWeeks.map(async (w) => {
      const weekStart = getWeekStartFromLabel(w.week);
      const weekEnd = new Date(weekStart.getTime() + 7 * 24 * 60 * 60 * 1000);
      const wFilter = { isTest: { $ne: true }, isArchived: { $ne: true }, status: { $ne: 'Archived' }, createdAt: { $gte: weekStart, $lt: weekEnd } };
      const startStr = toDateStr(weekStart);
      const endStr = toDateStr(new Date(weekEnd.getTime() - 24 * 60 * 60 * 1000)); // inclusive last day
      const [leads, paid, calls] = await Promise.all([
        Application.countDocuments(wFilter),
        Application.countDocuments({ ...wFilter, status: { $in: PAID_STATUSES } }),
        CallEvent.countDocuments({ date: { $gte: startStr, $lte: endStr }, direction: { $ne: 'incoming' } }),
      ]);
      return { week: w.week, label: w.label, leads, paid, calls };
    })
  );

  return {
    stats: {
      totalLeads,
      paidApps,
      paidRevenue,
      completedApps,
      certificateCount,
      totalRevenue,
      avgPerApp,
      conversionRate,
    },
    weeklyLeadsVsPaid,
    funnelTrend,
    pipelineFunnel,
    revenueTrend,
    leadSources,
    topAgentsByRevenue: topAgentsAgg,
    weeklyPaidRevenue,
  };
}

/**
 * CEO Dashboard Leads
 */
async function getLeads(query = {}) {
  const dateFrom = getDateFrom(query.period, query);
  const dateTo = getDateTo(query);
  const filter = dateFilter(dateFrom, dateTo);

  const [totalLeads, paidCount] = await Promise.all([
    Application.countDocuments(filter),
    Application.countDocuments({ ...filter, status: { $in: PAID_STATUSES } }),
  ]);

  const revenueAgg = await Payment.aggregate([
    {
      $match: {
        ...filter,
        status: 'completed',
        type: { $in: REVENUE_PAYMENT_TYPES },
      },
    },
    { $group: { _id: null, revenue: { $sum: '$amount' } } },
  ]);
  const revenue = revenueAgg[0]?.revenue || 0;
  const conversionPct = totalLeads > 0 ? Math.round((paidCount / totalLeads) * 10000) / 100 : 0;
  const avgPerApp = paidCount > 0 ? Math.round(revenue / paidCount) : 0;

  // New leads per week (last 8 weeks)
  const weekBuckets = getLastNWeeks(8);
  const newLeadsPerWeek = await Promise.all(
    weekBuckets.map(async (w) => {
      const weekStart = getWeekStartFromLabel(w.week);
      const weekEnd = new Date(weekStart.getTime() + 7 * 24 * 60 * 60 * 1000);
      const count = await Application.countDocuments({
        isTest: { $ne: true }, isArchived: { $ne: true },
        status: { $ne: 'Archived' },
        createdAt: { $gte: weekStart, $lt: weekEnd },
      });
      return { week: w.week, label: w.label, count };
    })
  );

  // Lead source breakdown (by color)
  const sourceAgg = await Application.aggregate([
    { $match: filter },
    { $group: { _id: '$color', count: { $sum: 1 } } },
  ]);
  const sourceRevAgg = await Payment.aggregate([
    {
      $match: {
        ...filter,
        status: 'completed',
        type: { $in: REVENUE_PAYMENT_TYPES },
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
    { $group: { _id: '$app.color', revenue: { $sum: '$amount' } } },
  ]);
  const sourceRevMap = {};
  sourceRevAgg.forEach((s) => {
    sourceRevMap[s._id || ''] = s.revenue;
  });
  const leadSourceBreakdown = sourceAgg.map((s) => ({
    source: s._id || '',
    label: COLOR_SOURCE_MAP[s._id || ''] || 'Direct',
    count: s.count,
    revenue: sourceRevMap[s._id || ''] || 0,
  }));

  // Leads vs paid weekly
  const leadsVsPaidWeekly = await Promise.all(
    weekBuckets.map(async (w) => {
      const weekStart = getWeekStartFromLabel(w.week);
      const weekEnd = new Date(weekStart.getTime() + 7 * 24 * 60 * 60 * 1000);
      const wFilter = { isTest: { $ne: true }, isArchived: { $ne: true }, status: { $ne: 'Archived' }, createdAt: { $gte: weekStart, $lt: weekEnd } };
      const [leads, paid] = await Promise.all([
        Application.countDocuments(wFilter),
        Application.countDocuments({ ...wFilter, status: { $in: PAID_STATUSES } }),
      ]);
      return { week: w.week, label: w.label, leads, paid };
    })
  );

  return {
    stats: { totalLeads, paidCount, conversionPct, revenue, avgPerApp },
    newLeadsPerWeek,
    leadSourceBreakdown,
    leadsVsPaidWeekly,
  };
}

/**
 * CEO Dashboard Call Attempts
 */
async function getCallAttempts(query = {}) {
  const dateFrom = getDateFrom(query.period, query);
  const dateTo = getDateTo(query);
  const filter = dateFilter(dateFrom, dateTo);

  // Aggregate call stats
  const callAgg = await Application.aggregate([
    { $match: { ...filter, assignedAgentId: { $ne: null } } },
    {
      $group: {
        _id: null,
        totalAttempts: { $sum: '$contactAttempts' },
        totalIncoming: { $sum: '$incomingCalls' },
      },
    },
  ]);
  const totalAttempts = callAgg[0]?.totalAttempts || 0;
  const totalIncoming = callAgg[0]?.totalIncoming || 0;

  // Contact status distribution
  const contactStatusAgg = await Application.aggregate([
    { $match: filter },
    {
      $group: {
        _id: '$contactStatus',
        count: { $sum: 1 },
      },
    },
  ]);
  const contacted = contactStatusAgg
    .filter((s) => s._id && s._id !== '' && s._id !== 'not_contacted')
    .reduce((sum, s) => sum + s.count, 0);
  const notContacted = contactStatusAgg
    .filter((s) => !s._id || s._id === '' || s._id === 'not_contacted')
    .reduce((sum, s) => sum + s.count, 0);
  const contactStatusDistribution = contactStatusAgg.map((s) => ({
    status: s._id || 'none',
    count: s.count,
  }));

  // Calls by agent
  const callsByAgentAgg = await Application.aggregate([
    { $match: { ...filter, assignedAgentId: { $ne: null } } },
    {
      $group: {
        _id: '$assignedAgentId',
        attempts: { $sum: '$contactAttempts' },
        incoming: { $sum: '$incomingCalls' },
      },
    },
    {
      $lookup: {
        from: 'users',
        localField: '_id',
        foreignField: '_id',
        as: 'agent',
      },
    },
    { $unwind: '$agent' },
    {
      $project: {
        agentName: { $concat: ['$agent.firstName', ' ', '$agent.lastName'] },
        attempts: 1,
        incoming: 1,
      },
    },
    { $sort: { attempts: -1 } },
  ]);

  // Application-level call details (top 150 by attempts)
  const applicationCallDetails = await Application.aggregate([
    { $match: { ...filter, contactAttempts: { $gt: 0 } } },
    { $sort: { contactAttempts: -1 } },
    { $limit: 150 },
    {
      $lookup: {
        from: 'users',
        localField: 'assignedAgentId',
        foreignField: '_id',
        as: 'agent',
      },
    },
    {
      $project: {
        applicationId: 1,
        agentName: {
          $cond: [
            { $gt: [{ $size: '$agent' }, 0] },
            { $concat: [{ $arrayElemAt: ['$agent.firstName', 0] }, ' ', { $arrayElemAt: ['$agent.lastName', 0] }] },
            'Unassigned',
          ],
        },
        attempts: '$contactAttempts',
        incoming: '$incomingCalls',
        status: '$contactStatus',
      },
    },
  ]);

  return {
    stats: { totalAttempts, totalIncoming, contacted, notContacted },
    callsByAgent: callsByAgentAgg,
    contactStatusDistribution,
    applicationCallDetails,
  };
}

/**
 * CEO Dashboard Agent Performance
 */
async function getAgentPerformance(query = {}) {
  const dateFrom = getDateFrom(query.period, query);
  const dateTo = getDateTo(query);
  const filter = dateFilter(dateFrom, dateTo);

  // All agents (anyone flagged as a sales agent, regardless of role)
  const agents = await User.find({ isSalesAgent: true, status: 'active' }).select('firstName lastName').lean();

  // Per-agent stats
  const details = await Promise.all(
    agents.map(async (agent) => {
      const agentFilter = { ...filter, assignedAgentId: agent._id };
      const [assigned, paid, completed] = await Promise.all([
        Application.countDocuments(agentFilter),
        Application.countDocuments({ ...agentFilter, status: { $in: PAID_STATUSES } }),
        Application.countDocuments({ ...agentFilter, status: { $in: COMPLETED_STATUSES } }),
      ]);

      // Revenue for this agent
      const revAgg = await Payment.aggregate([
        {
          $match: {
            ...filter,
            status: 'completed',
            type: { $in: REVENUE_PAYMENT_TYPES },
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
        { $group: { _id: null, revenue: { $sum: '$amount' } } },
      ]);
      const revenue = revAgg[0]?.revenue || 0;

      // Call attempts
      const callAgg = await Application.aggregate([
        { $match: agentFilter },
        { $group: { _id: null, calls: { $sum: '$contactAttempts' } } },
      ]);
      const calls = callAgg[0]?.calls || 0;

      const conversionPct = assigned > 0 ? Math.round((paid / assigned) * 10000) / 100 : 0;

      return {
        agentName: `${agent.firstName} ${agent.lastName}`,
        assigned,
        paid,
        completed,
        revenue,
        conversionPct,
        calls,
      };
    })
  );

  const totalAssigned = details.reduce((sum, d) => sum + d.assigned, 0);
  const totalPaid = details.reduce((sum, d) => sum + d.paid, 0);
  const totalRevenue = details.reduce((sum, d) => sum + d.revenue, 0);
  const totalCalls = details.reduce((sum, d) => sum + d.calls, 0);
  const agentCount = agents.length;
  const conversionPct = totalAssigned > 0 ? Math.round((totalPaid / totalAssigned) * 10000) / 100 : 0;

  // Revenue by agent (for chart)
  const revenueByAgent = details
    .map((d) => ({ agentName: d.agentName, revenue: d.revenue }))
    .sort((a, b) => b.revenue - a.revenue);

  // Pipeline by agent (for stacked chart)
  const pipelineByAgent = details.map((d) => ({
    agentName: d.agentName,
    assigned: d.assigned,
    paid: d.paid,
    completed: d.completed,
  }));

  return {
    stats: { totalAssigned, agentCount, totalPaid, conversionPct, totalRevenue, totalCalls },
    revenueByAgent,
    pipelineByAgent,
    details,
  };
}

/**
 * CEO Dashboard Marketing
 *
 * Aggregates lead, paid, and revenue data by the student's actual
 * marketing source (Student.sourceAttribution.source) rather than the
 * Application.color field which is an unrelated lead-categorization flag.
 */
async function getMarketing(query = {}) {
  const dateFrom = getDateFrom(query.period, query);
  const dateTo = getDateTo(query);
  const appFilter = dateFilter(dateFrom, dateTo);
  const spendFilter = {};
  if (dateFrom || dateTo) {
    spendFilter.weekOf = {};
    if (dateFrom) spendFilter.weekOf.$gte = dateFrom;
    if (dateTo) spendFilter.weekOf.$lte = dateTo;
  }

  // ── 1. Aggregate MarketingSpend by platform, then normalise to source keys ──
  const spendAgg = await MarketingSpend.aggregate([
    { $match: spendFilter },
    {
      $group: {
        _id: '$platform',
        spend: { $sum: '$amount' },
      },
    },
  ]);

  // Roll up spend into canonical source keys using SPEND_KEY_TO_SOURCE
  const spendBySource = {};
  spendAgg.forEach((s) => {
    const sourceKey = SPEND_KEY_TO_SOURCE[s._id] || s._id;
    spendBySource[sourceKey] = (spendBySource[sourceKey] || 0) + s.spend;
  });
  const totalSpend = Object.values(spendBySource).reduce((sum, v) => sum + v, 0);

  // ── 2. Leads & paid count per source ──
  // First try Application.sourceAttribution.source (new field), fall back to Student lookup for legacy data
  const sourceKeys = SOURCE_PLATFORMS.map((p) => p.key);
  // Include unattributed "Direct" leads alongside the paid platforms.
  const leadSourceKeys = [...sourceKeys, 'direct'];

  const leadsAgg = await Application.aggregate([
    { $match: appFilter },
    {
      $lookup: {
        from: 'users',
        localField: 'studentId',
        foreignField: '_id',
        as: 'student',
      },
    },
    { $unwind: '$student' },
    {
      $addFields: {
        marketingSource: {
          $ifNull: ['$sourceAttribution.source', { $ifNull: ['$student.sourceAttribution.source', 'direct'] }],
        },
      },
    },
    { $match: { marketingSource: { $in: leadSourceKeys } } },
    {
      $group: {
        _id: '$marketingSource',
        leads: { $sum: 1 },
        paid: {
          $sum: { $cond: [{ $in: ['$status', PAID_STATUSES] }, 1, 0] },
        },
      },
    },
  ]);

  const leadsMap = {};
  const paidMap = {};
  leadsAgg.forEach((r) => {
    leadsMap[r._id] = r.leads;
    paidMap[r._id] = r.paid;
  });

  // ── 3. Revenue per source (Payment → Application → Student) ──
  const revenueAgg = await Payment.aggregate([
    {
      $match: {
        ...appFilter,
        status: 'completed',
        type: { $in: REVENUE_PAYMENT_TYPES },
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
    {
      $lookup: {
        from: 'users',
        localField: 'app.studentId',
        foreignField: '_id',
        as: 'student',
      },
    },
    { $unwind: '$student' },
    {
      $addFields: {
        marketingSource: {
          $ifNull: ['$app.sourceAttribution.source', { $ifNull: ['$student.sourceAttribution.source', 'direct'] }],
        },
      },
    },
    { $match: { marketingSource: { $in: leadSourceKeys } } },
    {
      $group: {
        _id: '$marketingSource',
        revenue: { $sum: '$amount' },
      },
    },
  ]);

  const revenueMap = {};
  revenueAgg.forEach((r) => {
    revenueMap[r._id] = r.revenue;
  });

  // ── 4. Build per-platform cards ──
  // "From ads" totals exclude Direct (which has no ad spend).
  const totalLeadsFromAds = sourceKeys.reduce((sum, k) => sum + (leadsMap[k] || 0), 0);
  const totalRevenueFromAds = sourceKeys.reduce((sum, k) => sum + (revenueMap[k] || 0), 0);
  const overallROAS = totalSpend > 0 ? Math.round((totalRevenueFromAds / totalSpend) * 100) / 100 : 0;

  const platforms = SOURCE_PLATFORMS.map((p) => {
    const spend = spendBySource[p.key] || 0;
    const leads = leadsMap[p.key] || 0;
    const paid = paidMap[p.key] || 0;
    const revenue = revenueMap[p.key] || 0;
    const cpa = paid > 0 ? Math.round(spend / paid) : 0;
    const roas = spend > 0 ? Math.round((revenue / spend) * 100) / 100 : 0;
    return { ...p, spend, leads, paid, revenue, cpa, roas };
  });

  // CPA breakdown with additional CPA-per-lead
  const cpaBreakdown = platforms.map((pc) => ({
    ...pc,
    platform: pc.key,
    label: pc.name,
    cpaLead: pc.leads > 0 ? Math.round(pc.spend / pc.leads) : 0,
    cpaConverted: pc.cpa,
  }));

  // platformCards for backward compatibility with frontend
  const platformCards = platforms.map((pc) => ({
    platform: pc.key,
    label: pc.name,
    spend: pc.spend,
    leads: pc.leads,
    paid: pc.paid,
    revenue: pc.revenue,
    cpa: pc.cpa,
  }));

  // ── 5. Direct (unattributed) leads — shown alongside the paid platforms ──
  const direct = {
    platform: 'direct',
    label: 'Direct',
    spend: 0,
    leads: leadsMap.direct || 0,
    paid: paidMap.direct || 0,
    revenue: revenueMap.direct || 0,
    cpa: 0,
  };
  platformCards.push(direct);
  cpaBreakdown.push({
    ...direct,
    key: 'direct',
    name: 'Direct',
    cpaLead: 0,
    cpaConverted: 0,
    roas: 0,
    color: '#64748b',
  });

  // ── 6. Per-application details (ad-sourced + direct) with spend attribution ──
  // CPA Share per app = that source's spend-per-lead; per-app ROAS = revenue / CPA Share.
  const round2 = (n) => Math.round((n || 0) * 100) / 100;
  const spendPerLead = {};
  leadSourceKeys.forEach((k) => {
    spendPerLead[k] = leadsMap[k] > 0 ? (spendBySource[k] || 0) / leadsMap[k] : 0;
  });

  const appDetailAgg = await Application.aggregate([
    { $match: appFilter },
    { $lookup: { from: 'users', localField: 'studentId', foreignField: '_id', as: 'student' } },
    { $unwind: { path: '$student', preserveNullAndEmptyArrays: true } },
    { $lookup: { from: 'users', localField: 'assignedAgentId', foreignField: '_id', as: 'agent' } },
    { $unwind: { path: '$agent', preserveNullAndEmptyArrays: true } },
    { $lookup: { from: 'qualifications', localField: 'qualificationId', foreignField: '_id', as: 'qual' } },
    { $unwind: { path: '$qual', preserveNullAndEmptyArrays: true } },
    {
      $lookup: {
        from: 'payments',
        let: { appId: '$_id' },
        pipeline: [
          { $match: { $expr: { $and: [
            { $eq: ['$applicationId', '$$appId'] },
            { $eq: ['$status', 'completed'] },
            { $in: ['$type', REVENUE_PAYMENT_TYPES] },
          ] } } },
          { $group: { _id: null, total: { $sum: '$amount' } } },
        ],
        as: 'pay',
      },
    },
    {
      $addFields: {
        marketingSource: { $ifNull: ['$sourceAttribution.source', { $ifNull: ['$student.sourceAttribution.source', 'direct'] }] },
        collected: { $ifNull: [{ $arrayElemAt: ['$pay.total', 0] }, 0] },
        discountTotal: { $sum: { $ifNull: ['$discounts.amount', []] } },
      },
    },
    { $match: { marketingSource: { $in: leadSourceKeys } } },
    {
      $project: {
        applicationId: 1, status: 1, createdAt: 1, marketingSource: 1, collected: 1, discountTotal: 1,
        price: { $ifNull: ['$qual.caPrice', 0] },
        studentName: { $trim: { input: { $concat: [{ $ifNull: ['$student.firstName', ''] }, ' ', { $ifNull: ['$student.lastName', ''] }] } } },
        agentName: { $trim: { input: { $concat: [{ $ifNull: ['$agent.firstName', ''] }, ' ', { $ifNull: ['$agent.lastName', ''] }] } } },
      },
    },
  ]);

  const applicationDetails = appDetailAgg.map((a) => {
    const cpaShare = Math.round(spendPerLead[a.marketingSource] || 0);
    const revenue = round2(a.collected);
    return {
      applicationId: a.applicationId || String(a._id),
      studentName: a.studentName || 'Unknown',
      source: a.marketingSource,
      date: a.createdAt,
      agent: a.agentName || '—',
      paid: PAID_STATUSES.includes(a.status),
      price: round2(a.price),
      discount: round2(a.discountTotal),
      revenue,
      cpaShare,
      roas: cpaShare > 0 ? round2(revenue / cpaShare) : 0,
    };
  }).sort((x, y) => y.revenue - x.revenue);

  return {
    stats: {
      totalSpend,
      totalLeadsFromAds,
      totalRevenueFromAds,
      overallROAS,
      directLeads: direct.leads,
      directPaid: direct.paid,
      directRevenue: direct.revenue,
      // Keep legacy field names so old frontend code doesn't break
      leadsFromAds: totalLeadsFromAds,
      revenueFromAds: totalRevenueFromAds,
    },
    platformCards,
    cpaBreakdown,
    applicationDetails,
  };
}

/**
 * Helper: Get week start date from ISO week label (e.g. '2026-W24')
 */
function getWeekStartFromLabel(weekLabel) {
  const [year, weekNum] = weekLabel.split('-W').map(Number);
  const jan4 = new Date(year, 0, 4);
  const dayOfWeek = jan4.getDay() || 7;
  const monday = new Date(jan4);
  monday.setDate(jan4.getDate() - dayOfWeek + 1 + (weekNum - 1) * 7);
  monday.setHours(0, 0, 0, 0);
  return monday;
}

/** Monday Date → ISO week key like '2026-W29'. */
function mondayToWeekKey(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

// Editable ad-spend platforms (canonical keys — all present in the MarketingSpend enum).
const SPEND_EDIT_PLATFORMS = SOURCE_PLATFORMS.map((p) => p.key);

/**
 * Weekly ad-spend history — one row per ISO week (gaps filled), with per-platform
 * amounts + notes rolled up to canonical source keys. Powers the Ad Spend cockpit.
 */
async function getMarketingSpendHistory({ weeks = 12 } = {}) {
  const n = Math.min(Math.max(Number(weeks) || 12, 1), 52);

  // Monday of the current week
  const now = new Date();
  const day = now.getDay() || 7;
  const currentMonday = new Date(now);
  currentMonday.setDate(now.getDate() - day + 1);
  currentMonday.setHours(0, 0, 0, 0);
  const earliest = new Date(currentMonday);
  earliest.setDate(currentMonday.getDate() - (n - 1) * 7);

  const docs = await MarketingSpend.find({ weekOf: { $gte: earliest } })
    .sort({ weekOf: 1, updatedAt: 1 })
    .lean();

  const weekMap = {};
  docs.forEach((doc) => {
    const monday = new Date(doc.weekOf);
    monday.setHours(0, 0, 0, 0);
    const weekKey = mondayToWeekKey(monday);
    if (!weekMap[weekKey]) weekMap[weekKey] = { weekKey, weekOf: monday, total: 0, platforms: {} };
    const canonical = SPEND_KEY_TO_SOURCE[doc.platform] || doc.platform;
    const bucket = weekMap[weekKey].platforms[canonical] || { amount: 0, notes: '' };
    bucket.amount += doc.amount || 0;
    if (doc.notes) bucket.notes = doc.notes; // docs sorted asc by updatedAt → keep latest
    weekMap[weekKey].platforms[canonical] = bucket;
    weekMap[weekKey].total += doc.amount || 0;
  });

  // Fill every week in the window so the trend chart is continuous.
  const weeksArr = [];
  for (let i = n - 1; i >= 0; i -= 1) {
    const m = new Date(currentMonday);
    m.setDate(currentMonday.getDate() - i * 7);
    const wk = mondayToWeekKey(m);
    weeksArr.push(weekMap[wk] || { weekKey: wk, weekOf: m, total: 0, platforms: {} });
  }

  return { weeks: weeksArr, platforms: SPEND_EDIT_PLATFORMS };
}

/**
 * Upsert a single (week, platform) ad-spend cell with optional notes.
 * amount <= 0 clears the cell. Guarantees one record per (week, platform).
 */
async function upsertMarketingSpend({ weekKey, platform, amount, notes, userId }) {
  const monday = getWeekStartFromLabel(weekKey);
  const amt = Number(amount) || 0;
  if (amt <= 0) {
    await MarketingSpend.deleteMany({ platform, weekOf: monday });
    return { deleted: true, platform, weekKey };
  }
  const doc = await MarketingSpend.findOneAndUpdate(
    { platform, weekOf: monday },
    { $set: { amount: amt, notes: notes || '', updatedAt: new Date() }, $setOnInsert: { createdBy: userId } },
    { new: true, upsert: true, runValidators: true },
  );
  return { item: doc };
}

/** Delete an ad-spend cell for a (week, platform). */
async function deleteMarketingSpend({ weekKey, platform }) {
  const monday = getWeekStartFromLabel(weekKey);
  const res = await MarketingSpend.deleteMany({ platform, weekOf: monday });
  return { deleted: res.deletedCount };
}

const Qualification = require('../models/Qualification');

/**
 * Supplier Liability / RTO Payables — CEO Dashboard
 * Shows which RTOs are owed money, from which applications, with forecasting.
 */
async function getSupplierLiability(query = {}) {
  const dateFrom = getDateFrom(query.period, query);
  const dateTo = getDateTo(query);
  const now = new Date();

  // 1. Applications with an assigned RTO (these generate RTO liabilities)
  const appFilter = { isTest: { $ne: true }, isArchived: { $ne: true }, status: { $ne: 'Archived' }, assignedRTOId: { $exists: true, $ne: null } };
  if (dateFrom || dateTo) {
    appFilter.createdAt = {};
    if (dateFrom) appFilter.createdAt.$gte = dateFrom;
    if (dateTo) appFilter.createdAt.$lte = dateTo;
  }

  const applications = await Application.find(appFilter)
    .populate('assignedRTOId', 'firstName lastName email')
    .populate('qualificationId', 'name caPrice rtoCosts')
    .populate('studentId', 'firstName lastName')
    .lean();

  // 2. Existing RTO payments (type rtoPayable or rtoPayment with status completed)
  const paidPayments = await Payment.find({
    isTest: { $ne: true }, isArchived: { $ne: true },
    type: { $in: ['rtoPayable', 'rtoPayment'] },
    status: 'completed',
  }).lean();
  const paidByApp = {};
  for (const p of paidPayments) {
    const appId = String(p.applicationId);
    paidByApp[appId] = (paidByApp[appId] || 0) + p.amount;
  }

  // 3. Build per-application liability items
  const liabilityItems = [];
  const rtoSummary = {}; // rtoId → { name, totalOwed, totalPaid, applications[] }

  for (const app of applications) {
    const rto = app.assignedRTOId;
    if (!rto) continue;

    const qual = app.qualificationId;
    if (!qual) continue;

    // Find RTO cost for this qualification
    const rtoEntry = qual.rtoCosts?.find(
      (r) => r.rtoId && String(r.rtoId) === String(rto._id)
    ) || qual.rtoCosts?.[0];
    const rtoCost = rtoEntry?.rtoCost || 0;
    if (rtoCost === 0) continue;

    const appId = String(app._id);
    const amountPaid = paidByApp[appId] || 0;
    const amountOwed = Math.max(0, rtoCost - amountPaid);

    // Determine liability status
    let status = 'forecasted';
    if (amountPaid >= rtoCost) {
      status = 'paid';
    } else if (app.rtoCompletionDeadline && now > new Date(app.rtoCompletionDeadline)) {
      status = 'overdue';
    } else if (app.studentCompletionDate) {
      status = 'pending';
    }

    // Days until/since deadline
    let daysRemaining = null;
    if (app.rtoCompletionDeadline) {
      daysRemaining = Math.ceil((new Date(app.rtoCompletionDeadline) - now) / (1000 * 60 * 60 * 24));
    }

    const item = {
      applicationId: app.applicationId,
      applicationObjId: app._id,
      studentName: app.studentId ? `${app.studentId.firstName} ${app.studentId.lastName}` : 'Unknown',
      qualificationName: qual.name || 'Unknown',
      rtoId: rto._id,
      rtoName: `${rto.firstName} ${rto.lastName}`,
      rtoCost,
      amountPaid,
      amountOwed,
      status,
      daysRemaining,
      studentCompletionDate: app.studentCompletionDate,
      rtoCompletionDeadline: app.rtoCompletionDeadline,
    };
    liabilityItems.push(item);

    // Aggregate per-RTO
    const rtoKey = String(rto._id);
    if (!rtoSummary[rtoKey]) {
      rtoSummary[rtoKey] = {
        rtoId: rto._id,
        rtoName: `${rto.firstName} ${rto.lastName}`,
        rtoEmail: rto.email,
        totalOwed: 0,
        totalPaid: 0,
        applicationCount: 0,
        overdueCount: 0,
        pendingCount: 0,
        forecastedCount: 0,
      };
    }
    rtoSummary[rtoKey].totalOwed += amountOwed;
    rtoSummary[rtoKey].totalPaid += amountPaid;
    rtoSummary[rtoKey].applicationCount += 1;
    if (status === 'overdue') rtoSummary[rtoKey].overdueCount += 1;
    if (status === 'pending') rtoSummary[rtoKey].pendingCount += 1;
    if (status === 'forecasted') rtoSummary[rtoKey].forecastedCount += 1;
  }

  // 4. Compute totals
  const totalLiability = liabilityItems.reduce((s, i) => s + i.rtoCost, 0);
  const totalPaid = liabilityItems.reduce((s, i) => s + i.amountPaid, 0);
  const totalOwed = liabilityItems.reduce((s, i) => s + i.amountOwed, 0);
  const overdueItems = liabilityItems.filter((i) => i.status === 'overdue');
  const pendingItems = liabilityItems.filter((i) => i.status === 'pending');
  const forecastedItems = liabilityItems.filter((i) => i.status === 'forecasted');

  // This week's liability (items with deadline this week)
  const weekStart = new Date(now);
  weekStart.setDate(weekStart.getDate() - weekStart.getDay() + 1);
  weekStart.setHours(0, 0, 0, 0);
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekEnd.getDate() + 6);
  weekEnd.setHours(23, 59, 59, 999);
  const thisWeekItems = liabilityItems.filter(
    (i) => i.rtoCompletionDeadline &&
      new Date(i.rtoCompletionDeadline) >= weekStart &&
      new Date(i.rtoCompletionDeadline) <= weekEnd
  );
  const thisWeekLiability = thisWeekItems.reduce((s, i) => s + i.amountOwed, 0);

  // Revenue in period for net cash calculation
  const revFilter = { isTest: { $ne: true }, isArchived: { $ne: true }, status: 'completed', type: { $in: REVENUE_PAYMENT_TYPES } };
  if (dateFrom) revFilter.createdAt = { $gte: dateFrom };
  const revAgg = await Payment.aggregate([
    { $match: revFilter },
    { $group: { _id: null, total: { $sum: '$amount' } } },
  ]);
  const totalRevenue = revAgg[0]?.total || 0;
  const netCashAfterLiabilities = totalRevenue - totalOwed;

  return {
    summary: {
      totalLiability,
      totalPaid,
      totalOwed,
      thisWeekLiability,
      thisWeekCount: thisWeekItems.length,
      overdueTotal: overdueItems.reduce((s, i) => s + i.amountOwed, 0),
      overdueCount: overdueItems.length,
      pendingTotal: pendingItems.reduce((s, i) => s + i.amountOwed, 0),
      pendingCount: pendingItems.length,
      forecastedTotal: forecastedItems.reduce((s, i) => s + i.amountOwed, 0),
      forecastedCount: forecastedItems.length,
      totalRevenue,
      netCashAfterLiabilities,
    },
    rtoBreakdown: Object.values(rtoSummary).sort((a, b) => b.totalOwed - a.totalOwed),
    items: liabilityItems.sort((a, b) => {
      // Overdue first, then pending, then forecasted, then paid
      const order = { overdue: 0, pending: 1, forecasted: 2, paid: 3 };
      return (order[a.status] ?? 4) - (order[b.status] ?? 4);
    }),
  };
}

/**
 * Export marketing data as flat array for CSV.
 */
async function exportMarketingData(query = {}) {
  const data = await getMarketing(query);
  return (data.cpaBreakdown || []).map((p) => ({
    platform: p.label || p.platform,
    spend: p.spend || 0,
    leads: p.leads || 0,
    conversions: p.paid || 0,
    revenue: p.revenue || 0,
    cpaPerLead: p.cpaLead || 0,
    cpaPerConversion: p.cpaConverted || 0,
    roas: p.roas || 0,
  }));
}

/**
 * Weekly Scorecard — EOS-style metrics for Monday review
 */
async function getWeeklyScorecard(query = {}) {
  const ScorecardTarget = require('../models/ScorecardTarget');

  const DEFAULT_TARGETS = {
    revenue: 60000, leads: 75, appsPaid: 10, appsCompleted: 10,
    certsReleased: 10, callsPerAgent: 300, conversionPerAgent: 75, expenses: 35000,
  };

  // Determine period boundaries — supports weekly (default) and monthly.
  // Variables keep the `week*` names so the downstream aggregation is unchanged.
  const period = query.period === 'month' ? 'month' : 'week';
  let weekStart, weekEnd, prevStart, prevEnd;
  if (period === 'month') {
    let y;
    let m;
    if (query.monthKey && /^\d{4}-\d{2}$/.test(query.monthKey)) {
      [y, m] = query.monthKey.split('-').map(Number);
    } else {
      const now = new Date();
      y = now.getFullYear();
      m = now.getMonth() + 1;
    }
    weekStart = new Date(y, m - 1, 1);
    weekStart.setHours(0, 0, 0, 0);
    weekEnd = new Date(y, m, 1); // first day of next month
    prevStart = new Date(y, m - 2, 1);
    prevEnd = new Date(weekStart);
  } else {
    if (query.weekKey) {
      weekStart = getWeekStartFromLabel(query.weekKey);
    } else {
      const now = new Date();
      weekStart = new Date(now);
      weekStart.setDate(weekStart.getDate() - ((weekStart.getDay() + 6) % 7));
      weekStart.setHours(0, 0, 0, 0);
    }
    weekEnd = new Date(weekStart.getTime() + 7 * 86400000);
    prevStart = new Date(weekStart.getTime() - 7 * 86400000);
    prevEnd = new Date(weekStart);
  }

  // Weeks spanned by the period — used to scale weekly targets for a month view.
  const weekEquiv = Math.max(1, Math.round((weekEnd.getTime() - weekStart.getTime()) / (7 * 86400000)));

  const wFilter = { isTest: { $ne: true }, isArchived: { $ne: true }, status: { $ne: 'Archived' }, createdAt: { $gte: weekStart, $lt: weekEnd } };
  const prevFilter = { isTest: { $ne: true }, isArchived: { $ne: true }, status: { $ne: 'Archived' }, createdAt: { $gte: prevStart, $lt: prevEnd } };

  // ── Company-Level Metrics ──

  // Revenue Collected (previous week — payments completed)
  const [revenueAgg, prevRevenueAgg] = await Promise.all([
    Payment.aggregate([
      { $match: { ...wFilter, status: 'completed', type: { $in: REVENUE_PAYMENT_TYPES } } },
      { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } },
    ]),
    Payment.aggregate([
      { $match: { ...prevFilter, status: 'completed', type: { $in: REVENUE_PAYMENT_TYPES } } },
      { $group: { _id: null, total: { $sum: '$amount' } } },
    ]),
  ]);
  const revenue = revenueAgg[0]?.total || 0;
  const prevRevenue = prevRevenueAgg[0]?.total || 0;

  // Leads (new applications this week)
  const [newLeads, prevNewLeads] = await Promise.all([
    Application.countDocuments(wFilter),
    Application.countDocuments(prevFilter),
  ]);

  // Leads by source (marketing attribution)
  const sourceKeys = SOURCE_PLATFORMS.map((p) => p.key);
  const leadsBySourceAgg = await Application.aggregate([
    { $match: wFilter },
    { $lookup: { from: 'users', localField: 'studentId', foreignField: '_id', as: 'student' } },
    { $unwind: '$student' },
    { $addFields: { src: { $ifNull: ['$sourceAttribution.source', { $ifNull: ['$student.sourceAttribution.source', 'direct'] }] } } },
    { $group: { _id: '$src', count: { $sum: 1 } } },
  ]);
  const leadsBySource = {};
  leadsBySourceAgg.forEach((r) => { leadsBySource[r._id] = r.count; });

  // Proceeded by source (paid applications this week by source)
  const proceededBySourceAgg = await Application.aggregate([
    { $match: { ...wFilter, status: { $in: PAID_STATUSES } } },
    { $lookup: { from: 'users', localField: 'studentId', foreignField: '_id', as: 'student' } },
    { $unwind: '$student' },
    { $addFields: { src: { $ifNull: ['$sourceAttribution.source', { $ifNull: ['$student.sourceAttribution.source', 'direct'] }] } } },
    { $group: { _id: '$src', count: { $sum: 1 } } },
  ]);
  const proceededBySource = {};
  proceededBySourceAgg.forEach((r) => { proceededBySource[r._id] = r.count; });

  // Applications Paid
  const [appsPaid, prevAppsPaid] = await Promise.all([
    Application.countDocuments({ ...wFilter, status: { $in: PAID_STATUSES } }),
    Application.countDocuments({ ...prevFilter, status: { $in: PAID_STATUSES } }),
  ]);

  // Applications Completed (student completed all obligations)
  const [appsCompleted, prevAppsCompleted] = await Promise.all([
    Application.countDocuments({ ...wFilter, status: { $in: ['StudentCompleted', 'SentToRTO', 'WaitingForVerification', 'ReadyForRTOPayment', 'RTOInvoiceUploaded', ...COMPLETED_STATUSES] } }),
    Application.countDocuments({ ...prevFilter, status: { $in: ['StudentCompleted', 'SentToRTO', 'WaitingForVerification', 'ReadyForRTOPayment', 'RTOInvoiceUploaded', ...COMPLETED_STATUSES] } }),
  ]);

  // Certificates Released
  const [certsReleased, prevCerts] = await Promise.all([
    Certificate.countDocuments(wFilter),
    Certificate.countDocuments(prevFilter),
  ]);

  // ── Role-Based Accountability Metrics ──

  // All agents — anyone flagged as a sales agent, regardless of their role.
  // (Previously this heuristically unioned Agent/Admin/CEO roles; the explicit
  // isSalesAgent flag now decides who is tracked here.)
  const agents = await User.find({ isSalesAgent: true, status: 'active' }).select('firstName lastName email').lean();
  const staffAll = await User.find({ isSalesAgent: true, status: 'active' }).select('firstName lastName email role').lean();

  // Per-agent calls/quality come from the CallEvent log (single source of truth
  // shared with the daily Call Scorecard), not the Application contact counters.
  const callScorecardService = require('./callScorecardService');
  const weekFromStr = callScorecardService.dateStrAEST(weekStart);
  const weekToStr = callScorecardService.dateStrAEST(new Date(weekEnd.getTime() - 86400000));
  const weekCallEvents = await callScorecardService.queryEvents({ from: weekFromStr, to: weekToStr });
  const callEventsByAgent = {};
  weekCallEvents.forEach((e) => {
    const key = String(e.agentId);
    (callEventsByAgent[key] = callEventsByAgent[key] || []).push(e);
  });

  // Per-agent metrics
  const agentMetrics = await Promise.all(
    staffAll.map(async (agent) => {
      const agentFilter = { ...wFilter, assignedAgentId: agent._id };

      const [assigned, paid, completed] = await Promise.all([
        Application.countDocuments(agentFilter),
        Application.countDocuments({ ...agentFilter, status: { $in: PAID_STATUSES } }),
        Application.countDocuments({ ...agentFilter, status: { $in: COMPLETED_STATUSES } }),
      ]);

      const callAgg = callScorecardService.aggregate(callEventsByAgent[String(agent._id)] || []);
      const totalCalls = callAgg.calls;
      const quality = callAgg.quality;
      const conversionPct = assigned > 0 ? Math.round((paid / assigned) * 100) : 0;

      // Revenue from this agent's applications
      const agentRevenueAgg = await Payment.aggregate([
        { $match: { ...wFilter, status: 'completed', type: { $in: REVENUE_PAYMENT_TYPES } } },
        { $lookup: { from: 'applications', localField: 'applicationId', foreignField: '_id', as: 'app' } },
        { $unwind: '$app' },
        { $match: { 'app.assignedAgentId': agent._id } },
        { $group: { _id: null, total: { $sum: '$amount' } } },
      ]);

      return {
        _id: agent._id,
        name: `${agent.firstName || ''} ${agent.lastName || ''}`.trim() || agent.email,
        role: agent.role,
        assigned,
        paid,
        completed,
        totalCalls,
        quality,
        incoming: callAgg.incoming,
        conversionPct,
        revenue: agentRevenueAgg[0]?.total || 0,
      };
    })
  );

  // Forecast revenue (new leads × avg conversion × avg revenue per paid app)
  const allTimePaid = await Application.countDocuments({ isTest: { $ne: true }, isArchived: { $ne: true }, status: { $in: PAID_STATUSES } });
  const allTimeTotal = await Application.countDocuments({ isTest: { $ne: true }, isArchived: { $ne: true }, status: { $ne: 'Archived' } });
  const avgConvRate = allTimeTotal > 0 ? allTimePaid / allTimeTotal : 0;

  const allRevenueAgg = await Payment.aggregate([
    { $match: { isTest: { $ne: true }, isArchived: { $ne: true }, status: 'completed', type: { $in: REVENUE_PAYMENT_TYPES } } },
    { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } },
  ]);
  const avgRevenuePerPaid = allTimePaid > 0 ? (allRevenueAgg[0]?.total || 0) / allTimePaid : 0;
  const forecastRevenue = Math.round(newLeads * avgConvRate * avgRevenuePerPaid);

  // Load targets: week-specific first, then 'default', then hardcoded fallback
  const weekLabel = getISOWeekLabel(weekStart);
  const weekTargetDoc = await ScorecardTarget.findOne({ weekKey: weekLabel }).lean();
  const defaultTargetDoc = !weekTargetDoc ? await ScorecardTarget.findOne({ weekKey: 'default' }).lean() : null;
  const tDoc = weekTargetDoc || defaultTargetDoc || {};
  // Weekly targets scaled to the period. Volume targets multiply by the number of
  // weeks in the period (month → ~4–5×); conversion % is a rate, so it is left as-is.
  const targets = {
    revenue: (tDoc.revenue ?? DEFAULT_TARGETS.revenue) * weekEquiv,
    leads: (tDoc.leads ?? DEFAULT_TARGETS.leads) * weekEquiv,
    appsPaid: (tDoc.appsPaid ?? DEFAULT_TARGETS.appsPaid) * weekEquiv,
    appsCompleted: (tDoc.appsCompleted ?? DEFAULT_TARGETS.appsCompleted) * weekEquiv,
    certsReleased: (tDoc.certsReleased ?? DEFAULT_TARGETS.certsReleased) * weekEquiv,
    callsPerAgent: (tDoc.callsPerAgent ?? DEFAULT_TARGETS.callsPerAgent) * weekEquiv,
    conversionPerAgent: tDoc.conversionPerAgent ?? DEFAULT_TARGETS.conversionPerAgent,
    expenses: (tDoc.expenses ?? DEFAULT_TARGETS.expenses) * weekEquiv,
  };

  // Review notes + per-metric manual overrides, keyed by the period key the
  // frontend uses (weekKey for week mode, monthKey for month mode).
  const periodKey = period === 'month' ? (query.monthKey || weekLabel) : weekLabel;
  const periodDoc = period === 'month'
    ? await ScorecardTarget.findOne({ weekKey: periodKey }).lean()
    : (weekTargetDoc || null);
  const notes = periodDoc?.notes || '';
  const metricOverrides = periodDoc?.metricOverrides || {};

  // Apply a manual actual/status override onto an auto-computed metric object.
  const withOverride = (key, metric) => {
    const ov = metricOverrides[key] || {};
    const out = { ...metric };
    if (ov.actual !== undefined && ov.actual !== null && ov.actual !== '') {
      out.actual = Number(ov.actual);
      out.actualOverridden = true;
    }
    if (ov.status) out.statusOverride = ov.status;
    return out;
  };

  return {
    period,
    periodKey,
    weekStart: weekStart.toISOString(),
    weekEnd: weekEnd.toISOString(),
    weekLabel,
    notes,
    metricOverrides,

    companyMetrics: {
      revenue: withOverride('revenue', { actual: revenue, target: targets.revenue, prev: prevRevenue }),
      leads: withOverride('leads', { actual: newLeads, target: targets.leads, prev: prevNewLeads }),
      leadsBySource,
      proceededBySource,
      forecastRevenue,
      appsPaid: withOverride('appsPaid', { actual: appsPaid, target: targets.appsPaid, prev: prevAppsPaid }),
      appsCompleted: withOverride('appsCompleted', { actual: appsCompleted, target: targets.appsCompleted, prev: prevAppsCompleted }),
      certsReleased: withOverride('certsReleased', { actual: certsReleased, target: targets.certsReleased, prev: prevCerts }),
    },

    agentMetrics: agentMetrics.sort((a, b) => b.revenue - a.revenue),
    targets,
  };
}

/* ──────────────────────────────────────────────────────────────────
 * Lead Status Tracking — how leads move through the color-coded lead
 * statuses over time (powers the CEO "Lead Status Tracking" tab).
 * ────────────────────────────────────────────────────────────────── */

// Canonical lead-status (color) metadata — mirrors the frontend COLOR_OPTIONS.
const LEAD_STATUS_META = [
  { value: 'red', label: 'Hot Lead', color: '#ef4444' },
  { value: 'orange', label: 'Warm Lead', color: '#f97316' },
  { value: 'purple', label: 'Neutral Lead', color: '#a855f7' },
  { value: 'gray', label: 'Cold Lead', color: '#94a3b8' },
  { value: 'yellow', label: 'Payment Proceeded', color: '#eab308' },
  { value: 'green', label: 'Certified', color: '#22c55e' },
  { value: 'lightblue', label: 'Impacted', color: '#38bdf8' },
  { value: 'pink', label: 'Agent', color: '#ec4899' },
  { value: 'turquoise', label: 'New Year', color: '#14b8a6' },
  { value: '', label: 'Cleared', color: '#cbd5e1' },
];
const LEAD_LABEL = LEAD_STATUS_META.reduce((m, s) => { m[s.value] = s.label; return m; }, {});

function bucketKey(date, granularity) {
  const d = new Date(date);
  if (granularity === 'monthly') {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  }
  if (granularity === 'weekly') {
    return getISOWeekLabel(d);
  }
  // daily
  return d.toISOString().slice(0, 10);
}

async function getLeadStatusTracking(query = {}) {
  const granularity = ['daily', 'weekly', 'monthly'].includes(query.granularity)
    ? query.granularity
    : 'weekly';
  const dateFrom = getDateFrom(query.period, query);
  const dateTo = getDateTo(query);

  // Pull every app's lead-status trail + current color/status.
  const apps = await Application.find({ isTest: { $ne: true }, isArchived: { $ne: true }, status: { $ne: 'Archived' }, applicationId: { $ne: 'RECONCILIATION' } })
    .select('color status leadStatusHistory')
    .lean();

  const inWindow = (d) => {
    if (!d) return false;
    const t = new Date(d).getTime();
    if (dateFrom && t < dateFrom.getTime()) return false;
    if (dateTo && t > dateTo.getTime()) return false;
    return true;
  };

  const statusTotals = {};   // color → inbound transition count in window
  const timelineMap = {};    // bucketKey → { [color]: count }
  const flowMap = {};        // `${from}->${to}` → count
  const distribution = {};   // current color → count (non-archived)
  let totalChanges = 0;

  for (const app of apps) {
    // Current distribution — only active (non-archived) leads
    if (app.status !== 'Archived') {
      const c = app.color || '';
      if (c) distribution[c] = (distribution[c] || 0) + 1;
    }

    const history = Array.isArray(app.leadStatusHistory) ? app.leadStatusHistory : [];
    for (const h of history) {
      if (!inWindow(h.changedAt)) continue;
      const to = h.color || '';
      const from = h.previousColor || '';
      totalChanges += 1;

      // Inbound totals (moves INTO a status)
      if (to) statusTotals[to] = (statusTotals[to] || 0) + 1;

      // Timeline bucket
      const key = bucketKey(h.changedAt, granularity);
      if (!timelineMap[key]) timelineMap[key] = {};
      if (to) timelineMap[key][to] = (timelineMap[key][to] || 0) + 1;

      // From → To flow (skip the very first seed where from is empty)
      if (from || to) {
        const flowKey = `${from}->${to}`;
        flowMap[flowKey] = (flowMap[flowKey] || 0) + 1;
      }
    }
  }

  // Colors actually in use (for stacked chart series ordering)
  const usedColors = new Set([
    ...Object.keys(statusTotals),
    ...Object.keys(distribution),
  ]);
  const meta = LEAD_STATUS_META.filter((s) => s.value && usedColors.has(s.value));

  // Sorted timeline buckets ascending
  const timeline = Object.keys(timelineMap)
    .sort()
    .map((key) => ({ bucket: key, ...timelineMap[key] }));

  // Status inbound totals
  const statuses = Object.entries(statusTotals)
    .map(([value, count]) => ({ value, label: LEAD_LABEL[value] || value, count }))
    .sort((a, b) => b.count - a.count);

  // From → To flows
  const flows = Object.entries(flowMap)
    .map(([k, count]) => {
      const [from, to] = k.split('->');
      return {
        from,
        to,
        fromLabel: from ? (LEAD_LABEL[from] || from) : 'New',
        toLabel: to ? (LEAD_LABEL[to] || to) : 'Cleared',
        count,
      };
    })
    .sort((a, b) => b.count - a.count);

  // Current distribution
  const distributionArr = Object.entries(distribution)
    .map(([value, count]) => ({ value, label: LEAD_LABEL[value] || value, count }))
    .sort((a, b) => b.count - a.count);

  return {
    granularity,
    totalChanges,
    statuses,
    timeline,
    flows,
    totalFlows: flows.reduce((s, f) => s + f.count, 0),
    distribution: distributionArr,
    meta,
    window: { from: dateFrom, to: dateTo },
  };
}

/* ──────────────────────────────────────────────────────────────────
 * Qualification Tracking — per-qualification volume/paid/certified and
 * the best-fit agent per qualification (CEO "Qualification Tracking" tab).
 * Attribution: 'assigned' (assignedAgentId) or 'closed' (closedBy||assigned).
 * ────────────────────────────────────────────────────────────────── */
async function getQualificationTracking(query = {}) {
  const dateFrom = getDateFrom(query.period, query);
  const dateTo = getDateTo(query);
  const filter = dateFilter(dateFrom, dateTo);
  const attribution = query.attribution === 'closed' ? 'closed' : 'assigned';

  const apps = await Application.find({
    ...filter,
    applicationId: { $ne: 'RECONCILIATION' },
  })
    .select('qualificationId assignedAgentId closedBy status certificateId')
    .populate('qualificationId', 'name code')
    .populate('assignedAgentId', 'firstName lastName')
    .populate('closedBy', 'firstName lastName')
    .lean();

  const nameOf = (u) => (u ? `${u.firstName || ''} ${u.lastName || ''}`.trim() : '');

  const blankMetrics = () => ({ total: 0, paid: 0, completed: 0, certified: 0 });
  const bump = (bag, app) => {
    bag.total += 1;
    if (PAID_STATUSES.includes(app.status)) bag.paid += 1;
    if (COMPLETED_STATUSES.includes(app.status)) bag.completed += 1;
    if (app.certificateId) bag.certified += 1;
  };

  const qualMap = {};   // qualName → metrics
  const agentMap = {};  // agentName → { ...metrics, quals: { qualName: metrics } }
  let totalApplications = 0;

  for (const app of apps) {
    const qual = app.qualificationId;
    const qualName = qual?.name || app.qualificationId?.code || 'Unknown';

    const agentUser = attribution === 'closed'
      ? (app.closedBy || app.assignedAgentId)
      : app.assignedAgentId;
    const agentName = nameOf(agentUser) || 'Unassigned';

    totalApplications += 1;

    if (!qualMap[qualName]) qualMap[qualName] = { qualification: qualName, code: qual?.code || '', ...blankMetrics() };
    bump(qualMap[qualName], app);

    if (!agentMap[agentName]) agentMap[agentName] = { agent: agentName, ...blankMetrics(), quals: {} };
    bump(agentMap[agentName], app);
    if (!agentMap[agentName].quals[qualName]) {
      agentMap[agentName].quals[qualName] = { qualification: qualName, ...blankMetrics() };
    }
    bump(agentMap[agentName].quals[qualName], app);
  }

  const qualifications = Object.values(qualMap).sort((a, b) => b.total - a.total);

  const agents = Object.values(agentMap)
    .map((a) => ({
      agent: a.agent,
      total: a.total,
      paid: a.paid,
      completed: a.completed,
      certified: a.certified,
      qualifications: Object.values(a.quals).sort((x, y) => y.total - x.total),
    }))
    .sort((a, b) => b.total - a.total);

  // Best-fit agent per qualification — computed server-side (max paid, tiebreak certified).
  const bestFit = qualifications.map((q) => {
    let best = null;
    for (const a of agents) {
      if (a.agent === 'Unassigned') continue;
      const sub = a.qualifications.find((x) => x.qualification === q.qualification);
      if (!sub || sub.total === 0) continue;
      if (!best
        || sub.paid > best.paid
        || (sub.paid === best.paid && sub.certified > best.certified)) {
        best = { agent: a.agent, total: sub.total, paid: sub.paid, certified: sub.certified };
      }
    }
    return {
      qualification: q.qualification,
      code: q.code,
      total: q.total,
      bestAgent: best?.agent || null,
      bestAgentPaid: best?.paid || 0,
      bestAgentCertified: best?.certified || 0,
    };
  });

  return {
    totalApplications,
    qualifications,
    agents,
    bestFit,
    attribution,
    window: { from: dateFrom, to: dateTo },
  };
}

module.exports = {
  marketingSpend: marketingSpendCrud,
  getOverview,
  getLeads,
  getCallAttempts,
  getAgentPerformance,
  getMarketing,
  getMarketingSpendHistory,
  upsertMarketingSpend,
  deleteMarketingSpend,
  getSupplierLiability,
  exportMarketingData,
  getWeeklyScorecard,
  getLeadStatusTracking,
  getQualificationTracking,
};
