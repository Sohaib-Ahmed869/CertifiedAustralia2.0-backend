const RTOInvoice = require('../models/RTOInvoice');
const Application = require('../models/Application');
const User = require('../models/User');
const AppError = require('../utils/AppError');

const POPULATE_FIELDS = [
  { path: 'applicationId', select: 'applicationId studentId qualificationId status' },
  { path: 'rtoId', select: 'firstName lastName email' },
  { path: 'uploadedBy', select: 'firstName lastName' },
  { path: 'verifiedBy', select: 'firstName lastName' },
];

/**
 * Create an RTO invoice from an uploaded file.
 * In production, this would trigger OCR/AI extraction.
 * For now, we store the file reference and accept manual data entry.
 */
const createInvoice = async (data) => {
  const invoice = await RTOInvoice.create({
    ...data,
    status: data.extractedData ? 'extracted' : 'draft',
  });
  return RTOInvoice.findById(invoice._id).populate(POPULATE_FIELDS).lean();
};

/**
 * List invoices with optional filters.
 */
const list = async (query = {}) => {
  const filter = {};
  if (query.status) filter.status = query.status;
  if (query.rtoId) filter.rtoId = query.rtoId;
  if (query.applicationId) filter.applicationId = query.applicationId;
  if (query.batchWeekKey) filter.batchWeekKey = query.batchWeekKey;

  const page = parseInt(query.page, 10) || 1;
  const limit = parseInt(query.limit, 10) || 50;
  const skip = (page - 1) * limit;

  const [items, total] = await Promise.all([
    RTOInvoice.find(filter)
      .populate(POPULATE_FIELDS)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    RTOInvoice.countDocuments(filter),
  ]);

  return {
    items,
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
  };
};

/**
 * Get a single invoice by ID.
 */
const getById = async (id) => {
  const invoice = await RTOInvoice.findById(id).populate(POPULATE_FIELDS).lean();
  if (!invoice) throw new AppError('Invoice not found', 404);
  return invoice;
};

/**
 * Verify extracted data and map to application.
 * Moves status from draft/extracted → verified.
 */
const verify = async (id, { invoiceNumber, invoiceDate, dueDate, amount, taxAmount, totalAmount, description, applicationId, rtoId, notes, verifiedBy }) => {
  const invoice = await RTOInvoice.findById(id);
  if (!invoice) throw new AppError('Invoice not found', 404);
  if (invoice.status === 'paid') throw new AppError('Cannot modify a paid invoice', 400);

  if (invoiceNumber !== undefined) invoice.invoiceNumber = invoiceNumber;
  if (invoiceDate !== undefined) invoice.invoiceDate = invoiceDate;
  if (dueDate !== undefined) invoice.dueDate = dueDate;
  if (amount !== undefined) invoice.amount = amount;
  if (taxAmount !== undefined) invoice.taxAmount = taxAmount;
  if (totalAmount !== undefined) invoice.totalAmount = totalAmount;
  if (description !== undefined) invoice.description = description;
  if (applicationId !== undefined) invoice.applicationId = applicationId;
  if (rtoId !== undefined) invoice.rtoId = rtoId;
  if (notes !== undefined) invoice.notes = notes;

  invoice.status = 'verified';
  invoice.verifiedBy = verifiedBy;
  invoice.verifiedAt = new Date();

  await invoice.save();
  return RTOInvoice.findById(id).populate(POPULATE_FIELDS).lean();
};

/**
 * Schedule a verified invoice into a weekly batch.
 */
const schedule = async (id, weekKey) => {
  const invoice = await RTOInvoice.findById(id);
  if (!invoice) throw new AppError('Invoice not found', 404);
  if (invoice.status !== 'verified') throw new AppError('Only verified invoices can be scheduled', 400);

  invoice.batchWeekKey = weekKey;
  invoice.status = 'scheduled';
  await invoice.save();
  return RTOInvoice.findById(id).populate(POPULATE_FIELDS).lean();
};

/**
 * Mark an invoice as paid.
 */
const markPaid = async (id) => {
  const invoice = await RTOInvoice.findById(id);
  if (!invoice) throw new AppError('Invoice not found', 404);

  invoice.status = 'paid';
  await invoice.save();
  return RTOInvoice.findById(id).populate(POPULATE_FIELDS).lean();
};

/**
 * Reject an invoice.
 */
const reject = async (id, { rejectedBy, reason }) => {
  const invoice = await RTOInvoice.findById(id);
  if (!invoice) throw new AppError('Invoice not found', 404);

  invoice.status = 'rejected';
  invoice.rejectedBy = rejectedBy;
  invoice.rejectedAt = new Date();
  invoice.rejectionReason = reason || '';
  await invoice.save();
  return RTOInvoice.findById(id).populate(POPULATE_FIELDS).lean();
};

/**
 * Delete an invoice.
 */
const remove = async (id) => {
  const invoice = await RTOInvoice.findByIdAndDelete(id);
  if (!invoice) throw new AppError('Invoice not found', 404);
  return { message: 'Invoice deleted' };
};

/**
 * Auto-map invoice to application by searching for student/app references in extracted data.
 */
const autoMap = async (id) => {
  const invoice = await RTOInvoice.findById(id);
  if (!invoice) throw new AppError('Invoice not found', 404);

  const ext = invoice.extractedData || {};
  let matched = null;

  // Try to match by application reference (e.g., "APP10042")
  if (ext.applicationRef) {
    matched = await Application.findOne({ applicationId: ext.applicationRef }).lean();
  }

  // Try to match by student name
  if (!matched && ext.studentName) {
    const nameParts = ext.studentName.trim().split(/\s+/);
    if (nameParts.length >= 2) {
      const students = await User.find({
        firstName: new RegExp(nameParts[0], 'i'),
        lastName: new RegExp(nameParts[nameParts.length - 1], 'i'),
        role: 'Student',
      }).lean();
      if (students.length === 1) {
        matched = await Application.findOne({ studentId: students[0]._id }).lean();
      }
    }
  }

  if (matched) {
    invoice.applicationId = matched._id;
    await invoice.save();
  }

  return {
    matched: !!matched,
    application: matched ? { _id: matched._id, applicationId: matched.applicationId } : null,
  };
};

module.exports = {
  createInvoice,
  list,
  getById,
  verify,
  schedule,
  markPaid,
  reject,
  remove,
  autoMap,
};
