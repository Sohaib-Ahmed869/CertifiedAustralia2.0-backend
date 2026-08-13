const AppError = require('../utils/AppError');
const CashflowConfig = require('../models/CashflowConfig');
const CashflowWeek = require('../models/CashflowWeek');
const ExpenseLedger = require('../models/ExpenseLedger');
const Payment = require('../models/Payment');
const { AEST_TZ, aestDayStartUtc, aestDayEndUtc } = require('../utils/aestTime');

const REVENUE_PAYMENT_TYPES = ['upfront', 'plan', 'manualMarkPaid'];

const DEFAULT_CONFIG = {
  weeklyTarget: 60000,
  stretchTarget: 70000,
  tiers: [
    {
      id: 'core',
      name: 'Core Operations',
      priority: 1,
      color: 'green',
      protected: true,
      items: [
        { id: 'rtos', name: 'RTOs', amount: 10000 },
        { id: 'payroll', name: 'Payroll (incl. rent)', amount: 15000 },
      ],
    },
    {
      id: 'growth',
      name: 'Growth',
      priority: 2,
      color: 'violet',
      protected: true,
      items: [
        { id: 'proven', name: 'Proven', amount: 10000 },
        { id: 'get_social', name: 'Get Social', amount: 9950 },
      ],
    },
    {
      id: 'fixed',
      name: 'Fixed',
      priority: 3,
      color: 'amber',
      items: [
        { id: 'cars', name: 'Cars', amount: 830 },
      ],
    },
    {
      id: 'structured',
      name: 'Structured Payments',
      priority: 4,
      color: 'rose',
      items: [
        { id: 'executive', name: 'Executive', amount: 5000, debtTracking: true, debtKey: 'executive' },
        { id: 'dlk', name: 'DLK', amount: 3250, debtTracking: true, debtKey: 'dlk' },
      ],
    },
    {
      id: 'flex',
      name: 'Flex Zone',
      priority: 5,
      color: 'orange',
      items: [
        { id: 'super', name: 'Super', amount: 0, flex: true, debtTracking: true, debtKey: 'super' },
        { id: 'bizcap', name: 'Bizcap', amount: 0, flex: true, debtTracking: true, debtKey: 'bizcap' },
        { id: 'buffer', name: 'Buffer', amount: 0, flex: true },
      ],
    },
  ],
  debtBalances: { executive: 13000, dlk: 25000, bizcap: 75000, super: 25000 },
};

const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// Composite key into CashflowWeek.itemsPaid. NOT dot-separated: Mongoose Maps
// reject keys containing "." outright, which is why marking a supplier paid
// used to throw before it ever reached the ledger.
const itemKey = (tierId, itemId) => `${tierId}::${itemId}`;

/**
 * The seven Sydney civil dates ('YYYY-MM-DD', Mon→Sun) covered by an ISO week
 * key such as '2026-W33'. ISO week 1 is the week containing Jan 4.
 */
function getWeekDayKeys(weekKey) {
  const m = /^(\d{4})-W(\d{1,2})$/.exec(String(weekKey || ''));
  if (!m) throw new AppError('Invalid weekKey (expected YYYY-Www)', 400);
  const year = Number(m[1]);
  const week = Number(m[2]);
  if (week < 1 || week > 53) throw new AppError('Invalid weekKey (expected YYYY-Www)', 400);

  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4Day = jan4.getUTCDay() || 7; // Mon=1 … Sun=7
  const monday = new Date(jan4);
  monday.setUTCDate(jan4.getUTCDate() - (jan4Day - 1) + (week - 1) * 7);

  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(monday);
    d.setUTCDate(monday.getUTCDate() + i);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
  });
}

/**
 * Week boundaries as real UTC instants: Sydney Monday 00:00 → Sunday 23:59:59.999.
 * The portal is an AU product, so "the week" is a Sydney week regardless of where
 * the server runs (see utils/aestTime.js).
 */
function getWeekDates(weekKey) {
  const dayKeys = getWeekDayKeys(weekKey);
  return {
    start: aestDayStartUtc(dayKeys[0]),
    end: aestDayEndUtc(dayKeys[6]),
    dayKeys,
  };
}

/**
 * Cashflow status for a week's takings. Thresholds mirror the legacy portal
 * (50k / 60k / 70k) but are expressed relative to the configured targets so a
 * changed target moves the bands with it.
 */
