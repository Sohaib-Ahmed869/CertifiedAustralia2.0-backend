const AppError = require('../utils/AppError');
const CashflowConfig = require('../models/CashflowConfig');
const CashflowWeek = require('../models/CashflowWeek');
const ExpenseLedger = require('../models/ExpenseLedger');
const Payment = require('../models/Payment');

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

/**
 * Compute ISO week date range from a weekKey (e.g. '2026-W24').
 */
function getWeekDates(weekKey) {
  const [year, weekNum] = weekKey.split('-W').map(Number);
  // ISO week 1 contains the first Thursday of the year
  const jan4 = new Date(year, 0, 4);
  const dayOfWeek = jan4.getDay() || 7;
  const monday = new Date(jan4);
  monday.setDate(jan4.getDate() - dayOfWeek + 1 + (weekNum - 1) * 7);
  monday.setHours(0, 0, 0, 0);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  sunday.setHours(23, 59, 59, 999);
  return { start: monday, end: sunday };
}

/**
 * Get or create the singleton CashflowConfig.
 */
async function getConfig() {
  let config = await CashflowConfig.findOne().lean();
  if (!config) {
    config = await CashflowConfig.create(DEFAULT_CONFIG);
    config = config.toObject();
  }
  return config;
}

/**
 * Update the singleton CashflowConfig.
 */
async function updateConfig(data, userId) {
  let config = await CashflowConfig.findOne();
  if (!config) {
    config = await CashflowConfig.create({ ...DEFAULT_CONFIG, ...data, updatedBy: userId });
    return config.toObject();
  }

  Object.assign(config, data);
  config.updatedBy = userId;
  config.updatedAt = new Date();
  await config.save();
  return config.toObject();
}

/**
 * Get or create a CashflowWeek for the given weekKey.
 */
async function getOrCreateWeek(weekKey) {
  let week = await CashflowWeek.findOne({ weekKey });
  if (!week) {
    const { start, end } = getWeekDates(weekKey);
    week = await CashflowWeek.create({
      weekKey,
      weekStart: start,
      weekEnd: end,
    });
  }
  return week;
}

/**
 * Get the full week summary for display.
 */
async function getWeekSummary(weekKey) {
  const config = await getConfig();
  const week = await getOrCreateWeek(weekKey);
  const { start, end } = getWeekDates(weekKey);

  // Aggregate payment revenue for the week
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
      },
    },
  ]);
  const revenueIn = revenueAgg[0]?.total || 0;

  // Daily revenue breakdown (Mon=1 ... Sun=7)
  const dailyRevenueAgg = await Payment.aggregate([
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
        _id: { $isoDayOfWeek: '$createdAt' },
        revenue: { $sum: '$amount' },
      },
    },
  ]);
  const dayLabels = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const dailyRevenue = dayLabels.map((label, i) => {
    const entry = dailyRevenueAgg.find((d) => d._id === i + 1);
    return { day: label, revenue: entry?.revenue || 0 };
  });

  // Compute allocated total from config tiers
  const itemsPaid = week.itemsPaid ? Object.fromEntries(week.itemsPaid) : {};
  const flexAllocations = week.flexAllocations ? Object.fromEntries(week.flexAllocations) : {};

  let allocated = 0;
  const tierCards = config.tiers
    .sort((a, b) => a.priority - b.priority)
    .map((tier) => {
      const items = tier.items.map((item) => {
        const effectiveAmount = item.flex
          ? (flexAllocations[item.id] || item.amount)
          : item.amount;
        allocated += effectiveAmount;
        const paidInfo = itemsPaid[`${tier.id}.${item.id}`] || {};
        return {
          ...item,
          effectiveAmount,
          paid: paidInfo.paid || false,
          paidAt: paidInfo.paidAt || null,
          paidAmount: paidInfo.amount || 0,
          paidNotes: paidInfo.notes || '',
        };
      });

      const tierTotal = items.reduce((sum, it) => sum + it.effectiveAmount, 0);
      const tierPaid = items.filter((it) => it.paid).reduce((sum, it) => sum + it.paidAmount, 0);

      return {
        id: tier.id,
        name: tier.name,
        priority: tier.priority,
        color: tier.color,
        protected: tier.protected,
        total: tierTotal,
        paid: tierPaid,
        items,
      };
    });

  const remaining = config.weeklyTarget - revenueIn;
  const surplus = revenueIn - allocated;
  let status = 'on_track';
  if (revenueIn >= config.stretchTarget) {
    status = 'stretch_hit';
  } else if (revenueIn >= config.weeklyTarget) {
    status = 'target_hit';
  } else if (revenueIn < config.weeklyTarget * 0.5) {
    status = 'behind';
  }

  return {
    weekKey,
    weekStart: start,
    weekEnd: end,
    config: {
      weeklyTarget: config.weeklyTarget,
      stretchTarget: config.stretchTarget,
      debtBalances: config.debtBalances,
    },
    kpis: {
      revenueIn,
      remaining: Math.max(0, remaining),
      allocated,
      surplus,
      status,
    },
    dailyRevenue,
    tierCards,
  };
}

