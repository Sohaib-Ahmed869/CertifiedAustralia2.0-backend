/**
 * RTO batch payment queue.
 *
 * Flow (as clarified by the client, Aug 2026):
 *   application completed → 21-day RTO assessment timer runs → RTO invoice
 *   uploaded (timer stops) → the payable is AUTOMATICALLY dropped into the batch
 *   week that the upload falls in → CEO approves the week → rows are marked paid
 *   individually → the week is pushed to Xero as ACCPAY bills.
 *
 * Batches are never hand-built: `assignInvoice` runs from rtoInvoiceService on
 * every upload and `reconcile` is the daily safety net that catches anything
 * that slipped (a failed hook, a backfill, an invoice whose amount changed).
 * Both are idempotent and keyed on rtoInvoiceId, so a retry can't duplicate a row.
 */

const PaymentBatch = require('../models/PaymentBatch');
const BatchConfig = require('../models/BatchConfig');
const RTOInvoice = require('../models/RTOInvoice');
const Application = require('../models/Application');
const Payment = require('../models/Payment');
const AppError = require('../utils/AppError');
// Registered explicitly because buildItemSnapshot populates them. Inside the
// running server something else has always pulled these in first, but this
// service also runs from scripts and the cron, where load order is not given —
// an unregistered ref makes populate() throw "Schema hasn't been registered".
require('../models/User');
require('../models/Qualification');
const {
  DEFAULT_WEEK_ENDING_DAY,
  DEFAULT_DUE_SOON_DAYS,
  shiftKey,
  weekKeyFor,
  weekKeyFromDateKey,
  currentWeekKey,
  weekBounds,
  eligibilityDateFor,
  daysRemaining,
  urgencyFor,
  formatWeekKey,
} = require('../utils/batchWeek');
const { todayAestKey, aestDayStartUtc, aestDayEndUtc } = require('../utils/aestTime');

// Weeks returned per page when browsing the archive (~3 months at a time).
const DEFAULT_WEEK_PAGE = 12;
// Hard ceiling on how many weeks one request will load — also the window a
// row-level search can see, since that filtering happens after the fetch.
const MAX_WEEK_WINDOW = 200;

const POPULATE_FIELDS = [
  { path: 'approvedBy', select: 'firstName lastName' },
  { path: 'releasedBy', select: 'firstName lastName' },
  { path: 'xeroSyncedBy', select: 'firstName lastName' },
];

// Invoice states that mean "the amount is confirmed, this row may be paid".
const READY_INVOICE_STATUSES = ['verified', 'scheduled', 'paid'];
// Invoice states that never belong in a payment queue.
const EXCLUDED_INVOICE_STATUSES = ['rejected'];

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const getConfig = async () => {
  let cfg = await BatchConfig.findOne({ key: 'default' });
  if (!cfg) cfg = await BatchConfig.create({ key: 'default' });
  return cfg;
};

const updateConfig = async (payload = {}, userId = null) => {
  const cfg = await getConfig();
  const allowed = ['weekEndingDay', 'dueSoonDays', 'autoAssign', 'requireApprovalBeforePayment'];
  for (const key of allowed) {
    if (payload[key] !== undefined) cfg[key] = payload[key];
  }
  if (cfg.weekEndingDay < 0 || cfg.weekEndingDay > 6) {
    throw new AppError('weekEndingDay must be 0 (Sunday) – 6 (Saturday)', 400);
  }
  cfg.updatedBy = userId;
  await cfg.save();
  return cfg.toObject();
};

// ---------------------------------------------------------------------------
// Snapshot building
// ---------------------------------------------------------------------------

/**
 * Resolve the display + date columns for one RTO invoice.
 * Returns null when the invoice must not be queued (rejected / no amount source).
 */
