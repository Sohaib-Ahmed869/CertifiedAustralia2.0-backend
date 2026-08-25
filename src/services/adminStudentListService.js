/**
 * Admin Student/Application list — forecast-aware listing for the Admin portal.
 *
 * Ports the legacy "customers" page behaviour onto the new data model:
 *  - Timeframe windows (period presets + weekly/month/quarter nav via startDate/endDate).
 *  - "By Created" vs "By Paid" basis — created filters by lead-creation date; paid
 *    includes only applications that received an income payment inside the window and
 *    surfaces the amount received in that window per row (`_periodPaid`).
 *  - Forecast KPIs scoped to the SAME filters + window as the table:
 *      expected  = Σ (qualification.caPrice − discounts)   [what the filtered book is worth]
 *      collected = Σ completed income payments               [what's been received]
 *      outstanding = max(0, expected − collected)            [still to collect]
 *      collectedInPeriod = Σ completed income in the window  [By Paid only]
 *  - Extra filters: source, closedBy, readyForAssessment, paymentStatus.
 *
 * This is intentionally separate from the generic commonCrud `list` (which the agent
 * portal shares) so the heavier aggregation logic lives in one place.
 */
const mongoose = require('mongoose');
const Application = require('../models/Application');
const Payment = require('../models/Payment');
const ScreeningForm = require('../models/ScreeningForm');
const User = require('../models/User');

// Cast to ObjectId when valid — the forecast aggregation's $match does NOT auto-cast
// string ids the way Model.find() does, so id filters must be real ObjectIds.
function oid(v) {
  return mongoose.isValidObjectId(v) ? new mongoose.Types.ObjectId(v) : v;
}

// Real student income — mirrors the "money in" payment types. Excludes discount
// (not an inflow), refund/reversed, and rtoPayable/rtoPayment (money OUT to RTOs).
const INCOME_TYPES = ['upfront', 'plan', 'manualMarkPaid'];

// "Ready for Assessment" — student obligations done, in or past RTO handoff.
const READY_STATUSES = [
  'StudentCompleted', 'SentToRTO', 'WaitingForVerification',
  'ReadyForRTOPayment', 'RTOInvoiceUploaded', 'CertificateGenerated', 'CertificateIssued',
];

/**
 * Resolve the active [start, end] window from query params.
 * Explicit startDate/endDate (weekly/month/quarter navigation) take priority.
 * Otherwise rolling presets are anchored to "now". 'all' / bare 'weekly' → no window.
 */
function resolveWindow(query) {
  const { period, startDate, endDate } = query;

  if (startDate || endDate) {
    let start = null;
    let end = null;
    if (startDate) {
      const d = new Date(startDate);
      if (!isNaN(d.getTime())) { d.setHours(0, 0, 0, 0); start = d; }
    }
    if (endDate) {
      const d = new Date(endDate);
      if (!isNaN(d.getTime())) { d.setHours(23, 59, 59, 999); end = d; }
    }
    return { start, end };
  }

  if (!period || period === 'all' || period === 'weekly') {
    return { start: null, end: null };
  }

  const now = new Date();
  const end = new Date(now);
  let start = null;
  switch (period) {
    case '7d': start = new Date(now.getTime() - 7 * 86400000); break;
    case '15d': start = new Date(now.getTime() - 15 * 86400000); break;
    case '1m': start = new Date(now); start.setMonth(start.getMonth() - 1); break;
    case '3m': start = new Date(now); start.setMonth(start.getMonth() - 3); break;
    case '6m': start = new Date(now); start.setMonth(start.getMonth() - 6); break;
    case '1y': start = new Date(now); start.setFullYear(start.getFullYear() - 1); break;
    default: start = null;
  }
  return { start, end: start ? end : null };
}

/**
 * Build the base (non-date) Mongo filter from query params.
 * Returns the filter object; may perform lookups (state → ScreeningForm, search → User).
 */
