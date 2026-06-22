const PaymentBatch = require('../models/PaymentBatch');
const RTOInvoice = require('../models/RTOInvoice');
const Application = require('../models/Application');
const AppError = require('../utils/AppError');

const POPULATE_FIELDS = [
  { path: 'items.applicationId', select: 'applicationId studentId status' },
  { path: 'items.rtoId', select: 'firstName lastName' },
  { path: 'items.rtoInvoiceId', select: 'invoiceId invoiceNumber totalAmount' },
  { path: 'approvedBy', select: 'firstName lastName' },
  { path: 'releasedBy', select: 'firstName lastName' },
];

/**
 * Generate batches from verified RTO invoices and overdue RTO payables.
 * Groups by week key.
 */
const generateBatch = async (weekKey) => {
  // Check if batch already exists
  let batch = await PaymentBatch.findOne({ weekKey });
  if (batch && batch.status !== 'draft') {
    throw new AppError('Batch for this week has already been processed', 400);
  }

  // Find verified/scheduled invoices for this week
  const invoices = await RTOInvoice.find({
    status: { $in: ['verified', 'scheduled'] },
    $or: [
      { batchWeekKey: weekKey },
      { batchWeekKey: { $exists: false } },
    ],
  }).lean();

  // Find applications past 21-day window without RTO payment
  const now = new Date();
  const overdueApps = await Application.find({
    rtoCompletionDeadline: { $lte: now },
    assignedRTOId: { $exists: true, $ne: null },
  }).populate('qualificationId', 'rtoCosts').lean();

  const items = [];

  // Add invoice items
  for (const inv of invoices) {
    items.push({
      rtoInvoiceId: inv._id,
      applicationId: inv.applicationId || undefined,
      rtoId: inv.rtoId || undefined,
      amount: inv.totalAmount || inv.amount || 0,
      status: 'pending',
    });

    // Mark invoice as scheduled for this batch
    await RTOInvoice.findByIdAndUpdate(inv._id, {
      batchWeekKey: weekKey,
      status: 'scheduled',
    });
  }

  const totalAmount = items.reduce((s, i) => s + i.amount, 0);

  if (!batch) {
    batch = await PaymentBatch.create({
      weekKey,
      items,
      totalAmount,
      status: 'draft',
    });
  } else {
    batch.items = items;
    batch.totalAmount = totalAmount;
    batch.updatedAt = new Date();
    await batch.save();
  }

  return PaymentBatch.findById(batch._id).populate(POPULATE_FIELDS).lean();
};

/**
 * List all batches.
 */
const list = async (query = {}) => {
  const filter = {};
  if (query.status) filter.status = query.status;

  const batches = await PaymentBatch.find(filter)
    .populate(POPULATE_FIELDS)
    .sort({ createdAt: -1 })
    .lean();

  // Classify urgency
  const now = new Date();
  return batches.map((b) => {
    const weekParts = b.weekKey.split('-W');
    const weekNum = parseInt(weekParts[1], 10);
    const currentWeek = getISOWeekNumber(now);
    const currentYear = now.getFullYear();
    const batchYear = parseInt(weekParts[0], 10);

    let urgency = 'upcoming';
    if (batchYear < currentYear || (batchYear === currentYear && weekNum < currentWeek - 1)) {
      urgency = 'overdue';
    } else if (batchYear === currentYear && weekNum === currentWeek - 1) {
      urgency = 'extremely_urgent';
    } else if (batchYear === currentYear && weekNum === currentWeek) {
      urgency = 'approaching';
    }

    return { ...b, urgency };
  });
};

function getISOWeekNumber(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
}

/**
 * Approve a batch (CEO approval step).
 */
const approve = async (id, userId) => {
  const batch = await PaymentBatch.findById(id);
  if (!batch) throw new AppError('Batch not found', 404);
  if (batch.status !== 'draft') throw new AppError('Only draft batches can be approved', 400);

  batch.status = 'approved';
  batch.approvedBy = userId;
  batch.approvedAt = new Date();
  batch.updatedAt = new Date();
  await batch.save();

  return PaymentBatch.findById(id).populate(POPULATE_FIELDS).lean();
};

/**
 * Release a batch for payment.
 */
const release = async (id, userId) => {
  const batch = await PaymentBatch.findById(id);
  if (!batch) throw new AppError('Batch not found', 404);
  if (batch.status !== 'approved') throw new AppError('Only approved batches can be released', 400);

  batch.status = 'released';
  batch.releasedBy = userId;
  batch.releasedAt = new Date();
  batch.updatedAt = new Date();
  await batch.save();

  // Mark all linked invoices as paid
  for (const item of batch.items) {
    if (item.rtoInvoiceId) {
      await RTOInvoice.findByIdAndUpdate(item.rtoInvoiceId, { status: 'paid' });
    }
    item.status = 'paid';
  }
  await batch.save();

  return PaymentBatch.findById(id).populate(POPULATE_FIELDS).lean();
};

/**
 * Complete a batch.
 */
const complete = async (id) => {
  const batch = await PaymentBatch.findById(id);
  if (!batch) throw new AppError('Batch not found', 404);
  if (batch.status !== 'released') throw new AppError('Only released batches can be completed', 400);

  batch.status = 'completed';
  batch.completedAt = new Date();
  batch.updatedAt = new Date();
  await batch.save();

  return PaymentBatch.findById(id).populate(POPULATE_FIELDS).lean();
};

/**
 * Get a single batch.
 */
const getById = async (id) => {
  const batch = await PaymentBatch.findById(id).populate(POPULATE_FIELDS).lean();
  if (!batch) throw new AppError('Batch not found', 404);
  return batch;
};

module.exports = { generateBatch, list, getById, approve, release, complete };