const buildItemSnapshot = async (invoice) => {
  if (!invoice || EXCLUDED_INVOICE_STATUSES.includes(invoice.status)) return null;

  const app = invoice.applicationId
    ? await Application.findById(invoice.applicationId)
      .populate('studentId', 'firstName lastName')
      .populate('qualificationId', 'name rtoCosts')
      .populate('assignedRTOId', 'firstName lastName email')
      .lean()
    : null;

  // The application's assigned RTO is the normal source; fall back to the RTO
  // recorded on the invoice itself, otherwise the row reaches the Xero push with
  // nobody to bill.
  let rto = app?.assignedRTOId || null;
  if (!rto && invoice.rtoId) {
    rto = await require('../models/User').findById(invoice.rtoId).select('firstName lastName email').lean();
  }
  const qual = app?.qualificationId || null;

  // The invoice amount is authoritative — it is what the RTO actually billed.
  // Fall back to the catalogued RTO cost while the invoice is still unparsed.
  let amount = invoice.totalAmount || invoice.amount || 0;
  if (!amount && qual?.rtoCosts?.length) {
    const entry = qual.rtoCosts.find((r) => r.rtoId && rto && String(r.rtoId) === String(rto._id))
      || qual.rtoCosts[0];
    amount = entry?.rtoCost || 0;
  }

  const completionDate = app?.timerStartedAt || app?.studentCompletionDate || null;
  const eligibilityDate = eligibilityDateFor(completionDate) || app?.rtoCompletionDeadline || null;

  const rtoNameFromCatalog = qual?.rtoCosts?.find(
    (r) => r.rtoId && rto && String(r.rtoId) === String(rto._id)
  )?.rtoName;

  return {
    rtoInvoiceId: invoice._id,
    applicationId: app?._id || invoice.applicationId || null,
    rtoId: rto?._id || invoice.rtoId || null,
    applicationCode: app?.applicationId || null,
    studentName: app?.studentId
      ? `${app.studentId.firstName || ''} ${app.studentId.lastName || ''}`.trim()
      : null,
    rtoName: rtoNameFromCatalog
      || (rto ? `${rto.firstName || ''} ${rto.lastName || ''}`.trim() : null),
    qualificationName: qual?.name || null,
    invoiceNumber: invoice.invoiceNumber || invoice.invoiceId || null,
    amount,
    completionDate,
    eligibilityDate,
    // The upload instant is what buckets the week — the timer stops here.
    invoiceUploadedAt: invoice.createdAt || app?.timerStoppedAt || new Date(),
    readyForPayment: READY_INVOICE_STATUSES.includes(invoice.status),
  };
};

// ---------------------------------------------------------------------------
// Batch creation / assignment
// ---------------------------------------------------------------------------

/** Find-or-create the batch for a week key. Idempotent under concurrent calls. */
const ensureBatch = async (weekKey, config) => {
  const cfg = config || await getConfig();
  const bounds = weekBounds(weekKey);

  const batch = await PaymentBatch.findOneAndUpdate(
    { weekKey },
    {
      $setOnInsert: {
        weekKey,
        weekStartDate: bounds.weekStartDate,
        weekEndingDate: bounds.weekEndingDate,
        weekEndingDay: cfg.weekEndingDay ?? DEFAULT_WEEK_ENDING_DAY,
        status: 'draft',
        autoGenerated: true,
        createdAt: new Date(),
      },
      $set: { updatedAt: new Date() },
    },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );
  return batch;
};

/** The batch currently holding a given invoice, if any. */
const findBatchForInvoice = (invoiceId) =>
  PaymentBatch.findOne({ 'items.rtoInvoiceId': invoiceId });

/**
 * Drop an uploaded RTO invoice into its batch week, or refresh the row if it is
 * already there. Called from rtoInvoiceService on create/verify and by reconcile.
 *
 * A PAID row is never rewritten — a settled pay run is a financial record.
 * A row an admin has manually moved keeps its week.
 */
const assignInvoice = async (invoiceId, { config, force = false } = {}) => {
  const cfg = config || await getConfig();
  if (!cfg.autoAssign && !force) return null;

  const invoice = await RTOInvoice.findById(invoiceId).lean();
  if (!invoice) return null;

  const snapshot = await buildItemSnapshot(invoice);
  if (!snapshot) {
    // Rejected after it was queued — pull it back out.
    await removeInvoice(invoiceId);
    return null;
  }

  const existingBatch = await findBatchForInvoice(invoice._id);

  if (existingBatch) {
    const item = existingBatch.items.find((i) => String(i.rtoInvoiceId) === String(invoice._id));
    if (item && item.paymentStatus === 'paid') return existingBatch; // frozen

    if (item) {
      // Refresh the live columns; never clobber operator-entered state.
      item.applicationId = snapshot.applicationId;
      item.rtoId = snapshot.rtoId;
      item.applicationCode = snapshot.applicationCode;
      item.studentName = snapshot.studentName;
      item.rtoName = snapshot.rtoName;
      item.qualificationName = snapshot.qualificationName;
      item.invoiceNumber = snapshot.invoiceNumber;
      item.amount = snapshot.amount;
      item.completionDate = snapshot.completionDate;
      item.eligibilityDate = snapshot.eligibilityDate;
      item.invoiceUploadedAt = snapshot.invoiceUploadedAt;
      if (snapshot.readyForPayment) item.readyForPayment = true;
      recalcTotals(existingBatch);
      existingBatch.updatedAt = new Date();
      await existingBatch.save();
    }
    return existingBatch;
  }

  const weekKey = weekKeyFor(snapshot.invoiceUploadedAt, cfg.weekEndingDay);
  const batch = await ensureBatch(weekKey, cfg);

  // Guard against a concurrent assign of the same invoice.
  if (batch.items.some((i) => String(i.rtoInvoiceId) === String(invoice._id))) return batch;

  batch.items.push({ ...snapshot, addedAt: new Date() });
  recalcTotals(batch);
  batch.updatedAt = new Date();
  await batch.save();

  // Keep the invoice's own scheduling fields in step with the queue.
  await RTOInvoice.findByIdAndUpdate(invoice._id, {
    batchWeekKey: weekKey,
    ...(invoice.status === 'verified' ? { status: 'scheduled' } : {}),
  });

  return batch;
};