async function buildBaseFilter(query) {
  const filter = {};

  // Status — readyForAssessment overrides an explicit status.
  if (query.readyForAssessment === 'true' || query.readyForAssessment === true) {
    filter.status = { $in: READY_STATUSES };
  } else if (query.status) {
    filter.status = query.status.includes(',')
      ? { $in: query.status.split(',').map((s) => s.trim()) }
      : query.status;
  } else {
    // Default: hide archived applications.
    filter.status = { $ne: 'Archived' };
  }

  // Active / Test / All capsule toggle. Applies to both the list rows AND the
  // summary KPIs (which are computed over this same filter).
  //   'test' → only test applications
  //   'all'  → everything (test + non-test)
  //   'active' (default) → exclude test applications
  if (query.appType === 'test') {
    filter.isTest = true;
  } else if (query.appType !== 'all') {
    filter.isTest = { $ne: true };
  }

  if (query.assignedAgentId) filter.assignedAgentId = oid(query.assignedAgentId);
  if (query.color) filter.color = query.color;
  if (query.industryId) filter.industryId = oid(query.industryId);
  if (query.closedBy) filter.closedBy = oid(query.closedBy);
  if (query.source) filter['sourceAttribution.source'] = query.source;

  if (query.callAttempts !== undefined && query.callAttempts !== '') {
    filter.contactAttempts = query.callAttempts === '5+'
      ? { $gte: 5 }
      : Number(query.callAttempts);
  }

  // Payment status — derived from the explicit completion flags on the application.
  if (query.paymentStatus === 'paid') {
    filter.paymentCompleted = true;
  } else if (query.paymentStatus === 'partial') {
    filter.partialPayment = true;
    filter.paymentCompleted = { $ne: true };
  } else if (query.paymentStatus === 'unpaid') {
    filter.paymentCompleted = { $ne: true };
    filter.partialPayment = { $ne: true };
  }

  // State lives on ScreeningForm, not Application — resolve to a set of app ids.
  if (query.state) {
    const forms = await ScreeningForm.find({ state: query.state }).select('applicationId').lean();
    filter._id = { $in: forms.map((f) => f.applicationId) };
  }

  // Free-text search — appId + student name/email.
  if (query.search) {
    const regex = { $regex: query.search, $options: 'i' };
    const users = await User.find({
      $or: [{ firstName: regex }, { lastName: regex }, { email: regex }],
    }).select('_id').lean();
    filter.$or = [
      { applicationId: regex },
      { studentId: { $in: users.map((u) => u._id) } },
    ];
  }

  return filter;
}

/** Intersect an existing `filter._id.$in` list with a new id list (for state + paid basis). */
function intersectIds(filter, ids) {
  if (filter._id && Array.isArray(filter._id.$in)) {
    const set = new Set(ids.map(String));
    filter._id = { $in: filter._id.$in.filter((x) => set.has(String(x))) };
  } else {
    filter._id = { $in: ids };
  }
}

async function adminList(query = {}) {
  const filter = await buildBaseFilter(query);
  const { start, end } = resolveWindow(query);
  const dateBasis = query.dateBasis === 'paid' ? 'paid' : 'created';
  const hasWindow = !!(start || end);

  // Per-row "amount received in window" map, for By Paid.
  let periodPaidMap = null;

  if (hasWindow) {
    if (dateBasis === 'paid') {
      const range = {};
      if (start) range.$gte = start;
      if (end) range.$lte = end;
      const paid = await Payment.aggregate([
        { $match: { status: 'completed', type: { $in: INCOME_TYPES }, createdAt: range } },
        { $group: { _id: '$applicationId', sum: { $sum: '$amount' } } },
      ]);
      periodPaidMap = new Map();
      const ids = [];
      paid.forEach((p) => {
        if (!p._id) return;
        periodPaidMap.set(String(p._id), p.sum);
        ids.push(p._id);
      });
      intersectIds(filter, ids);
    } else {
      const range = {};
      if (start) range.$gte = start;
      if (end) range.$lte = end;
      filter.createdAt = range;
    }
  }

  // ── Page of rows ──
  const page = Number(query.page || 1);
  const limit = Number(query.limit || 25);
  const sort = query.sort || '-createdAt';

  const [items, total] = await Promise.all([
    Application.find(filter)
      .sort(sort)
      .skip((page - 1) * limit)
      .limit(limit)
      .populate('studentId industryId qualificationId assignedAgentId paymentPlanId closedBy')
      .lean(),
    Application.countDocuments(filter),
  ]);

  if (periodPaidMap) {
    items.forEach((it) => { it._periodPaid = periodPaidMap.get(String(it._id)) || 0; });
  }

  // ── Forecast over the ENTIRE filtered set (not just the page) ──
  // KPIs share the list filter, so they follow the Active/Test/All toggle
  // (and the archived exclusion) applied in buildBaseFilter.
  const forecastAgg = await Application.aggregate([
    { $match: filter },
    {
      $lookup: {
        from: 'qualifications',
        localField: 'qualificationId',
        foreignField: '_id',
        as: '_qual',
      },
    },
    {
      $addFields: {
        _caPrice: { $ifNull: [{ $arrayElemAt: ['$_qual.caPrice', 0] }, 0] },
        _disc: { $sum: { $ifNull: ['$discounts.amount', []] } },
      },
    },
    { $addFields: { _net: { $max: [0, { $subtract: ['$_caPrice', '$_disc'] }] } } },
    {
      $group: {
        _id: null,
        expected: { $sum: '$_net' },
        count: { $sum: 1 },
        appIds: { $push: '$_id' },
      },
    },
  ]);

  const expected = forecastAgg[0]?.expected || 0;
  const count = forecastAgg[0]?.count || 0;
  const appIds = forecastAgg[0]?.appIds || [];

  // Collected (all-time) across the filtered apps — drives Outstanding.
  let collected = 0;
  let collectedInPeriod = null;
  if (appIds.length) {
    const [allTime, inPeriod] = await Promise.all([
      Payment.aggregate([
        { $match: { applicationId: { $in: appIds }, status: 'completed', type: { $in: INCOME_TYPES } } },
        { $group: { _id: null, sum: { $sum: '$amount' } } },
      ]),
      (dateBasis === 'paid' && hasWindow)
        ? Payment.aggregate([
          {
            $match: {
              applicationId: { $in: appIds },
              status: 'completed',
              type: { $in: INCOME_TYPES },
              createdAt: { ...(start ? { $gte: start } : {}), ...(end ? { $lte: end } : {}) },
            },
          },
          { $group: { _id: null, sum: { $sum: '$amount' } } },
        ])
        : Promise.resolve(null),
    ]);
    collected = allTime[0]?.sum || 0;
    if (inPeriod) collectedInPeriod = inPeriod[0]?.sum || 0;
  }

  // ── Filter options — Closed By roster (distinct closers) ──
  let closedByOptions = [];
  try {
    const closerIds = await Application.distinct('closedBy', { closedBy: { $ne: null } });
    if (closerIds.length) {
      const closers = await User.find({ _id: { $in: closerIds } })
        .select('firstName lastName email').lean();
      closedByOptions = closers.map((u) => ({
        value: String(u._id),
        label: `${u.firstName || ''} ${u.lastName || ''}`.trim() || u.email,
      }));
    }
  } catch { /* non-fatal */ }

  return {
    items,
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    forecast: {
      expected,
      collected,
      outstanding: Math.max(0, expected - collected),
      count,
      collectedInPeriod,
      dateBasis,
    },
    filterOptions: { closedBy: closedByOptions },
  };
}