/**
 * Mark a tier item as paid for a given week.
 */
async function markPaid(weekKey, tierId, itemId, amount, notes, userId) {
  const config = await getConfig();
  const week = await getOrCreateWeek(weekKey);

  // Find the item in config
  const tier = config.tiers.find((t) => t.id === tierId);
  if (!tier) throw new AppError('Tier not found', 404);
  const item = tier.items.find((it) => it.id === itemId);
  if (!item) throw new AppError('Item not found', 404);

  const mapKey = `${tierId}.${itemId}`;
  week.itemsPaid.set(mapKey, {
    paid: true,
    paidAt: new Date(),
    amount,
    notes: notes || '',
    paidBy: userId,
  });
  week.updatedAt = new Date();
  await week.save();

  // Create expense ledger entry
  const ledgerData = {
    weekKey,
    tierId,
    tierName: tier.name,
    itemId,
    itemName: item.name,
    amount,
    paidBy: userId,
    notes: notes || '',
  };

  // Handle debt tracking
  if (item.debtTracking && item.debtKey) {
    const currentBalance = config.debtBalances[item.debtKey] || 0;
    const newBalance = Math.max(0, currentBalance - amount);

    await CashflowConfig.updateOne(
      {},
      {
        $set: {
          [`debtBalances.${item.debtKey}`]: newBalance,
          updatedAt: new Date(),
          updatedBy: userId,
        },
      }
    );

    ledgerData.debtKey = item.debtKey;
    ledgerData.debtBalanceAfter = newBalance;
  }

  await ExpenseLedger.create(ledgerData);

  return getWeekSummary(weekKey);
}

/**
 * Undo a mark-paid action for a week item.
 */
async function undoPaid(weekKey, tierId, itemId, userId) {
  const config = await getConfig();
  const week = await CashflowWeek.findOne({ weekKey });
  if (!week) throw new AppError('Week not found', 404);

  const mapKey = `${tierId}.${itemId}`;
  const paidInfo = week.itemsPaid.get(mapKey);
  if (!paidInfo || !paidInfo.paid) {
    throw new AppError('Item is not marked as paid', 400);
  }

  // Reverse debt tracking if applicable
  const tier = config.tiers.find((t) => t.id === tierId);
  const item = tier?.items.find((it) => it.id === itemId);
  if (item?.debtTracking && item.debtKey) {
    const currentBalance = config.debtBalances[item.debtKey] || 0;
    const restoredBalance = currentBalance + (paidInfo.amount || 0);

    await CashflowConfig.updateOne(
      {},
      {
        $set: {
          [`debtBalances.${item.debtKey}`]: restoredBalance,
          updatedAt: new Date(),
          updatedBy: userId,
        },
      }
    );
  }

  // Remove the paid entry
  week.itemsPaid.delete(mapKey);
  week.updatedAt = new Date();
  await week.save();

  // Remove the ledger entry for this week/item
  await ExpenseLedger.deleteOne({ weekKey, tierId, itemId });

  return getWeekSummary(weekKey);
}

/**
 * Set a flex zone allocation for an item.
 */
async function setFlexAllocation(weekKey, itemId, amount) {
  const week = await getOrCreateWeek(weekKey);

  week.flexAllocations.set(itemId, amount);
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
  const totalRevenue = revenueAgg[0]?.total || 0;
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
  const totalExpensesPaid = ledgerAgg[0]?.totalPaid || 0;

  // Config for allocation targets
  const config = await getConfig();
  const weekKeys = getWeekKeysBetween(start, end);
  const totalAllocated = config.tiers.reduce(
    (sum, t) => sum + t.items.reduce((s, i) => s + (i.amount || 0), 0),
    0
  ) * weekKeys.length;

  const weeklyBreakdown = weeklyRevenueAgg.map((w) => ({
    weekKey: `${w.year}-W${String(w._id).padStart(2, '0')}`,
    revenue: w.revenue,
  }));

  return {
    dateFrom: start,
    dateTo: end,
    weeksInRange: weekKeys.length,
    totalRevenue,
    paymentCount,
    totalAllocated,
    totalExpensesPaid,
    surplus: totalRevenue - totalAllocated,
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
