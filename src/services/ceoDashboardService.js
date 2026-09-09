const Application = require('../models/Application');
const Payment = require('../models/Payment');
const User = require('../models/User');
const Certificate = require('../models/Certificate');
const MarketingSpend = require('../models/MarketingSpend');
const CallEvent = require('../models/CallEvent');
const buildCrud = require('./commonCrud');
const marketingSourceService = require('./marketingSourceService');
const AppError = require('../utils/AppError');

const marketingSpendCrud = buildCrud(MarketingSpend, {
  populate: ['createdBy'],
});

const COMPLETED_STATUSES = [
  'CertificateGenerated',
  'CertificateIssued',
];

/**
 * "PAID" MEANS MONEY RECEIVED — never "advanced past the payment stage".
 *
 * Every metric here used to infer paid from status (anything at or after
 * `StudentIntakeForm`). Admins routinely move a student forward without a
 * payment, so that counted applications that had banked nothing: at the time
 * this was reported (Aug 2026) 31 of 155 applications read as paid while only
 * 19 had money against them — which is how a qualification nobody had paid for
 * showed a paid application on the CEO Qualifications tab.
 *
 * `paymentCompleted` (fully paid) and `partialPayment` (at least one payment)
 * are the model's explicit completion flags, maintained by paymentService. They
 * were verified against the Payment collection to agree EXACTLY with "has >= 1
 * completed upfront/plan/manualMarkPaid payment" — no drift in either
 * direction — so they are the cheap, index-friendly form of the same truth.
 * A partial counts: a deposit is money in the door.
 *
 * Use `PAID_MATCH` in a find/countDocuments/$match filter, `PAID_EXPR` inside an
 * aggregation expression ($cond/$expr), `paidMatchOn('app')` after a $lookup,
 * and `isPaidApp(doc)` when tallying in JS. Note PAID_MATCH carries an `$or`, so
 * never spread it into a filter that already has one.
 */
const PAID_MATCH = { $or: [{ paymentCompleted: true }, { partialPayment: true }] };
const PAID_EXPR = { $or: [{ $eq: ['$paymentCompleted', true] }, { $eq: ['$partialPayment', true] }] };
const paidMatchOn = (prefix) => ({
  $or: [{ [`${prefix}.paymentCompleted`]: true }, { [`${prefix}.partialPayment`]: true }],
});
const isPaidApp = (app) => !!(app && (app.paymentCompleted || app.partialPayment));

const REVENUE_PAYMENT_TYPES = ['upfront', 'plan', 'manualMarkPaid'];

/**
 * "APPLICATIONS PAID IN A PERIOD" MEANS MONEY LANDED IN THAT PERIOD — the
 * application's signup date is irrelevant.
 *
 * `PAID_MATCH` above answers "has this application EVER paid?", which is the
 * right question for an all-time or per-application check. It is the WRONG
 * question for a period metric, because the only date available to bucket on is
 * then `Application.createdAt`. Every weekly/period paid count here used to do
 * exactly that, so "Applications Paid this week" silently meant "signed up this
 * week AND has paid at some point since". A lead who registered a fortnight ago
 * and paid on Tuesday was credited back to the week they registered and was
 * missing from this week's card — which is how a week with 8 payers read as 3
 * (reported Sep 2026).
 *
 * These helpers bucket on the PAYMENT instead. Rules the client set:
 *  - Any application that received money in the window counts, whenever it
 *    signed up.
 *  - It counts ONCE per window however many installments landed in it, and
 *    counts again in a later window if it pays again — a payment-plan student
 *    paying monthly is an application that received money every month.
 *
 * Scope is deliberately IDENTICAL to the Revenue Collected aggregation (same
 * `status: 'completed'`, same `REVENUE_PAYMENT_TYPES`, same denormalised
 * `isTest`/`isArchived` flags that `Payment`'s pre-save hook copies off the
 * application), so the count and the dollars sitting next to it on a card can
 * never disagree about who is in scope.
 *
 * `Payment.createdAt` IS the payment instant — the model has no `paidAt` — and
 * the admin "Mark as Paid" screen deliberately backdates it to the day the money
 * actually arrived. Bucketing here preserves that on purpose.
 */
const PAID_PAYMENT_MATCH = {
  isTest: { $ne: true },
  isArchived: { $ne: true },
  status: 'completed',
  type: { $in: REVENUE_PAYMENT_TYPES },
};

/**
 * Build the `createdAt` range for a payment window, or null for all-time.
 * Mirrors `dateFilter`'s inclusive `$lte` for period queries; week windows pass
 * their own half-open `{ $gte, $lt }` instead.
 */
function paymentDateRange(dateFrom, dateTo) {
  if (!dateFrom && !dateTo) return null;
  const range = {};
  if (dateFrom) range.$gte = dateFrom;
  if (dateTo) range.$lte = dateTo;
  return range;
}

/** Distinct application ids that received money inside the window. */
async function paidApplicationIds(createdAtRange) {
  const match = { ...PAID_PAYMENT_MATCH, applicationId: { $ne: null } };
  if (createdAtRange) match.createdAt = createdAtRange;
  const rows = await Payment.aggregate([
    { $match: match },
    { $group: { _id: '$applicationId' } },
  ]);
  return rows.map((r) => r._id);
}

/** How many distinct applications received money inside the window. */
async function paidApplicationCount(createdAtRange) {
  const match = { ...PAID_PAYMENT_MATCH, applicationId: { $ne: null } };
  if (createdAtRange) match.createdAt = createdAtRange;
  const rows = await Payment.aggregate([
    { $match: match },
    { $group: { _id: '$applicationId' } },
    { $count: 'count' },
  ]);
  return rows[0]?.count || 0;
}

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
 * Marketing source platforms and the legacy-spend-key rollup both used to be
 * hardcoded arrays here — two of the ten declarations that had to be edited in
 * lockstep to add one tracking link. They now come from the MarketingSource
 * collection (`marketingSourceService`), which is editable from the Marketing
 * Links page, seeded with exactly the rows these constants used to hold, and
 * cached in-process so the extra read costs nothing per aggregation.
 *
 * Both helpers deliberately include INACTIVE sources: retiring a link must not
 * retroactively remove its leads, spend or revenue from a past period.
 */