function statusFromRevenue(revenueIn, target, stretch) {
  const weekly = target || 60000;
  if (revenueIn >= (stretch || weekly * (7 / 6))) return 'acceleration';
  if (revenueIn >= weekly) return 'stable';
  if (revenueIn >= weekly * (5 / 6)) return 'onTrack';
  return 'pressure';
}

/**
 * Get or create the singleton CashflowConfig.
 */
async function getConfig() {
  let config = await CashflowConfig.findOne().lean();
  if (!config) {
    const created = await CashflowConfig.create(DEFAULT_CONFIG);
    config = created.toObject();
  }
  return config;
}

/**
 * Update the singleton CashflowConfig. Only the fields supplied are touched —
 * a partial payload must never blank out the tier definitions, since losing
 * `tiers` would silently reset every week's payment structure.
 */
async function updateConfig(data = {}, userId) {
  const update = {};

  if (data.weeklyTarget !== undefined) {
    const v = parseFloat(data.weeklyTarget);
    if (!Number.isFinite(v) || v < 0) throw new AppError('weeklyTarget must be a non-negative number', 400);
    update.weeklyTarget = round2(v);
  }
  if (data.stretchTarget !== undefined) {
    const v = parseFloat(data.stretchTarget);
    if (!Number.isFinite(v) || v < 0) throw new AppError('stretchTarget must be a non-negative number', 400);
    update.stretchTarget = round2(v);
  }
  if (data.tiers !== undefined) {
    if (!Array.isArray(data.tiers) || data.tiers.length === 0) {
      throw new AppError('tiers must be a non-empty array', 400);
    }
    update.tiers = data.tiers.map((tier) => ({
      id: tier.id,
      name: tier.name,
      priority: Number(tier.priority) || 0,
      color: tier.color,
      protected: !!tier.protected,
      items: (tier.items || []).map((item) => ({
        id: item.id,
        name: item.name,
        amount: round2(item.amount),
        debtTracking: !!item.debtTracking,
        debtKey: item.debtKey || undefined,
        flex: !!item.flex,
      })),
    }));
  }
  if (data.debtBalances !== undefined) {
    if (typeof data.debtBalances !== 'object' || data.debtBalances === null) {
      throw new AppError('debtBalances must be an object', 400);
    }
    for (const [k, v] of Object.entries(data.debtBalances)) {
      const parsed = parseFloat(v);
      if (!Number.isFinite(parsed) || parsed < 0) {
        throw new AppError(`debtBalances.${k} must be a non-negative number`, 400);
      }
      update[`debtBalances.${k}`] = round2(parsed);
    }
  }

  if (Object.keys(update).length === 0) throw new AppError('No fields to update', 400);
  update.updatedAt = new Date();
  if (userId) update.updatedBy = userId;

  const existing = await CashflowConfig.findOne();
  if (!existing) await CashflowConfig.create(DEFAULT_CONFIG);
  await CashflowConfig.updateOne({}, { $set: update });
  return getConfig();
}

/**
 * Get or create a CashflowWeek for the given weekKey.
 */
async function getOrCreateWeek(weekKey) {
  let week = await CashflowWeek.findOne({ weekKey });
  if (!week) {
    const { start, end } = getWeekDates(weekKey);
    week = await CashflowWeek.create({ weekKey, weekStart: start, weekEnd: end });
  }
  return week;
}

/**
 * Revenue collected inside a week, bucketed by Sydney civil date.
 * Returns { total, byDay: { 'YYYY-MM-DD': amount } }.
 */
async function getWeekRevenue(start, end) {
  const rows = await Payment.aggregate([
    {
      $match: {
        isTest: { $ne: true },
        isArchived: { $ne: true },
        status: 'completed',
        type: { $in: REVENUE_PAYMENT_TYPES },
        createdAt: { $gte: start, $lte: end },
      },
    },
    {
      $group: {
        _id: { $dateToString: { date: '$createdAt', format: '%Y-%m-%d', timezone: AEST_TZ } },
        revenue: { $sum: '$amount' },
      },
    },
  ]);

  const byDay = {};
  let total = 0;
  for (const row of rows) {
    byDay[row._id] = round2(row.revenue);
    total += row.revenue;
  }
  return { total: round2(total), byDay };
}

/**
 * Build the tier cards for a week: what each supplier needs, what has actually
 * been paid against it, and how far the revenue has been allocated down the
 * pipeline. `requiredAmount` is the config amount for fixed items and the
 * week's flex allocation for flex-zone items.
 */