/** Pull an invoice out of the queue (rejected or deleted). Paid rows stay put. */
const removeInvoice = async (invoiceId) => {
  const batch = await findBatchForInvoice(invoiceId);
  if (!batch) return null;

  const item = batch.items.find((i) => String(i.rtoInvoiceId) === String(invoiceId));
  if (!item) return null;
  if (item.paymentStatus === 'paid') {
    throw new AppError('This invoice has already been paid in a batch and cannot be removed', 400);
  }

  batch.items.pull(item._id);
  recalcTotals(batch);
  batch.updatedAt = new Date();
  await batch.save();
  return batch;
};

/**
 * Safety net: queue every RTO invoice that isn't in a batch yet and refresh the
 * unpaid rows that are. Runs daily from the scheduler and on demand from the UI.
 */
const reconcile = async ({ force = false } = {}) => {
  const cfg = await getConfig();
  const invoices = await RTOInvoice.find({
    status: { $nin: EXCLUDED_INVOICE_STATUSES },
  }).select('_id').lean();

  const result = { checked: invoices.length, added: 0, refreshed: 0, skipped: 0, errors: [] };

  for (const inv of invoices) {
    try {
      const before = await findBatchForInvoice(inv._id);
      const batch = await assignInvoice(inv._id, { config: cfg, force: force || !cfg.autoAssign });
      if (!batch) { result.skipped += 1; continue; }
      if (before) result.refreshed += 1; else result.added += 1;
    } catch (err) {
      result.errors.push({ invoiceId: inv._id, message: err.message });
    }
  }

  // Always keep the current week open so the UI has somewhere to show "nothing
  // due this week" rather than an empty page.
  await ensureBatch(currentWeekKey(cfg.weekEndingDay), cfg);

  return result;
};

// ---------------------------------------------------------------------------
// Totals + derived week status
// ---------------------------------------------------------------------------

/**
 * Recompute money + week status from the rows. Mutates the doc; caller saves.
 * `approved` is the only status a human sets — released/completed are derived,
 * so a week can never claim to be settled while a row is still outstanding.
 */