const getSourcePlatforms = () => marketingSourceService.listPlatforms();
const getSpendKeyMap = () => marketingSourceService.getSpendKeyMap();

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

/* ──────────────────────────────────────────────────────────────────
 * SYDNEY CIVIL-CALENDAR BOUNDARIES.
 *
 * Every week and month on this dashboard is an AUSTRALIAN calendar period —
 * the business week the client reviews on a Monday morning. All of this used
 * to be computed with local getters (`new Date(y, 0, 4)`, `setHours(0,0,0,0)`,
 * `getDay()`), which only produce Sydney boundaries if the process happens to
 * run in Sydney. On the UTC hosts this deploys to, "the week" actually ran
 * Monday 10:00 → Monday 10:00 AEST, so ten hours of every Monday's leads,
 * payments and calls were reported against the PREVIOUS week.
 *
 * The rule here: a civil date is carried as a UTC-midnight `Date` used purely
 * as a (y, m, d) triple — never as an instant — and is converted to a real
 * instant only at the boundary, via `aestWallToUtc`. That two-step is what
 * makes the arithmetic DST-safe: a Sydney week is 167 or 169 hours across an
 * AEST/AEDT switch, so `weekStart + 7 * 86400000` lands an hour inside the
 * neighbouring week twice a year. Use `addWeeks`/`addDays`, not millisecond
 * arithmetic, to walk a window.
 *
 * Mirrors `utils/aestTime.js`, which owns the DST-aware conversion itself.
 * ────────────────────────────────────────────────────────────────── */

const { AEST_TZ, aestDateKey, aestWallToUtc } = require('../utils/aestTime');

/** The Sydney civil date an instant falls on, as a UTC-midnight Date. */
function civilOf(date) {
  const [y, m, d] = aestDateKey(date).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

/** A civil date (UTC-midnight Date) → the instant Sydney midnight begins. */
function civilToInstant(civil) {
  return aestWallToUtc(civil.getUTCFullYear(), civil.getUTCMonth() + 1, civil.getUTCDate(), 0, 0, 0, 0);
}

/** Shift a civil date by whole days. Pure calendar arithmetic, no DST involved. */
function addCivilDays(civil, days) {
  const out = new Date(civil);
  out.setUTCDate(out.getUTCDate() + days);
  return out;
}

/** Monday of the Sydney week an instant falls in, as a civil date. */
function civilWeekStart(date) {
  const civil = civilOf(date);
  return addCivilDays(civil, -((civil.getUTCDay() + 6) % 7));
}

/** Instant at which the Sydney week containing `date` begins (Mon 00:00). */
function weekStartInstant(date) {
  return civilToInstant(civilWeekStart(date));
}

/** `n` Sydney weeks after a week-start instant. DST-safe — never `+ 7 * 86400000`. */
function addWeeks(weekStartUtc, n) {
  return civilToInstant(addCivilDays(civilOf(weekStartUtc), n * 7));
}

/** `n` Sydney days after an instant, snapped to that day's midnight. */
function addDays(instant, n) {
  return civilToInstant(addCivilDays(civilOf(instant), n));
}

/** Instant at which a Sydney month begins (1st, 00:00). `month` is 1-based. */
function monthStartInstant(year, month) {
  return aestWallToUtc(year, month, 1, 0, 0, 0, 0);
}

/**
 * Get ISO week label (e.g. '2026-W24') for the SYDNEY week an instant falls in.
 */
function getISOWeekLabel(date) {
  // Thursday of this ISO week decides the year the week is numbered in.
  const thursday = addCivilDays(civilOf(date), 3 - ((civilOf(date).getUTCDay() + 6) % 7));
  const week1 = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 4));
  const weekNum = 1 + Math.round(
    ((thursday - week1) / 86400000 - 3 + ((week1.getUTCDay() + 6) % 7)) / 7
  );
  return `${thursday.getUTCFullYear()}-W${String(weekNum).padStart(2, '0')}`;
}

/** Sydney month key ('2026-09') for an instant. */
function getMonthKey(date) {
  return aestDateKey(date).slice(0, 7);
}

/**
 * Get month label (e.g. 'Jan 2026') for the SYDNEY month an instant falls in.
 */
function getMonthLabel(date) {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const civil = civilOf(date);
  return `${months[civil.getUTCMonth()]} ${civil.getUTCFullYear()}`;
}

/**
 * Generate an array of the last N Sydney weeks as { week, label } objects.
 */
function getLastNWeeks(n) {
  const weeks = [];
  let civil = civilWeekStart(new Date());
  civil = addCivilDays(civil, -(n - 1) * 7);
  for (let i = 0; i < n; i += 1) {
    const label = getISOWeekLabel(civilToInstant(civil));
    weeks.push({ week: label, label });
    civil = addCivilDays(civil, 7);
  }
  return weeks;
}

/**
 * Generate an array of the last N Sydney months as { month, label } objects.
 */