function buildTiers(config, itemsPaid, flexAllocations) {
  return (config.tiers || [])
    .slice()
    .sort((a, b) => (a.priority || 0) - (b.priority || 0))
    .map((tier) => {
      const items = (tier.items || []).map((item) => {
        const entry = itemsPaid[itemKey(tier.id, item.id)] || {};
        const paid = !!entry.paid;
        const flexAllocated = item.flex ? round2(flexAllocations[item.id] || 0) : null;
        const requiredAmount = item.flex ? round2(flexAllocated || 0) : round2(item.amount || 0);
        return {
          id: item.id,
          name: item.name,
          amount: round2(item.amount || 0),
          debtTracking: !!item.debtTracking,
          debtKey: item.debtKey || null,
          flex: !!item.flex,
          paid,
          paidAt: entry.paidAt || null,
          paidAmount: paid ? round2(entry.amount || 0) : 0,
          paidNotes: entry.notes || '',
          paidBy: entry.paidBy || null,
          expenseId: entry.expenseId || null,
          flexAllocated,
          requiredAmount,
        };
      });

      const total = round2(items.reduce((s, it) => s + it.requiredAmount, 0));
      const paidTotal = round2(items.reduce((s, it) => s + (it.paid ? it.paidAmount : 0), 0));
      const coverage = total > 0
        ? Math.round((paidTotal / total) * 100)
        : (items.length > 0 && items.every((it) => it.paid) ? 100 : 0);

      return {
        id: tier.id,
        name: tier.name,
        priority: tier.priority,
        color: tier.color,
        protected: !!tier.protected,
        items,
        total,
        paidTotal,
        coverage,
        complete: items.length > 0 && items.every((it) => it.paid),
      };
    });
}

/**
 * Get the full week summary for display.
 */
async function getWeekSummary(weekKey) {
  const { start, end, dayKeys } = getWeekDates(weekKey);
  const [config, week, revenue] = await Promise.all([
    getConfig(),
    getOrCreateWeek(weekKey),
    getWeekRevenue(start, end),
  ]);

  const target = config.weeklyTarget ?? 60000;
  const stretch = config.stretchTarget ?? 70000;

  // Daily revenue: cumulative takings against the Mon–Fri pace (target / 5).
  let cumulative = 0;
  const dailyRevenue = dayKeys.map((key, i) => {
    const dayRevenue = revenue.byDay[key] || 0;
    cumulative = round2(cumulative + dayRevenue);
    const dayTarget = i < 5 ? round2((target / 5) * (i + 1)) : null;
    return {
      day: DAY_LABELS[i],
      date: key,
      revenue: dayRevenue,
      cumulative,
      target: dayTarget,
      gap: dayTarget !== null ? round2(cumulative - dayTarget) : null,
    };
  });

  const itemsPaid = week.itemsPaid ? Object.fromEntries(week.itemsPaid) : {};
  const flexAllocations = week.flexAllocations ? Object.fromEntries(week.flexAllocations) : {};
  const tiers = buildTiers(config, itemsPaid, flexAllocations);

  // "Allocated" is money actually pushed down the pipeline this week, not the
  // wishlist — so it moves every time a supplier is marked paid.
  const allocated = round2(tiers.reduce((s, t) => s + t.paidTotal, 0));
  const totalRequired = round2(tiers.reduce((s, t) => s + t.total, 0));

  return {
    weekKey,
    weekStart: start,
    weekEnd: end,
    target,
    stretch,
    revenueIn: revenue.total,
    remaining: Math.max(0, round2(target - revenue.total)),
    allocated,
    totalRequired,
    unallocated: Math.max(0, round2(totalRequired - allocated)),
    surplus: round2(revenue.total - allocated),
    status: statusFromRevenue(revenue.total, target, stretch),
    tiers,
    flexAllocations,
    debtBalances: config.debtBalances || {},
    dailyRevenue,
  };
}

/**
 * Mark a tier item (supplier) as paid for a given week.
 *
 * The amount is caller-supplied so a supplier can be part-paid — the amount
 * actually banked is what gets allocated down the pipeline and what comes off
 * the debt balance, not the budgeted figure.
 */
