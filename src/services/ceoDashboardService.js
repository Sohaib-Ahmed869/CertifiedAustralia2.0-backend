const Application = require('../models/Application');
const Payment = require('../models/Payment');
const User = require('../models/User');
const Certificate = require('../models/Certificate');
const MarketingSpend = require('../models/MarketingSpend');
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
  { key: 'tiktok',   name: 'TikTok' },
  { key: 'meta',     name: 'Meta Paid' },
  { key: 'meta_ads', name: 'Meta Ads' },
  { key: 'linkedin', name: 'LinkedIn' },
  { key: 'google',   name: 'Google' },
  { key: 'print',    name: 'Print / QR' },
  { key: 'mainline', name: 'Mainline' },
  { key: 'vip',      name: 'VIP Line' },
  { key: 'gabby',    name: "Gabby's Line" },
  { key: 'rsg',      name: 'Rehman Sheriff Group' },
];

/**
 * Map legacy MarketingSpend platform keys to canonical source keys.
 * Allows spend logged under either the old or new key to be attributed correctly.
 */
const SPEND_KEY_TO_SOURCE = {
  tiktok: 'tiktok',
  meta: 'meta',
  meta_paid: 'meta',
  meta_ads: 'meta_ads',
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
 */
function getDateFrom(period) {
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
 * Build a date filter for createdAt queries.
 */
function dateFilter(dateFrom) {
  if (!dateFrom) return {};
  return { createdAt: { $gte: dateFrom } };
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
  const dateFrom = getDateFrom(query.period);
  const filter = dateFilter(dateFrom);

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
      const wFilter = { createdAt: { $gte: weekStart, $lt: weekEnd } };
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
  const dateFrom = getDateFrom(query.period);
  const filter = dateFilter(dateFrom);

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
      const wFilter = { createdAt: { $gte: weekStart, $lt: weekEnd } };
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
  const dateFrom = getDateFrom(query.period);
  const filter = dateFilter(dateFrom);

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
  const dateFrom = getDateFrom(query.period);
  const filter = dateFilter(dateFrom);

  // All agents
  const agents = await User.find({ role: 'Agent', status: 'active' }).select('firstName lastName').lean();

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
  const dateFrom = getDateFrom(query.period);
  const appFilter = dateFilter(dateFrom);
  const spendFilter = dateFrom ? { weekOf: { $gte: dateFrom } } : {};

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

  // ── 2. Leads & paid count per source (Application → Student lookup) ──
  const sourceKeys = SOURCE_PLATFORMS.map((p) => p.key);

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
        marketingSource: { $ifNull: ['$student.sourceAttribution.source', 'direct'] },
      },
    },
    { $match: { marketingSource: { $in: sourceKeys } } },
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
        marketingSource: { $ifNull: ['$student.sourceAttribution.source', 'direct'] },
      },
    },
    { $match: { marketingSource: { $in: sourceKeys } } },
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
  const totalLeadsFromAds = Object.values(leadsMap).reduce((sum, v) => sum + v, 0);
  const totalRevenueFromAds = Object.values(revenueMap).reduce((sum, v) => sum + v, 0);
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

  return {
    stats: {
      totalSpend,
      totalLeadsFromAds,
      totalRevenueFromAds,
      overallROAS,
      // Keep legacy field names so old frontend code doesn't break
      leadsFromAds: totalLeadsFromAds,
      revenueFromAds: totalRevenueFromAds,
    },
    platformCards,
    cpaBreakdown,
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

const Qualification = require('../models/Qualification');

/**
 * Supplier Liability / RTO Payables — CEO Dashboard
 * Shows which RTOs are owed money, from which applications, with forecasting.
 */
async function getSupplierLiability(query = {}) {
  const dateFrom = getDateFrom(query.period);
  const now = new Date();

  // 1. Applications with an assigned RTO (these generate RTO liabilities)
  const appFilter = { assignedRTOId: { $exists: true, $ne: null } };
  if (dateFrom) appFilter.createdAt = { $gte: dateFrom };

  const applications = await Application.find(appFilter)
    .populate('assignedRTOId', 'firstName lastName email')
    .populate('qualificationId', 'name caPrice rtoCosts')
    .populate('studentId', 'firstName lastName')
    .lean();

  // 2. Existing RTO payments (type rtoPayable or rtoPayment with status completed)
  const paidPayments = await Payment.find({
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
  const revFilter = { status: 'completed', type: { $in: REVENUE_PAYMENT_TYPES } };
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

module.exports = {
  marketingSpend: marketingSpendCrud,
  getOverview,
  getLeads,
  getCallAttempts,
  getAgentPerformance,
  getMarketing,
  getSupplierLiability,
};