function getLastNMonths(n) {
  const months = [];
  const civil = civilOf(new Date());
  for (let i = n - 1; i >= 0; i -= 1) {
    const d = new Date(Date.UTC(civil.getUTCFullYear(), civil.getUTCMonth() - i, 1));
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    months.push({ month: key, label: getMonthLabel(civilToInstant(d)) });
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

  // Core stats. `paidApps` is money banked in the period; `cohortPaidApps` is how
  // many leads CREATED in the period have since converted — the funnel and the
  // conversion rate need the cohort, or a period where older leads pay can show
  // more paid applications than it had leads.
  const [totalLeads, paidApps, cohortPaidApps, completedApps, certificateCount] = await Promise.all([
    Application.countDocuments(filter),
    paidApplicationCount(paymentDateRange(dateFrom, dateTo)),
    Application.countDocuments({ ...filter, ...PAID_MATCH }),
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
    { $match: paidMatchOn('app') },
    {
      $group: {
        _id: null,
        paidRevenue: { $sum: '$amount' },
      },
    },
  ]);
  const paidRevenue = paidRevenueAgg[0]?.paidRevenue || 0;

  const avgPerApp = paidApps > 0 ? Math.round(totalRevenue / paidApps) : 0;
  const conversionRate = totalLeads > 0 ? Math.round((cohortPaidApps / totalLeads) * 10000) / 100 : 0;

  // Weekly leads vs paid (last 8 weeks)
  const weekBuckets = getLastNWeeks(8);
  const weeklyLeadsVsPaid = await Promise.all(
    weekBuckets.map(async (w) => {
      const weekStart = getWeekStartFromLabel(w.week);
      const weekEnd = addWeeks(weekStart, 1);
      const wFilter = { isTest: { $ne: true }, isArchived: { $ne: true }, status: { $ne: 'Archived' }, createdAt: { $gte: weekStart, $lt: weekEnd } };
      const [leads, paid] = await Promise.all([
        Application.countDocuments(wFilter),
        paidApplicationCount({ $gte: weekStart, $lt: weekEnd }),
      ]);
      return { week: w.week, label: w.label, leads, paid };
    })
  );

  // Pipeline funnel — a COHORT view (what became of the leads created in this
  // period), so its stages nest and its ratios stay ≤ 100%. The headline "Paid
  // Applications" KPI above is deliberately the other thing: money banked in the
  // period, irrespective of signup date.
  const pipelineFunnel = {
    totalLeads,
    paid: cohortPaidApps,
    completed: completedApps,
    certified: certificateCount,
    leadToPaid: totalLeads > 0 ? Math.round((cohortPaidApps / totalLeads) * 10000) / 100 : 0,
    paidToDone: cohortPaidApps > 0 ? Math.round((completedApps / cohortPaidApps) * 10000) / 100 : 0,
    certRate: completedApps > 0 ? Math.round((certificateCount / completedApps) * 10000) / 100 : 0,
  };

  // Revenue trend (last 12 Sydney months)
  const monthBuckets = getLastNMonths(12);
  const civilToday = civilOf(new Date());
  const trendFrom = monthStartInstant(civilToday.getUTCFullYear(), civilToday.getUTCMonth() - 10);
  const revenueByMonth = await Payment.aggregate([
    {
      $match: {
        isTest: { $ne: true }, isArchived: { $ne: true },
        status: 'completed',
        type: { $in: REVENUE_PAYMENT_TYPES },
        createdAt: { $gte: trendFrom },
      },
    },
    {
      // Bucket in Sydney, or a payment taken late on the last night of a month
      // is reported in the following one.
      $group: {
        _id: {
          year: { $year: { date: '$createdAt', timezone: AEST_TZ } },
          month: { $month: { date: '$createdAt', timezone: AEST_TZ } },
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
  const leadSources = leadSourceAgg
    // Exclude applications with no lead-status colour set — there's no real "Direct" channel here,
    // just leads that haven't been colour-tagged yet, and showing them as a source is misleading.
    .filter((s) => s._id)
    .map((s) => ({
      source: s._id,
      label: COLOR_SOURCE_MAP[s._id] || s._id,
      count: s.count,
      revenue: sourceRevMap[s._id] || 0,
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
      const weekEnd = addWeeks(weekStart, 1);
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
  // `aestDateKey`, not local getters — CallEvent.date is a SYDNEY civil date, so
  // formatting the window with the server's calendar shifted the range by a day.
  const toDateStr = (d) => aestDateKey(d);
  const funnelWeeks = getLastNWeeks(5);
  const funnelTrend = await Promise.all(
    funnelWeeks.map(async (w) => {
      const weekStart = getWeekStartFromLabel(w.week);
      const weekEnd = addWeeks(weekStart, 1);
      const wFilter = { isTest: { $ne: true }, isArchived: { $ne: true }, status: { $ne: 'Archived' }, createdAt: { $gte: weekStart, $lt: weekEnd } };
      const startStr = toDateStr(weekStart);
      const endStr = toDateStr(addDays(weekEnd, -1)); // inclusive last day
      const [leads, paid, calls] = await Promise.all([
        Application.countDocuments(wFilter),
        paidApplicationCount({ $gte: weekStart, $lt: weekEnd }),
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

  // `paidCount` = applications that banked money in the period (whenever they
  // signed up); `cohortPaidCount` = leads created in the period that have since
  // converted, which is what the lead-conversion percentage has to divide by.
  const [totalLeads, paidCount, cohortPaidCount] = await Promise.all([
    Application.countDocuments(filter),
    paidApplicationCount(paymentDateRange(dateFrom, dateTo)),
    Application.countDocuments({ ...filter, ...PAID_MATCH }),
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
  const conversionPct = totalLeads > 0 ? Math.round((cohortPaidCount / totalLeads) * 10000) / 100 : 0;
  const avgPerApp = paidCount > 0 ? Math.round(revenue / paidCount) : 0;

  // New leads per week (last 8 weeks)
  const weekBuckets = getLastNWeeks(8);
  const newLeadsPerWeek = await Promise.all(
    weekBuckets.map(async (w) => {
      const weekStart = getWeekStartFromLabel(w.week);
      const weekEnd = addWeeks(weekStart, 1);
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
      const weekEnd = addWeeks(weekStart, 1);
      const wFilter = { isTest: { $ne: true }, isArchived: { $ne: true }, status: { $ne: 'Archived' }, createdAt: { $gte: weekStart, $lt: weekEnd } };
      const [leads, paid] = await Promise.all([
        Application.countDocuments(wFilter),
        paidApplicationCount({ $gte: weekStart, $lt: weekEnd }),
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

  // Applications that banked money in this period, resolved once and reused per
  // agent — same basis as the per-agent revenue aggregation below, so an agent's
  // "paid" and "revenue" columns always describe the same set of deals.
  const periodPaidIds = await paidApplicationIds(paymentDateRange(dateFrom, dateTo));

  // Per-agent stats
  const details = await Promise.all(
    agents.map(async (agent) => {
      const agentFilter = { ...filter, assignedAgentId: agent._id };
      // `paid` counts deals that banked money in the period; `cohortPaid` counts
      // how many of the leads ASSIGNED in the period have since converted. The
      // conversion rate has to use the cohort — dividing payment activity by new
      // assignments lets an agent closing older leads read well over 100%.
      const [assigned, paid, completed, cohortPaid] = await Promise.all([
        Application.countDocuments(agentFilter),
        Application.countDocuments({ _id: { $in: periodPaidIds }, assignedAgentId: agent._id }),
        Application.countDocuments({ ...agentFilter, status: { $in: COMPLETED_STATUSES } }),
        Application.countDocuments({ ...agentFilter, ...PAID_MATCH }),
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

      const conversionPct = assigned > 0 ? Math.round((cohortPaid / assigned) * 10000) / 100 : 0;

      return {
        agentName: `${agent.firstName} ${agent.lastName}`,
        assigned,
        paid,
        completed,
        revenue,
        conversionPct,
        calls,
        cohortPaid,
      };
    })
  );

  const totalAssigned = details.reduce((sum, d) => sum + d.assigned, 0);
  const totalPaid = details.reduce((sum, d) => sum + d.paid, 0);
  const totalCohortPaid = details.reduce((sum, d) => sum + d.cohortPaid, 0);
  const totalRevenue = details.reduce((sum, d) => sum + d.revenue, 0);
  const totalCalls = details.reduce((sum, d) => sum + d.calls, 0);
  const agentCount = agents.length;
  const conversionPct = totalAssigned > 0 ? Math.round((totalCohortPaid / totalAssigned) * 10000) / 100 : 0;

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
  // Grouped by (platform, campaign) in one pass: the platform total is the sum
  // of BOTH its campaign rows and its untagged rows, so a campaign breakdown can
  // never disagree with the platform card above it.
  const spendAgg = await MarketingSpend.aggregate([
    { $match: spendFilter },
    {
      $group: {
        _id: { platform: '$platform', campaign: '$campaignKey' },
        spend: { $sum: '$amount' },
      },
    },
  ]);

  // Roll up spend into canonical source keys via each source's declared aliases
  const [sourcePlatforms, spendKeyMap] = await Promise.all([getSourcePlatforms(), getSpendKeyMap()]);
  const spendBySource = {};
  const spendByCampaign = {};
  spendAgg.forEach((s) => {
    const sourceKey = spendKeyMap[s._id.platform] || s._id.platform;
    spendBySource[sourceKey] = (spendBySource[sourceKey] || 0) + s.spend;
    if (s._id.campaign) {
      spendByCampaign[s._id.campaign] = (spendByCampaign[s._id.campaign] || 0) + s.spend;
    }
  });
  const totalSpend = Object.values(spendBySource).reduce((sum, v) => sum + v, 0);

  // ── 2. Leads & paid count per source ──
  // First try Application.sourceAttribution.source (new field), fall back to Student lookup for legacy data
  const sourceKeys = sourcePlatforms.map((p) => p.key);
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
          $sum: { $cond: [PAID_EXPR, 1, 0] },
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

  // ── 2b. The same counts split by ad campaign ──
  // Deliberately a SEPARATE pass rather than a second $group key on the pipeline
  // above: campaign attribution is sparse (most leads have none), so grouping
  // both dimensions together would produce a mostly-null bucket that the
  // platform rollup would then have to filter back out.
  const campaignLeadsAgg = await Application.aggregate([
    { $match: appFilter },
    { $lookup: { from: 'users', localField: 'studentId', foreignField: '_id', as: 'student' } },
    { $unwind: '$student' },
    {
      $addFields: {
        marketingCampaign: {
          $ifNull: ['$sourceAttribution.campaign', '$student.sourceAttribution.campaign'],
        },
      },
    },
    { $match: { marketingCampaign: { $nin: [null, ''] } } },
    {
      $group: {
        _id: '$marketingCampaign',
        leads: { $sum: 1 },
        paid: { $sum: { $cond: [PAID_EXPR, 1, 0] } },
      },
    },
  ]);

  const campaignRevenueAgg = await Payment.aggregate([
    { $match: { ...appFilter, status: 'completed', type: { $in: REVENUE_PAYMENT_TYPES } } },
    { $lookup: { from: 'applications', localField: 'applicationId', foreignField: '_id', as: 'app' } },
    { $unwind: '$app' },
    { $lookup: { from: 'users', localField: 'app.studentId', foreignField: '_id', as: 'student' } },
    { $unwind: '$student' },
    {
      $addFields: {
        marketingCampaign: {
          $ifNull: ['$app.sourceAttribution.campaign', '$student.sourceAttribution.campaign'],
        },
      },
    },
    { $match: { marketingCampaign: { $nin: [null, ''] } } },
    { $group: { _id: '$marketingCampaign', revenue: { $sum: '$amount' } } },
  ]);

  const campaignLeadsMap = {};
  const campaignPaidMap = {};
  campaignLeadsAgg.forEach((r) => {
    campaignLeadsMap[r._id] = r.leads;
    campaignPaidMap[r._id] = r.paid;
  });
  const campaignRevenueMap = {};
  campaignRevenueAgg.forEach((r) => { campaignRevenueMap[r._id] = r.revenue; });

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

  const platforms = sourcePlatforms.map((p) => {
    const spend = spendBySource[p.key] || 0;
    const leads = leadsMap[p.key] || 0;
    const paid = paidMap[p.key] || 0;
    const revenue = revenueMap[p.key] || 0;
    const cpa = paid > 0 ? Math.round(spend / paid) : 0;
    const roas = spend > 0 ? Math.round((revenue / spend) * 100) / 100 : 0;
    return { ...p, spend, leads, paid, revenue, cpa, roas };
  });

  /* ── 4b. Per-campaign cards ────────────────────────────────────────────────
   * A strict subdivision of the platform card above it: same metrics, same
   * formulas, narrowed to one `?campaign=` key.
   *
   * Driven by the REGISTRY (every campaign row), not by what the data happens to
   * contain, so a campaign that has spent money but produced nothing still shows
   * — that is the one a CEO most needs to see. Any campaign key found in the
   * data but missing from the registry is appended as an "unregistered" card
   * rather than dropped, mirroring how an unregistered `?source=` degrades: the
   * attribution was captured, it just has no label yet.
   */
  const AdCampaign = require('../models/AdCampaign');
  const campaignRows = await AdCampaign.find().sort({ sourceKey: 1, order: 1, name: 1 }).lean();
  const platformByKey = Object.fromEntries(sourcePlatforms.map((p) => [p.key, p]));

  const buildCampaignCard = (key, name, sourceKey, extra = {}) => {
    const spend = spendByCampaign[key] || 0;
    const leads = campaignLeadsMap[key] || 0;
    const paid = campaignPaidMap[key] || 0;
    const revenue = campaignRevenueMap[key] || 0;
    const parent = platformByKey[sourceKey];
    return {
      key,
      name,
      sourceKey,
      sourceLabel: parent?.name || sourceKey,
      color: parent?.color || '#64748b',
      icon: parent?.icon || 'link',
      spend,
      leads,
      paid,
      revenue,
      cpa: paid > 0 ? Math.round(spend / paid) : 0,
      cpaLead: leads > 0 ? Math.round(spend / leads) : 0,
      roas: spend > 0 ? Math.round((revenue / spend) * 100) / 100 : 0,
      ...extra,
    };
  };

  const campaignCards = campaignRows.map((c) => buildCampaignCard(c.key, c.name, c.sourceKey, {
    isActive: c.isActive !== false,
    description: c.description || '',
    // The creative, so the Marketing tab and the spend cockpit can show the ad
    // rather than another row of text. Only the id travels — the frontend builds
    // the Drive thumbnail URL, exactly as document previews already do.
    imageFileId: c.image?.fileId || '',
    registered: true,
  }));

  const known = new Set(campaignRows.map((c) => c.key));
  const orphanKeys = new Set([
    ...Object.keys(campaignLeadsMap),
    ...Object.keys(spendByCampaign),
    ...Object.keys(campaignRevenueMap),
  ].filter((k) => !known.has(k)));
  orphanKeys.forEach((k) => campaignCards.push(
    buildCampaignCard(k, k, '', { isActive: false, imageFileId: '', registered: false })
  ));

  campaignCards.sort((a, b) => b.spend - a.spend || b.leads - a.leads || a.name.localeCompare(b.name));

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
        marketingCampaign: { $ifNull: ['$sourceAttribution.campaign', { $ifNull: ['$student.sourceAttribution.campaign', ''] }] },
        collected: { $ifNull: [{ $arrayElemAt: ['$pay.total', 0] }, 0] },
        discountTotal: { $sum: { $ifNull: ['$discounts.amount', []] } },
      },
    },
    { $match: { marketingSource: { $in: leadSourceKeys } } },
    {
      $project: {
        applicationId: 1, status: 1, createdAt: 1, marketingSource: 1, marketingCampaign: 1, collected: 1, discountTotal: 1,
        // Carried through so the row's `paid` flag reads money received, not stage reached.
        paymentCompleted: 1, partialPayment: 1,
        price: { $ifNull: ['$qual.caPrice', 0] },
        studentName: { $trim: { input: { $concat: [{ $ifNull: ['$student.firstName', ''] }, ' ', { $ifNull: ['$student.lastName', ''] }] } } },
        agentName: { $trim: { input: { $concat: [{ $ifNull: ['$agent.firstName', ''] }, ' ', { $ifNull: ['$agent.lastName', ''] }] } } },
      },
    },
  ]);

  // A campaign's own spend-per-lead is the sharper number, so it takes
  // precedence; a lead with no campaign (or one with no spend booked) falls back
  // to its platform's share, which is what every row used before campaigns.
  const campaignSpendPerLead = {};
  Object.keys(campaignLeadsMap).forEach((k) => {
    campaignSpendPerLead[k] = campaignLeadsMap[k] > 0 ? (spendByCampaign[k] || 0) / campaignLeadsMap[k] : 0;
  });
  const campaignNameByKey = Object.fromEntries(campaignRows.map((c) => [c.key, c.name]));

  const applicationDetails = appDetailAgg.map((a) => {
    const camp = a.marketingCampaign || '';
    const cpaShare = Math.round(
      (camp && campaignSpendPerLead[camp]) || spendPerLead[a.marketingSource] || 0
    );
    const revenue = round2(a.collected);
    return {
      applicationId: a.applicationId || String(a._id),
      studentName: a.studentName || 'Unknown',
      source: a.marketingSource,
      campaign: camp,
      campaignName: camp ? (campaignNameByKey[camp] || camp) : '',
      date: a.createdAt,
      agent: a.agentName || '—',
      paid: isPaidApp(a),
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
    campaignCards,
    cpaBreakdown,
    applicationDetails,
  };
}

/**
 * ISO week label (e.g. '2026-W24') → the instant that SYDNEY week begins
 * (Monday 00:00 Australia/Sydney). Inverse of `getISOWeekLabel`.
 */
function getWeekStartFromLabel(weekLabel) {
  const [year, weekNum] = String(weekLabel).split('-W').map(Number);
  // Jan 4 is always in ISO week 1, so its Monday anchors the year.
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const monday = addCivilDays(jan4, -((jan4.getUTCDay() + 6) % 7) + (weekNum - 1) * 7);
  return civilToInstant(monday);
}

/** Monday instant → ISO week key like '2026-W29'. */
function mondayToWeekKey(date) {
  return getISOWeekLabel(date);
}

// Editable ad-spend platforms — the ACTIVE canonical keys. A retired source drops out
// of the editor but is added back below for any week that already has money against it,
// or that week's spend would silently vanish from the cockpit.
const getSpendEditPlatforms = () => marketingSourceService.listSpendPlatforms();

/**
 * Weekly ad-spend history — one row per ISO week (gaps filled), with per-platform
 * amounts + notes rolled up to canonical source keys. Powers the Ad Spend cockpit.
 */
async function getMarketingSpendHistory({ weeks = 12 } = {}) {
  const n = Math.min(Math.max(Number(weeks) || 12, 1), 52);

  // Monday of the current Sydney week
  const currentMonday = weekStartInstant(new Date());
  const earliest = addWeeks(currentMonday, -(n - 1));

  const docs = await MarketingSpend.find({ weekOf: { $gte: earliest } })
    .sort({ weekOf: 1, updatedAt: 1 })
    .lean();

  const spendKeyMap = await getSpendKeyMap();
  const weekMap = {};
  const seenPlatforms = new Set();
  const seenCampaigns = new Set();
  docs.forEach((doc) => {
    // `weekOf` is bucketed by the SYDNEY week it lands in, not compared for
    // equality — rows written before the boundaries moved to Sydney are stored
    // at the host's local midnight and still belong to this same Monday.
    const monday = weekStartInstant(doc.weekOf);
    const weekKey = mondayToWeekKey(monday);
    if (!weekMap[weekKey]) {
      weekMap[weekKey] = { weekKey, weekOf: monday, total: 0, platforms: {}, campaigns: {} };
    }
    const canonical = spendKeyMap[doc.platform] || doc.platform;
    seenPlatforms.add(canonical);

    // Every row counts toward its PLATFORM total, campaign-tagged or not — the
    // platform figure is the sum of the whole column, so the existing cockpit
    // keeps reading the same numbers it always did.
    //
    // `own` is the UNTAGGED portion, reported separately because the two are
    // used for different things: `amount` is what the card DISPLAYS (the
    // platform's real weekly spend), `own` is what its editor WRITES. Without
    // the split, opening the editor on a platform with campaign spend would
    // prefill the combined figure and saving it would add the campaigns' money
    // a second time.
    const bucket = weekMap[weekKey].platforms[canonical] || { amount: 0, own: 0, notes: '', ownNotes: '' };
    bucket.amount += doc.amount || 0;
    if (doc.notes) bucket.notes = doc.notes; // docs sorted asc by updatedAt → keep latest
    if (!doc.campaignKey) {
      bucket.own += doc.amount || 0;
      if (doc.notes) bucket.ownNotes = doc.notes;
    }
    weekMap[weekKey].platforms[canonical] = bucket;
    weekMap[weekKey].total += doc.amount || 0;

    // Campaign cells are additionally reported on their own, keyed by campaign,
    // so a cell can be edited independently of the platform-level row.
    if (doc.campaignKey) {
      seenCampaigns.add(doc.campaignKey);
      const cb = weekMap[weekKey].campaigns[doc.campaignKey] || { amount: 0, notes: '', platform: canonical };
      cb.amount += doc.amount || 0;
      if (doc.notes) cb.notes = doc.notes;
      weekMap[weekKey].campaigns[doc.campaignKey] = cb;
    }
  });

  // Fill every week in the window so the trend chart is continuous.
  const weeksArr = [];
  for (let i = n - 1; i >= 0; i -= 1) {
    const m = addWeeks(currentMonday, -i);
    const wk = mondayToWeekKey(m);
    weeksArr.push(weekMap[wk] || { weekKey: wk, weekOf: m, total: 0, platforms: {}, campaigns: {} });
  }

  // Active keys first (editor order), then any retired key that still holds spend in
  // the loaded window so its column keeps rendering.
  const editable = await getSpendEditPlatforms();
  const platforms = [...editable, ...[...seenPlatforms].filter((k) => !editable.includes(k))];

  // Campaigns the editor should offer: the active ones, plus any campaign that
  // already holds spend in this window (so a paused campaign's money stays
  // editable rather than becoming stranded in a cell nothing renders).
  const AdCampaign = require('../models/AdCampaign');
  const campaignRows = await AdCampaign.find({
    $or: [{ isActive: { $ne: false } }, { key: { $in: [...seenCampaigns] } }],
  }).sort({ sourceKey: 1, order: 1, name: 1 }).lean();

  const campaigns = campaignRows.map((c) => ({
    key: c.key,
    name: c.name,
    sourceKey: c.sourceKey,
    isActive: c.isActive !== false,
    imageFileId: c.image?.fileId || '',
  }));
  // A campaign key holding spend but no longer in the registry still gets a row,
  // or its money would vanish from the cockpit with no way to correct it.
  const knownCampaigns = new Set(campaignRows.map((c) => c.key));
  [...seenCampaigns].filter((k) => !knownCampaigns.has(k)).forEach((k) => campaigns.push({
    key: k, name: k, sourceKey: '', isActive: false, imageFileId: '',
  }));

  return { weeks: weeksArr, platforms, campaigns };
}

/**
 * The stored `weekOf` for an ad-spend cell, plus the range that identifies it.
 *
 * Writes match on the RANGE, not on the exact instant. `weekOf` used to be the
 * host's local midnight; it is now Sydney's, so an equality match would miss
 * every row written before that change and silently insert a duplicate
 * alongside it — and `getMarketingSpendHistory` sums the rows in a week, so the
 * cockpit would have shown the old and new figure added together. Matching the
 * week window instead adopts the existing row and rewrites it in place, which
 * is why no backfill is needed.
 */
function spendWeekTarget(weekKey) {
  const monday = getWeekStartFromLabel(weekKey);
  return { monday, range: { $gte: monday, $lt: addWeeks(monday, 1) } };
}

/**
 * Upsert a single (week, platform) ad-spend cell with optional notes.
 * amount <= 0 clears the cell. Guarantees one record per (week, platform).
 */
async function upsertMarketingSpend({ weekKey, platform, campaignKey, amount, notes, userId }) {
  // The MarketingSpend enum used to reject an unknown key at the schema layer; it had
  // to go so runtime-added sources could be saved, so the gate lives here now.
  await marketingSourceService.assertValidSpendPlatform(platform);

  // A campaign cell is a subdivision of its OWN platform's row. Booking money
  // against a campaign that belongs elsewhere would show spend on one platform
  // card and the leads it bought on another, so the pairing is verified rather
  // than trusted. `null` means platform-level spend, which is always allowed.
  const campaign = campaignKey ? String(campaignKey).trim().toLowerCase() : null;
  if (campaign) {
    const AdCampaign = require('../models/AdCampaign');
    const row = await AdCampaign.findOne({ key: campaign }).select('sourceKey name').lean();
    if (!row) throw new AppError(`"${campaign}" is not a known ad campaign`, 400);
    if (row.sourceKey !== platform) {
      throw new AppError(`Campaign "${row.name}" runs on ${row.sourceKey}, not ${platform}`, 400);
    }
  }

  const { monday, range } = spendWeekTarget(weekKey);
  // Scoping the filter on campaignKey is what keeps the cells independent —
  // without it, clearing a campaign's cell deletes the platform-level row that
  // shares its week. An equality match on `null` also matches the rows written
  // before campaigns existed, which is how they keep being adopted in place.
  const cell = { platform, campaignKey: campaign, weekOf: range };

  const amt = Number(amount) || 0;
  if (amt <= 0) {
    await MarketingSpend.deleteMany(cell);
    return { deleted: true, platform, campaignKey: campaign, weekKey };
  }
  const doc = await MarketingSpend.findOneAndUpdate(
    cell,
    {
      $set: { amount: amt, notes: notes || '', updatedAt: new Date() },
      $setOnInsert: { createdBy: userId, weekOf: monday },
    },
    { new: true, upsert: true, runValidators: true },
  );
  return { item: doc };
}

/** Delete an ad-spend cell for a (week, platform). */
/**
 * Clear one spend cell. `campaignKey` is part of the cell's identity: omitting
 * it clears only the PLATFORM-LEVEL row (an equality match on `null` also
 * catches the legacy rows written before campaigns existed), leaving each
 * campaign's own row in that week untouched.
 */
async function deleteMarketingSpend({ weekKey, platform, campaignKey }) {
  const { range } = spendWeekTarget(weekKey);
  const res = await MarketingSpend.deleteMany({
    platform,
    campaignKey: campaignKey ? String(campaignKey).trim().toLowerCase() : null,
    weekOf: range,
  });
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

  // This week's liability (items with deadline this week), Sydney Mon → Sun.
  // The old local-calendar version also mis-derived Monday: `getDate() -
  // getDay() + 1` returns NEXT Monday when run on a Sunday.
  const weekStart = weekStartInstant(now);
  const weekEnd = addWeeks(weekStart, 1); // exclusive
  const thisWeekItems = liabilityItems.filter(
    (i) => i.rtoCompletionDeadline &&
      new Date(i.rtoCompletionDeadline) >= weekStart &&
      new Date(i.rtoCompletionDeadline) < weekEnd
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
      const civilNow = civilOf(new Date());
      y = civilNow.getUTCFullYear();
      m = civilNow.getUTCMonth() + 1;
    }
    // Sydney month boundaries. `monthStartInstant` normalises the 13th/0th month.
    weekStart = monthStartInstant(y, m);
    weekEnd = monthStartInstant(y, m + 1); // first day of next month
    prevStart = monthStartInstant(y, m - 1);
    prevEnd = new Date(weekStart);
  } else {
    weekStart = query.weekKey
      ? getWeekStartFromLabel(query.weekKey)
      : weekStartInstant(new Date());
    weekEnd = addWeeks(weekStart, 1);
    prevStart = addWeeks(weekStart, -1);
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
  const sourceKeys = (await getSourcePlatforms()).map((p) => p.key);
  const leadsBySourceAgg = await Application.aggregate([
    { $match: wFilter },
    { $lookup: { from: 'users', localField: 'studentId', foreignField: '_id', as: 'student' } },
    { $unwind: '$student' },
    { $addFields: { src: { $ifNull: ['$sourceAttribution.source', { $ifNull: ['$student.sourceAttribution.source', 'direct'] }] } } },
    { $group: { _id: '$src', count: { $sum: 1 } } },
  ]);
  const leadsBySource = {};
  leadsBySourceAgg.forEach((r) => { leadsBySource[r._id] = r.count; });

  // Applications Paid — applications that RECEIVED MONEY this period, whenever
  // they signed up. Resolved as ids so the by-source chart and the per-agent
  // column below split exactly this set and always sum back to the card.
  const [paidIds, prevPaidIds] = await Promise.all([
    paidApplicationIds({ $gte: weekStart, $lt: weekEnd }),
    paidApplicationIds({ $gte: prevStart, $lt: prevEnd }),
  ]);
  const appsPaid = paidIds.length;
  const prevAppsPaid = prevPaidIds.length;

  // Proceeded by source (paid applications this week by source)
  const proceededBySourceAgg = await Application.aggregate([
    { $match: { _id: { $in: paidIds } } },
    { $lookup: { from: 'users', localField: 'studentId', foreignField: '_id', as: 'student' } },
    { $unwind: '$student' },
    { $addFields: { src: { $ifNull: ['$sourceAttribution.source', { $ifNull: ['$student.sourceAttribution.source', 'direct'] }] } } },
    { $group: { _id: '$src', count: { $sum: 1 } } },
  ]);
  const proceededBySource = {};
  proceededBySourceAgg.forEach((r) => { proceededBySource[r._id] = r.count; });

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
  const weekToStr = callScorecardService.dateStrAEST(addDays(weekEnd, -1));
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

      // See getAgentPerformance: `paid` is money banked this period, `cohortPaid`
      // is how many of this period's new assignments have converted. Conversion
      // must divide by the cohort or it can exceed 100%.
      const [assigned, paid, completed, cohortPaid] = await Promise.all([
        Application.countDocuments(agentFilter),
        Application.countDocuments({ _id: { $in: paidIds }, assignedAgentId: agent._id }),
        Application.countDocuments({ ...agentFilter, status: { $in: COMPLETED_STATUSES } }),
        Application.countDocuments({ ...agentFilter, ...PAID_MATCH }),
      ]);

      const callAgg = callScorecardService.aggregate(callEventsByAgent[String(agent._id)] || []);
      const totalCalls = callAgg.calls;
      const quality = callAgg.quality;
      const conversionPct = assigned > 0 ? Math.round((cohortPaid / assigned) * 100) : 0;

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
  const allTimePaid = await Application.countDocuments({ isTest: { $ne: true }, isArchived: { $ne: true }, ...PAID_MATCH });
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
  if (granularity === 'monthly') return getMonthKey(d);
  if (granularity === 'weekly') return getISOWeekLabel(d);
  // daily — the Sydney civil date, not the UTC one (`toISOString().slice(0,10)`
  // put every evening transition on the following day).
  return aestDateKey(d);
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
 *
 * AVERAGE PRICE PAID is revenue banked ÷ PAID applications — never ÷ total
 * applications, or every qualification's average would read as a fraction of
 * the real sale price simply because most enquiries never pay. Revenue is the
 * completed upfront/plan/manualMarkPaid payments sitting against the
 * applications in the window (a payment made later still belongs to the
 * application that earned it, so payments are NOT re-filtered by date), which
 * keeps the numerator on exactly the same definition of "paid" as the
 * denominator — `paymentCompleted`/`partialPayment` agree with "has >= 1
 * completed revenue payment". A part-paid student therefore pulls the average
 * DOWN: this is money received to date, not the agreed contract price.
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
    .select('qualificationId assignedAgentId closedBy status certificateId paymentCompleted partialPayment')
    .populate('qualificationId', 'name code')
    .populate('assignedAgentId', 'firstName lastName')
    .populate('closedBy', 'firstName lastName')
    .lean();

  // Revenue banked per application, for the average-price columns.
  const revenueRows = apps.length
    ? await Payment.aggregate([
      {
        $match: {
          applicationId: { $in: apps.map((a) => a._id) },
          status: 'completed',
          type: { $in: REVENUE_PAYMENT_TYPES },
          isTest: { $ne: true },
          isArchived: { $ne: true },
        },
      },
      { $group: { _id: '$applicationId', amount: { $sum: '$amount' } } },
    ])
    : [];
  const revenueByApp = new Map(revenueRows.map((r) => [String(r._id), r.amount || 0]));

  const nameOf = (u) => (u ? `${u.firstName || ''} ${u.lastName || ''}`.trim() : '');

  const blankMetrics = () => ({ total: 0, paid: 0, completed: 0, certified: 0, revenue: 0 });
  const bump = (bag, app) => {
    bag.total += 1;
    if (isPaidApp(app)) bag.paid += 1;
    if (COMPLETED_STATUSES.includes(app.status)) bag.completed += 1;
    if (app.certificateId) bag.certified += 1;
    bag.revenue += revenueByApp.get(String(app._id)) || 0;
  };
  const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
  /** Attach revenue/avgPrice to a metrics bag (rounded for transport). */
  const withAvg = (bag) => ({
    ...bag,
    revenue: round2(bag.revenue),
    avgPrice: bag.paid > 0 ? round2(bag.revenue / bag.paid) : 0,
  });

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

  const qualifications = Object.values(qualMap)
    .map(withAvg)
    .sort((a, b) => b.total - a.total);

  const agents = Object.values(agentMap)
    .map((a) => ({
      ...withAvg({
        total: a.total, paid: a.paid, completed: a.completed, certified: a.certified, revenue: a.revenue,
      }),
      agent: a.agent,
      qualifications: Object.values(a.quals).map(withAvg).sort((x, y) => y.total - x.total),
    }))
    .sort((a, b) => b.total - a.total);

  const totalRevenue = round2(qualifications.reduce((s, q) => s + q.revenue, 0));
  const totalPaid = qualifications.reduce((s, q) => s + q.paid, 0);

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
        best = {
          agent: a.agent, total: sub.total, paid: sub.paid, certified: sub.certified, avgPrice: sub.avgPrice,
        };
      }
    }
    return {
      qualification: q.qualification,
      code: q.code,
      total: q.total,
      avgPrice: q.avgPrice,
      bestAgent: best?.agent || null,
      bestAgentPaid: best?.paid || 0,
      bestAgentCertified: best?.certified || 0,
      bestAgentAvgPrice: best?.avgPrice || 0,
    };
  });

  return {
    totalApplications,
    totalRevenue,
    // Blended average across every paying application in the window — NOT the
    // mean of the per-qualification averages (that would weight a one-sale
    // qualification the same as a fifty-sale one).
    avgPrice: totalPaid > 0 ? round2(totalRevenue / totalPaid) : 0,
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