async function markPaid(weekKey, tierId, itemId, amount, notes, userId) {
  if (!tierId || !itemId) throw new AppError('tierId and itemId are required', 400);

  const config = await getConfig();
  const tier = (config.tiers || []).find((t) => t.id === tierId);
  if (!tier) throw new AppError('Tier not found', 404);
  const item = (tier.items || []).find((it) => it.id === itemId);
  if (!item) throw new AppError('Item not found', 404);

  const week = await getOrCreateWeek(weekKey);
  const mapKey = itemKey(tierId, itemId);
  if (week.itemsPaid.get(mapKey)?.paid) {
    throw new AppError('Item is already marked paid for this week', 409);
  }

  // Resolve the amount: explicit value wins, then the week's flex allocation,
  // then the budgeted amount. Flex items have no budget to fall back on.
  let resolved;
  if (amount !== undefined && amount !== null && amount !== '') {
    const parsed = parseFloat(amount);
    if (!Number.isFinite(parsed) || parsed < 0) {
      throw new AppError('amount must be a non-negative number', 400);
    }
    resolved = round2(parsed);
  } else if (item.flex) {
    const allocation = round2(week.flexAllocations.get(itemId) || 0);
    if (allocation <= 0) throw new AppError('Set an allocation before marking a flex-zone item paid', 400);
    resolved = allocation;
  } else {
    resolved = round2(item.amount || 0);
  }

  // Claim the item on the week doc first. Mongo here is a standalone (no
  // transactions), so the write order matters: the claim is what the 409 guard
  // reads, and it is the step most likely to fail validation — booking the
  // ledger or the debt first would leave money moved with nothing showing paid.
  const paidAt = new Date();
  week.itemsPaid.set(mapKey, {
    paid: true,
    paidAt,
    amount: resolved,
    notes: notes || '',
    paidBy: userId,
  });
  week.updatedAt = paidAt;
  await week.save();

  const ledgerData = {
    weekKey,
    tierId,
    tierName: tier.name,
    itemId,
    itemName: item.name,
    amount: resolved,
    paidAt,
    paidBy: userId,
    notes: notes || '',
  };

  let ledger;
  try {
    // Debt-tracked suppliers draw their payment off the outstanding balance.
    if (item.debtTracking && item.debtKey) {
      const currentBalance = config.debtBalances?.[item.debtKey] || 0;
      ledgerData.debtKey = item.debtKey;
      ledgerData.debtBalanceAfter = Math.max(0, round2(currentBalance - resolved));
    }
    ledger = await ExpenseLedger.create(ledgerData);

    if (ledgerData.debtKey) {
      await CashflowConfig.updateOne({}, {
        $set: {
          [`debtBalances.${ledgerData.debtKey}`]: ledgerData.debtBalanceAfter,
          updatedAt: paidAt,
          ...(userId ? { updatedBy: userId } : {}),
        },
      });
    }
  } catch (err) {
    // Release the claim so the week never shows paid without a ledger entry.
    if (ledger) await ExpenseLedger.deleteOne({ _id: ledger._id }).catch(() => {});
    week.itemsPaid.delete(mapKey);
    await week.save().catch(() => {});
    throw err;
  }

  week.itemsPaid.get(mapKey).expenseId = ledger._id;
  week.markModified('itemsPaid');
  await week.save();

  return getWeekSummary(weekKey);
}

/**
 * Undo a mark-paid action for a week item: pulls the money back out of the
 * pipeline, deletes the ledger entry and restores the debt balance.
 */
async function undoPaid(weekKey, tierId, itemId, userId) {
  if (!tierId || !itemId) throw new AppError('tierId and itemId are required', 400);

  const config = await getConfig();
  const week = await CashflowWeek.findOne({ weekKey });
  if (!week) throw new AppError('Week not found', 404);

  const mapKey = itemKey(tierId, itemId);
  const paidInfo = week.itemsPaid.get(mapKey);
  if (!paidInfo || !paidInfo.paid) {
    throw new AppError('Item is not marked as paid', 400);
  }

  const tier = (config.tiers || []).find((t) => t.id === tierId);
  const item = (tier?.items || []).find((it) => it.id === itemId);
  if (item?.debtTracking && item.debtKey) {
    const currentBalance = config.debtBalances?.[item.debtKey] || 0;
    await CashflowConfig.updateOne({}, {
      $set: {
        [`debtBalances.${item.debtKey}`]: round2(currentBalance + (paidInfo.amount || 0)),
        updatedAt: new Date(),
        ...(userId ? { updatedBy: userId } : {}),
      },
    });
  }

  // Remove only the entry this mark-paid created; older weeks keep their history.
  if (paidInfo.expenseId) {
    await ExpenseLedger.deleteOne({ _id: paidInfo.expenseId });
  } else {
    await ExpenseLedger.deleteOne({ weekKey, tierId, itemId });
  }

  week.itemsPaid.delete(mapKey);
  week.updatedAt = new Date();
  await week.save();

  return getWeekSummary(weekKey);
}