function recalcTotals(batch) {
  const items = batch.items || [];
  batch.totalAmount = items.reduce((s, i) => s + (i.amount || 0), 0);
  batch.paidAmount = items.reduce((s, i) => s + (i.paymentStatus === 'paid' ? (i.paidAmount || i.amount || 0) : 0), 0);

  const paidCount = items.filter((i) => i.paymentStatus === 'paid').length;

  if (items.length > 0 && paidCount === items.length) {
    if (batch.status !== 'completed') {
      batch.status = 'completed';
      batch.completedAt = new Date();
    }
  } else if (paidCount > 0) {
    if (batch.status !== 'released') {
      batch.status = 'released';
      if (!batch.releasedAt) batch.releasedAt = new Date();
    }
    batch.completedAt = null;
  } else {
    // Nothing paid — fall back to approved (if a CEO signed it off) or draft.
    if (batch.status === 'released' || batch.status === 'completed') {
      batch.status = batch.approvedAt ? 'approved' : 'draft';
      batch.completedAt = null;
      batch.releasedAt = null;
    }
  }

  // Xero rollup across rows.
  const syncable = items.filter((i) => (i.amount || 0) > 0);
  const synced = syncable.filter((i) => i.xeroSyncStatus === 'synced').length;
  const failed = syncable.filter((i) => i.xeroSyncStatus === 'failed').length;
  if (syncable.length === 0 || (synced === 0 && failed === 0)) batch.xeroSyncStatus = 'notSynced';
  else if (synced === syncable.length) batch.xeroSyncStatus = 'synced';
  else if (synced === 0 && failed > 0) batch.xeroSyncStatus = 'failed';
  else batch.xeroSyncStatus = 'partial';
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/** Attach the computed columns the workbook shows but never stores. */
function decorate(batch, cfg, todayWeekKey) {
  const dueSoonDays = cfg.dueSoonDays ?? DEFAULT_DUE_SOON_DAYS;

  const items = (batch.items || []).map((item) => ({
    ...item,
    daysRemaining: daysRemaining(item.eligibilityDate),
    urgency: urgencyFor({
      paymentStatus: item.paymentStatus,
      eligibilityDate: item.eligibilityDate,
      dueSoonDays,
    }),
    outstanding: item.paymentStatus === 'paid' ? 0 : (item.amount || 0),
  }));

  const paidCount = items.filter((i) => i.paymentStatus === 'paid').length;
  const outstandingAmount = items.reduce((s, i) => s + i.outstanding, 0);

  let urgency;
  if (items.length > 0 && paidCount === items.length) urgency = 'settled';
  else if (batch.weekKey < todayWeekKey) urgency = 'overdue';
  else if (batch.weekKey === todayWeekKey) urgency = 'thisWeek';
  else urgency = 'upcoming';

  return {
    ...batch,
    items,
    weekLabel: formatWeekKey(batch.weekKey),
    itemCount: items.length,
    paidCount,
    unpaidCount: items.length - paidCount,
    readyCount: items.filter((i) => i.readyForPayment && i.paymentStatus !== 'paid').length,
    overdueCount: items.filter((i) => i.urgency === 'overdue').length,
    outstandingAmount,
    urgency,
  };
}

/**
 * List batch weeks, newest first, with the queue columns computed.
 * Row-level filters (q / rtoId / paymentStatus) filter INSIDE each week and drop
 * weeks that end up empty, so a search reads like a filtered spreadsheet.
 */
const list = async (query = {}) => {
  const cfg = await getConfig();
  const filter = {};
  if (query.status) filter.status = query.status;
  if (query.weekKey) filter.weekKey = query.weekKey;
  if (query.weekFrom || query.weekTo) {
    filter.weekKey = filter.weekKey || {};
    if (query.weekFrom) filter.weekKey.$gte = query.weekFrom;
    if (query.weekTo) filter.weekKey.$lte = query.weekTo;
  }

  // Row-level filters
  const q = (query.q || '').trim().toLowerCase();
  const rtoId = query.rtoId ? String(query.rtoId) : null;
  const paymentStatus = query.paymentStatus || null;
  const urgency = query.urgency || null;
  const readyOnly = query.ready === 'true' || query.ready === true;
  const xero = query.xero || null; // 'synced' | 'notSynced'
  const hasRowFilter = !!(q || rtoId || paymentStatus || urgency || readyOnly || xero);

  const limit = Math.min(parseInt(query.limit, 10) || DEFAULT_WEEK_PAGE, MAX_WEEK_WINDOW);
  const page = Math.max(parseInt(query.page, 10) || 1, 1);

  // Row filters are applied in JS over the fetched window, so paginating while
  // one is active would silently shrink what "search" covers — page 2 of a
  // search would be a search of a different, smaller haystack. Instead widen to
  // the maximum window, skip pagination, and report the boundary so the UI can
  // say when a search could not see the whole archive.
  const fetchLimit = hasRowFilter ? MAX_WEEK_WINDOW : limit;
  const skip = hasRowFilter ? 0 : (page - 1) * limit;

  const [raw, totalWeeks] = await Promise.all([
    PaymentBatch.find(filter)
      .populate(POPULATE_FIELDS)
      .sort({ weekKey: -1 })
      .skip(skip)
      .limit(fetchLimit)
      .lean(),
    PaymentBatch.countDocuments(filter),
  ]);

  const todayWeekKey = currentWeekKey(cfg.weekEndingDay);
  let batches = raw.map((b) => decorate(b, cfg, todayWeekKey));

  if (hasRowFilter) {
    batches = batches
      .map((b) => {
        const items = b.items.filter((i) => {
          if (rtoId && String(i.rtoId) !== rtoId) return false;
          if (paymentStatus && i.paymentStatus !== paymentStatus) return false;
          if (urgency && i.urgency !== urgency) return false;
          if (readyOnly && !(i.readyForPayment && i.paymentStatus !== 'paid')) return false;
          if (xero === 'synced' && i.xeroSyncStatus !== 'synced') return false;
          if (xero === 'notSynced' && i.xeroSyncStatus === 'synced') return false;
          if (q) {
            const hay = [i.applicationCode, i.studentName, i.rtoName, i.invoiceNumber, i.qualificationName]
              .filter(Boolean).join(' ').toLowerCase();
            if (!hay.includes(q)) return false;
          }
          return true;
        });
        return { ...b, items, itemCount: items.length, filtered: true };
      })
      .filter((b) => b.items.length > 0);
  }

  // The KPI cards describe the SELECTED PERIOD, not the loaded page — otherwise
  // paging through history would quietly redefine "Outstanding" every click.
  // Row filters are excluded from this aggregate on purpose: the headline totals
  // stay a stable read of the period while you search within it.
  const summary = await summarise(filter, cfg, todayWeekKey);

  return {
    items: batches,
    summary,
    config: cfg.toObject ? cfg.toObject() : cfg,
    pagination: {
      page: hasRowFilter ? 1 : page,
      limit,
      totalWeeks,
      pages: Math.max(1, Math.ceil(totalWeeks / limit)),
      hasMore: hasRowFilter ? false : skip + raw.length < totalWeeks,
    },
    // Honest reporting of what a row filter could actually see.
    filterScope: {
      rowFiltered: hasRowFilter,
      widened: hasRowFilter && totalWeeks > limit,
      searchedWeeks: hasRowFilter ? Math.min(totalWeeks, MAX_WEEK_WINDOW) : raw.length,
      truncated: hasRowFilter && totalWeeks > MAX_WEEK_WINDOW,
      maxWindow: MAX_WEEK_WINDOW,
    },
  };
};

/**
 * Period-wide totals, computed in Mongo over every week matching `filter`.
 *
 * Urgency boundaries are passed in as instants rather than compared in the
 * pipeline: eligibility dates are stored at Sydney day-end, so "overdue" is
 * exactly "eligibility day < today's Sydney day" — the same civil-day rule
 * `urgencyFor` applies per row. Deriving it any other way would let the cards
 * disagree with the badges beside them.
 */
async function summarise(filter, cfg, todayWeekKey) {
  const todayKey = todayAestKey();
  const todayStart = aestDayStartUtc(todayKey);
  const dueSoonEnd = aestDayEndUtc(shiftKey(todayKey, cfg.dueSoonDays ?? DEFAULT_DUE_SOON_DAYS));

  const unpaid = { $ne: ['$items.paymentStatus', 'paid'] };
  const countIf = (cond) => ({ $sum: { $cond: [cond, 1, 0] } });
  const sumIf = (cond, value) => ({ $sum: { $cond: [cond, value, 0] } });
  const isOverdue = {
    $and: [unpaid, { $ne: ['$items.eligibilityDate', null] }, { $lt: ['$items.eligibilityDate', todayStart] }],
  };

  const [agg] = await PaymentBatch.aggregate([
    { $match: filter },
    { $unwind: '$items' },
    {
      $group: {
        _id: null,
        weeks: { $addToSet: '$weekKey' },
        itemCount: { $sum: 1 },
        totalPayable: { $sum: { $ifNull: ['$items.amount', 0] } },
        paidAmount: sumIf({ $eq: ['$items.paymentStatus', 'paid'] }, { $ifNull: ['$items.paidAmount', '$items.amount'] }),
        outstandingAmount: sumIf(unpaid, { $ifNull: ['$items.amount', 0] }),
        overdueCount: countIf(isOverdue),
        overdueAmount: sumIf(isOverdue, { $ifNull: ['$items.amount', 0] }),
        dueSoonCount: countIf({
          $and: [unpaid, { $gte: ['$items.eligibilityDate', todayStart] }, { $lte: ['$items.eligibilityDate', dueSoonEnd] }],
        }),
        inAssessmentCount: countIf({ $and: [unpaid, { $eq: [{ $ifNull: ['$items.eligibilityDate', null] }, null] }] }),
        readyCount: countIf({ $and: [unpaid, { $eq: ['$items.readyForPayment', true] }] }),
        notSyncedCount: countIf({ $ne: ['$items.xeroSyncStatus', 'synced'] }),
      },
    },
  ]);

  // The current week's own figures, independent of the selected period — the
  // "what do I pay this Friday" card must not go blank when browsing history.
  const [thisWeekAgg] = await PaymentBatch.aggregate([
    { $match: { weekKey: todayWeekKey } },
    { $unwind: '$items' },
    {
      $group: {
        _id: null,
        amount: { $sum: { $ifNull: ['$items.amount', 0] } },
        outstanding: sumIf(unpaid, { $ifNull: ['$items.amount', 0] }),
      },
    },
  ]);

  return {
    weekCount: agg?.weeks?.length || 0,
    itemCount: agg?.itemCount || 0,
    totalPayable: agg?.totalPayable || 0,
    paidAmount: agg?.paidAmount || 0,
    outstandingAmount: agg?.outstandingAmount || 0,
    overdueCount: agg?.overdueCount || 0,
    overdueAmount: agg?.overdueAmount || 0,
    dueSoonCount: agg?.dueSoonCount || 0,
    inAssessmentCount: agg?.inAssessmentCount || 0,
    readyCount: agg?.readyCount || 0,
    notSyncedCount: agg?.notSyncedCount || 0,
    thisWeekKey: todayWeekKey,
    thisWeekLabel: formatWeekKey(todayWeekKey),
    thisWeekAmount: thisWeekAgg?.amount || 0,
    thisWeekOutstanding: thisWeekAgg?.outstanding || 0,
  };
}

const getById = async (id) => {
  const cfg = await getConfig();
  const batch = await PaymentBatch.findById(id).populate(POPULATE_FIELDS).lean();
  if (!batch) throw new AppError('Batch not found', 404);
  return decorate(batch, cfg, currentWeekKey(cfg.weekEndingDay));
};

// ---------------------------------------------------------------------------
// Week-level actions
// ---------------------------------------------------------------------------

/**
 * Manual generate — ensures a week exists and sweeps in anything unassigned.
 * The queue is automatic; this is the "something looks missing" button.
 */
const generateBatch = async (weekKeyInput) => {
  const cfg = await getConfig();
  const weekKey = weekKeyInput
    ? weekKeyFromDateKey(weekKeyInput, cfg.weekEndingDay)
    : currentWeekKey(cfg.weekEndingDay);
  if (!weekKey) throw new AppError('Week must be a date in YYYY-MM-DD format', 400);

  await ensureBatch(weekKey, cfg);
  await reconcile({ force: true });

  const batch = await PaymentBatch.findOne({ weekKey }).populate(POPULATE_FIELDS).lean();
  return decorate(batch, cfg, currentWeekKey(cfg.weekEndingDay));
};

const approve = async (id, userId) => {
  const batch = await PaymentBatch.findById(id);
  if (!batch) throw new AppError('Batch not found', 404);
  if (batch.status !== 'draft') throw new AppError('Only draft batch weeks can be approved', 400);
  if (!batch.items.length) throw new AppError('Cannot approve an empty batch week', 400);

  batch.status = 'approved';
  batch.approvedBy = userId;
  batch.approvedAt = new Date();
  batch.updatedAt = new Date();
  await batch.save();
  return getById(id);
};

/**
 * Release the week for payment. Explicit rather than derived so the pay run has
 * a named owner and timestamp; rows still have to be marked paid individually.
 */
const release = async (id, userId) => {
  const batch = await PaymentBatch.findById(id);
  if (!batch) throw new AppError('Batch not found', 404);
  if (batch.status !== 'approved') throw new AppError('Only approved batch weeks can be released', 400);

  batch.status = 'released';
  batch.releasedBy = userId;
  batch.releasedAt = new Date();
  batch.updatedAt = new Date();
  await batch.save();
  return getById(id);
};

/** Close the week. Refuses while money is still outstanding. */
const complete = async (id) => {
  const batch = await PaymentBatch.findById(id);
  if (!batch) throw new AppError('Batch not found', 404);

  const unpaid = batch.items.filter((i) => i.paymentStatus !== 'paid');
  if (unpaid.length) {
    throw new AppError(
      `${unpaid.length} row${unpaid.length === 1 ? '' : 's'} in this week ${unpaid.length === 1 ? 'is' : 'are'} still unpaid — mark them paid (or move them to another week) first`,
      400
    );
  }

  batch.status = 'completed';
  batch.completedAt = new Date();
  batch.updatedAt = new Date();
  await batch.save();
  return getById(id);
};

const updateBatch = async (id, { notes }) => {
  const batch = await PaymentBatch.findById(id);
  if (!batch) throw new AppError('Batch not found', 404);
  if (notes !== undefined) batch.notes = notes;
  batch.updatedAt = new Date();
  await batch.save();
  return getById(id);
};

// ---------------------------------------------------------------------------
// Row-level actions
// ---------------------------------------------------------------------------

function findItem(batch, itemId) {
  const item = batch.items.id(itemId);
  if (!item) throw new AppError('Batch row not found', 404);
  return item;
}

/** Edit the operator-owned columns (flags + notes). */
const updateItem = async (batchId, itemId, payload = {}) => {
  const batch = await PaymentBatch.findById(batchId);
  if (!batch) throw new AppError('Batch not found', 404);
  const item = findItem(batch, itemId);

  if (item.paymentStatus === 'paid' && payload.notes === undefined) {
    throw new AppError('This row is already paid — only its notes can be edited', 400);
  }

  if (payload.readyForPayment !== undefined) item.readyForPayment = !!payload.readyForPayment;
  if (payload.invoiceSentToAccounts !== undefined) item.invoiceSentToAccounts = !!payload.invoiceSentToAccounts;
  if (payload.notes !== undefined) item.notes = payload.notes;
  if (payload.amount !== undefined) {
    if (item.paymentStatus === 'paid') throw new AppError('Cannot change the amount of a paid row', 400);
    const amt = Number(payload.amount);
    if (!Number.isFinite(amt) || amt < 0) throw new AppError('Amount must be a positive number', 400);
    item.amount = amt;
  }
  if (payload.paymentStatus !== undefined) {
    if (payload.paymentStatus === 'paid') {
      throw new AppError('Use the mark-paid action to pay a row — it records the payment', 400);
    }
    if (!['pending', 'unpaid'].includes(payload.paymentStatus)) {
      throw new AppError('Payment status must be pending or unpaid', 400);
    }
    if (item.paymentStatus === 'paid') throw new AppError('Reverse the payment before changing its status', 400);
    item.paymentStatus = payload.paymentStatus;
  }

  recalcTotals(batch);
  batch.updatedAt = new Date();
  await batch.save();
  return getById(batchId);
};

/**
 * Mark one row paid. This is the money-out moment: it settles the application's
 * pending rtoPayable (created when the invoice was uploaded) rather than writing
 * a second record, so Supplier Liability and cashflow can't double-count.
 */
const markItemPaid = async (batchId, itemId, { amount, paymentDate, reference, notes, userId } = {}) => {
  const cfg = await getConfig();
  const batch = await PaymentBatch.findById(batchId);
  if (!batch) throw new AppError('Batch not found', 404);
  const item = findItem(batch, itemId);

  if (item.paymentStatus === 'paid') throw new AppError('This row is already marked paid', 400);
  if (cfg.requireApprovalBeforePayment && batch.status === 'draft') {
    throw new AppError('This batch week has not been approved yet — approve it before paying rows', 400);
  }
  if (!item.readyForPayment) {
    throw new AppError('This row is not marked ready for payment', 400);
  }

  const paidAmount = amount === undefined || amount === null || amount === '' ? item.amount : Number(amount);
  if (!Number.isFinite(paidAmount) || paidAmount <= 0) {
    throw new AppError('Payment amount must be greater than zero', 400);
  }

  const when = paymentDate ? new Date(paymentDate) : new Date();
  if (isNaN(when.getTime())) throw new AppError('Invalid payment date', 400);

  // Settle the auto-created payable if one is still open for this application.
  let payment = null;
  if (item.applicationId) {
    payment = await Payment.findOne({
      applicationId: item.applicationId,
      type: { $in: ['rtoPayable', 'rtoPayment'] },
      status: 'pending',
    }).sort('-createdAt');
  }

  const memo = [
    `Batch week ${formatWeekKey(batch.weekKey)}`,
    item.invoiceNumber ? `invoice ${item.invoiceNumber}` : null,
    notes || null,
  ].filter(Boolean).join(' — ');

  if (payment) {
    payment.amount = paidAmount;
    payment.status = 'completed';
    payment.paymentMethod = 'manual';
    payment.manualPaymentReference = reference || item.invoiceNumber || undefined;
    payment.manualPaymentReason = memo;
    payment.authorizedBy = userId || payment.authorizedBy;
    payment.updatedAt = new Date();
    await payment.save();
  } else {
    payment = await Payment.create({
      applicationId: item.applicationId || undefined,
      amount: paidAmount,
      type: 'rtoPayment',
      paymentMethod: 'manual',
      status: 'completed',
      manualPaymentReference: reference || item.invoiceNumber || undefined,
      manualPaymentReason: memo,
      authorizedBy: userId || undefined,
      notes: memo,
    });
  }

  item.paymentStatus = 'paid';
  item.paymentDate = when;
  item.paidAmount = paidAmount;
  item.paymentId = payment._id;
  item.markedPaidBy = userId || null;
  item.markedPaidAt = new Date();
  if (notes) item.notes = item.notes ? `${item.notes}\n${notes}` : notes;

  if (item.rtoInvoiceId) {
    await RTOInvoice.findByIdAndUpdate(item.rtoInvoiceId, { status: 'paid', updatedAt: new Date() });
  }

  recalcTotals(batch);
  batch.updatedAt = new Date();
  await batch.save();
  return getById(batchId);
};

/**
 * Undo a row payment. Nothing is deleted — an auto payable goes back to pending
 * and a batch-created payment is reversed, so the audit trail survives.
 */
const markItemUnpaid = async (batchId, itemId, { userId, reason } = {}) => {
  const batch = await PaymentBatch.findById(batchId);
  if (!batch) throw new AppError('Batch not found', 404);
  const item = findItem(batch, itemId);

  if (item.paymentStatus !== 'paid') throw new AppError('This row is not marked paid', 400);

  if (item.paymentId) {
    const payment = await Payment.findById(item.paymentId);
    if (payment) {
      payment.status = payment.type === 'rtoPayable' ? 'pending' : 'reversed';
      payment.manualPaymentReason = [
        payment.manualPaymentReason,
        `Reversed from batch week ${formatWeekKey(batch.weekKey)}${reason ? ` — ${reason}` : ''}`,
      ].filter(Boolean).join(' | ');
      payment.updatedAt = new Date();
      await payment.save();
    }
  }

  item.paymentStatus = 'unpaid';
  item.paymentDate = null;
  item.paidAmount = 0;
  item.paymentId = null;
  item.markedPaidBy = null;
  item.markedPaidAt = null;
  if (reason) item.notes = item.notes ? `${item.notes}\n${reason}` : reason;

  if (item.rtoInvoiceId) {
    // Back to where it was before the payment: still scheduled into this week,
    // but only claim "verified" if it actually was.
    const inv = await RTOInvoice.findById(item.rtoInvoiceId).select('verifiedAt').lean();
    await RTOInvoice.findByIdAndUpdate(item.rtoInvoiceId, {
      status: inv?.verifiedAt ? 'scheduled' : 'extracted',
      updatedAt: new Date(),
    });
  }

  recalcTotals(batch);
  batch.updatedAt = new Date();
  await batch.save();
  return getById(batchId);
};

/**
 * Move a row into a different batch week — the sheet's "Scheduled For" column,
 * used when a payable is deferred to the next pay run.
 */
const moveItem = async (batchId, itemId, targetWeekKeyInput) => {
  const cfg = await getConfig();
  const batch = await PaymentBatch.findById(batchId);
  if (!batch) throw new AppError('Batch not found', 404);
  const item = findItem(batch, itemId);

  if (item.paymentStatus === 'paid') throw new AppError('A paid row cannot be moved to another week', 400);

  const targetWeekKey = weekKeyFromDateKey(targetWeekKeyInput, cfg.weekEndingDay);
  if (!targetWeekKey) throw new AppError('Target week must be a date in YYYY-MM-DD format', 400);
  if (targetWeekKey === batch.weekKey) throw new AppError('That row is already in this week', 400);

  const target = await ensureBatch(targetWeekKey, cfg);
  if (target.status === 'completed') throw new AppError('That batch week is already completed', 400);

  const moved = item.toObject();
  delete moved._id;
  moved.movedFromWeekKey = batch.weekKey;
  target.items.push(moved);
  recalcTotals(target);
  target.updatedAt = new Date();
  await target.save();

  batch.items.pull(item._id);
  recalcTotals(batch);
  batch.updatedAt = new Date();
  await batch.save();

  if (moved.rtoInvoiceId) {
    await RTOInvoice.findByIdAndUpdate(moved.rtoInvoiceId, { batchWeekKey: targetWeekKey });
  }

  return getById(batchId);
};

// ---------------------------------------------------------------------------
// Xero
// ---------------------------------------------------------------------------

/**
 * Push the week to Xero as ACCPAY bills — one per row, contact = the RTO.
 *
 * Rows are pushed individually and stamped individually, so a single bad row
 * (missing RTO, Xero validation error) doesn't strand the rest of the week. The
 * linked Payment is stamped with the same Xero invoice ID so the nightly
 * `xeroService.syncAll()` cron won't raise a duplicate bill against the student.
 */
const pushToXero = async (batchId, userId) => {
  const xeroService = require('./xeroService');
  const batch = await PaymentBatch.findById(batchId);
  if (!batch) throw new AppError('Batch not found', 404);
  if (!batch.items.length) throw new AppError('This batch week has no rows to push', 400);

  const status = await xeroService.getConnectionStatus();
  if (!status.connected) {
    throw new AppError('Xero is not connected — connect it from Finance → Xero before pushing a batch', 400);
  }

  const result = { pushed: 0, failed: 0, skipped: 0, errors: [] };

  for (const item of batch.items) {
    if (item.xeroSyncStatus === 'synced' && item.xeroInvoiceId) { result.skipped += 1; continue; }
    if (!(item.amount > 0)) { result.skipped += 1; continue; }
    if (!item.readyForPayment) { result.skipped += 1; continue; }

    try {
      const xero = await xeroService.syncRTOBill({
        paymentId: item.paymentId,
        rtoId: item.rtoId,
        rtoName: item.rtoName,
        invoiceNumber: item.invoiceNumber,
        reference: item.applicationCode || item.invoiceNumber,
        description: `RTO fee — ${item.applicationCode || 'application'}${item.qualificationName ? ` — ${item.qualificationName}` : ''}${item.studentName ? ` (${item.studentName})` : ''}`,
        amount: item.amount,
        date: item.invoiceUploadedAt || batch.weekEndingDate,
        dueDate: batch.weekEndingDate,
      });

      item.xeroInvoiceId = xero.xeroInvoiceId || null;
      item.xeroSyncStatus = 'synced';
      item.xeroSyncedAt = new Date();
      item.xeroError = null;
      item.invoiceSentToAccounts = true;
      result.pushed += 1;
    } catch (err) {
      item.xeroSyncStatus = 'failed';
      item.xeroError = err.message;
      result.failed += 1;
      result.errors.push({ row: item.applicationCode || item.invoiceNumber, message: err.message });
    }
  }

  batch.xeroSyncedAt = new Date();
  batch.xeroSyncedBy = userId || null;
  recalcTotals(batch);
  batch.updatedAt = new Date();
  await batch.save();

  return { ...result, batch: await getById(batchId) };
};

module.exports = {
  // config
  getConfig,
  updateConfig,
  // automatic queue maintenance
  assignInvoice,
  removeInvoice,
  reconcile,
  ensureBatch,
  // read
  list,
  getById,
  // week actions
  generateBatch,
  approve,
  release,
  complete,
  updateBatch,
  // row actions
  updateItem,
  markItemPaid,
  markItemUnpaid,
  moveItem,
  // xero
  pushToXero,
};