/**
 * CSV rows for the CURRENT filtered set (not just the page) — respects every filter
 * and the active window/dateBasis so the export matches what the admin is looking at.
 */
async function adminExport(query = {}) {
  const filter = await buildBaseFilter(query);
  const { start, end } = resolveWindow(query);
  const dateBasis = query.dateBasis === 'paid' ? 'paid' : 'created';
  const hasWindow = !!(start || end);

  let periodPaidMap = null;
  if (hasWindow) {
    if (dateBasis === 'paid') {
      const range = {};
      if (start) range.$gte = start;
      if (end) range.$lte = end;
      const paid = await Payment.aggregate([
        { $match: { status: 'completed', type: { $in: INCOME_TYPES }, createdAt: range } },
        { $group: { _id: '$applicationId', sum: { $sum: '$amount' } } },
      ]);
      periodPaidMap = new Map();
      const ids = [];
      paid.forEach((p) => { if (p._id) { periodPaidMap.set(String(p._id), p.sum); ids.push(p._id); } });
      intersectIds(filter, ids);
    } else {
      const range = {};
      if (start) range.$gte = start;
      if (end) range.$lte = end;
      filter.createdAt = range;
    }
  }

  const apps = await Application.find(filter)
    .sort(query.sort || '-createdAt')
    .populate('studentId', 'firstName lastName email phone')
    .populate('qualificationId', 'name code caPrice')
    .populate('industryId', 'name')
    .populate('assignedAgentId', 'firstName lastName')
    .populate('closedBy', 'firstName lastName')
    .lean();

  // Collected per app (all-time) for the export's paid/remaining columns.
  const appIds = apps.map((a) => a._id);
  const collectedMap = new Map();
  if (appIds.length) {
    const rows = await Payment.aggregate([
      { $match: { applicationId: { $in: appIds }, status: 'completed', type: { $in: INCOME_TYPES } } },
      { $group: { _id: '$applicationId', sum: { $sum: '$amount' } } },
    ]);
    rows.forEach((r) => collectedMap.set(String(r._id), r.sum));
  }

  return apps.map((app) => {
    const student = app.studentId || {};
    const qual = app.qualificationId || {};
    const price = qual.caPrice || 0;
    const discount = (app.discounts || []).reduce((s, d) => s + (d.amount || 0), 0);
    const totalDue = Math.max(0, price - discount);
    const paid = Math.min(collectedMap.get(String(app._id)) || 0, totalDue);
    const agent = app.assignedAgentId || {};
    const closer = app.closedBy || {};
    return {
      applicationId: app.applicationId,
      isTest: !!app.isTest,
      studentName: `${student.firstName || ''} ${student.lastName || ''}`.trim(),
      studentEmail: student.email || '',
      phone: student.phone || '',
      qualification: qual.name || '',
      industry: (app.industryId || {}).name || '',
      status: app.status,
      source: app.sourceAttribution?.source || 'direct',
      assignedAgent: `${agent.firstName || ''} ${agent.lastName || ''}`.trim(),
      closedBy: `${closer.firstName || ''} ${closer.lastName || ''}`.trim(),
      callAttempts: app.contactAttempts || 0,
      createdAt: app.createdAt,
      price: totalDue,
      discount,
      paid,
      remaining: Math.max(0, totalDue - paid),
      ...(periodPaidMap ? { paidInPeriod: periodPaidMap.get(String(app._id)) || 0 } : {}),
      paymentStatus: app.paymentCompleted ? 'paid' : (app.partialPayment ? 'partial' : 'unpaid'),
    };
  });
}

// READY_STATUSES is exported because audienceService's "Ready for Assessment"
// filter reads it — without the export it destructured to undefined and the
// filter quietly matched nobody.
module.exports = { adminList, adminExport, resolveWindow, buildBaseFilter, INCOME_TYPES, READY_STATUSES };