/**
 * Set a flex zone allocation for an item. This is the planned split only — the
 * money is not booked until the item is marked paid.
 */
async function setFlexAllocation(weekKey, itemId, amount) {
  if (!itemId) throw new AppError('itemId is required', 400);
  const parsed = parseFloat(amount);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new AppError('amount must be a non-negative number', 400);
  }

  const config = await getConfig();
  const item = (config.tiers || [])
    .flatMap((t) => t.items || [])
    .find((it) => it.id === itemId);
  if (!item) throw new AppError('Item not found', 404);
  if (!item.flex) throw new AppError('Only flex-zone items can be allocated', 400);

  const week = await getOrCreateWeek(weekKey);
  week.flexAllocations.set(itemId, round2(parsed));
  week.updatedAt = new Date();
  await week.save();

  return getWeekSummary(weekKey);
}

/**
 * Generate all ISO week keys between two dates.
 */
function getWeekKeysBetween(start, end) {
  const keys = [];
  const current = new Date(start);
  while (current <= end) {
    keys.push(getISOWeekKey(current));
    current.setDate(current.getDate() + 7);
  }
  // Ensure the end date's week is included
  const endKey = getISOWeekKey(end);
  if (!keys.includes(endKey)) keys.push(endKey);
  return [...new Set(keys)];
}

function getISOWeekKey(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

/**
 * Aggregate cashflow across a date range.
 * Returns revenue, allocated, paid totals, and per-week breakdown.
 */
async function getRangeSummary(dateFrom, dateTo) {
  const start = new Date(dateFrom);
  const end = new Date(dateTo);
  end.setHours(23, 59, 59, 999);

  // Revenue across the full date range
  const revenueAgg = await Payment.aggregate([
    {
      $match: {
        isTest: { $ne: true }, isArchived: { $ne: true },
        status: 'completed',
        type: { $in: REVENUE_PAYMENT_TYPES },
        createdAt: { $gte: start, $lte: end },
      },
    },
    {
      $group: {
        _id: null,
        total: { $sum: '$amount' },
        count: { $sum: 1 },
      },
    },
  ]);
  const totalRevenue = round2(revenueAgg[0]?.total || 0);
  const paymentCount = revenueAgg[0]?.count || 0;

  // Weekly revenue breakdown
  const weeklyRevenueAgg = await Payment.aggregate([
    {
      $match: {
        isTest: { $ne: true }, isArchived: { $ne: true },
        status: 'completed',
        type: { $in: REVENUE_PAYMENT_TYPES },
        createdAt: { $gte: start, $lte: end },
      },
    },
    {
      $group: {
        _id: { $isoWeek: '$createdAt' },
        year: { $first: { $isoWeekYear: '$createdAt' } },
        revenue: { $sum: '$amount' },
      },
    },
    { $sort: { year: 1, _id: 1 } },
  ]);

  // Get expense ledger totals for the range
  const ledgerAgg = await ExpenseLedger.aggregate([
    {
      $match: {
        paidAt: { $gte: start, $lte: end },
      },
    },
    {
      $group: {
        _id: null,
        totalPaid: { $sum: '$amount' },
        count: { $sum: 1 },
      },
    },
  ]);
  const totalExpensesPaid = round2(ledgerAgg[0]?.totalPaid || 0);

  // Config for allocation targets
  const config = await getConfig();
  const weekKeys = getWeekKeysBetween(start, end);
  const totalRequired = round2(config.tiers.reduce(
    (sum, t) => sum + t.items.reduce((s, i) => s + (i.amount || 0), 0),
    0
  ) * weekKeys.length);

  const weeklyBreakdown = weeklyRevenueAgg.map((w) => ({
    weekKey: `${w.year}-W${String(w._id).padStart(2, '0')}`,
    revenue: round2(w.revenue),
  }));

  return {
    dateFrom: start,
    dateTo: end,
    weeksInRange: weekKeys.length,
    totalRevenue,
    paymentCount,
    // Same semantics as the weekly card: allocated = money actually paid out.
    totalAllocated: totalExpensesPaid,
    totalRequired,
    totalExpensesPaid,
    surplus: round2(totalRevenue - totalExpensesPaid),
    debtBalances: config.debtBalances,
    weeklyBreakdown,
  };
}

module.exports = {
  getConfig,
  updateConfig,
  getWeekSummary,
  getRangeSummary,
  markPaid,
  undoPaid,
  setFlexAllocation,
};
