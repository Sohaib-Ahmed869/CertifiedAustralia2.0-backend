const RTOInvoice = require('../models/RTOInvoice');
const Application = require('../models/Application');
const Document = require('../models/Document');
const Payment = require('../models/Payment');
const User = require('../models/User');
const AppError = require('../utils/AppError');

let googleDriveService;
try { googleDriveService = require('./googleDriveService'); } catch { /* optional */ }

const POPULATE_FIELDS = [
  { path: 'applicationId', select: 'applicationId studentId qualificationId status' },
  { path: 'rtoId', select: 'firstName lastName email' },
  { path: 'uploadedBy', select: 'firstName lastName' },
  { path: 'verifiedBy', select: 'firstName lastName' },
];

// Fields an admin may correct on an already-uploaded invoice.
const EDITABLE_FIELDS = [
  'invoiceNumber', 'invoiceDate', 'dueDate', 'amount', 'taxAmount',
  'totalAmount', 'description', 'notes', 'rtoId', 'applicationId',
];

/**
 * A paid invoice is a financial record — correcting it is a batch reversal
 * (`paymentBatchService.markItemUnpaid`), never an edit or a delete.
 */
const assertCorrectable = (invoice, verb) => {
  if (invoice.status === 'paid') {
    throw new AppError(
      `This invoice has already been paid and cannot be ${verb}. Reverse the batch payment first.`,
      400
    );
  }
};

/**
 * Queue an invoice into its batch week. Non-fatal by design: an upload must
 * never fail because the payment queue hiccuped — the daily
 * `paymentBatchService.reconcile()` cron sweeps up anything that slipped.
 */
const syncToBatch = async (invoiceId) => {
  try {
    await require('./paymentBatchService').assignInvoice(invoiceId);
  } catch (err) {
    console.error('[RTOInvoice] Batch assignment failed:', err.message);
  }
};

/**
 * Drop the file currently attached to an invoice: the Drive object and, when the
 * invoice was uploaded from the student detail page, the Document row that
 * points at the same file. Both uploads paths are covered — the finance page
 * stores only a `googleDriveFileId`, so the Document is looked up by that id
 * when no `documentId` was recorded.
 *
 * Best-effort by design: a Drive hiccup must not block the admin from
 * correcting a wrong invoice. The worst case is an orphaned file on Drive.
 */
const detachFile = async (invoice) => {
  const driveId = invoice.googleDriveFileId;

  try {
    const doc = invoice.documentId
      ? await Document.findById(invoice.documentId)
      : (driveId ? await Document.findOne({ googleDriveFileId: driveId }) : null);

    if (doc) {
      await Document.findByIdAndDelete(doc._id);
      if (doc.applicationId) {
        await Application.findByIdAndUpdate(doc.applicationId, { $pull: { documentIds: doc._id } });
      }
    }
  } catch (err) {
    console.error('[RTOInvoice] Failed to remove linked document:', err.message);
  }

  if (driveId && googleDriveService) {
    await googleDriveService.deleteFile(driveId).catch((err) => {
      console.error('[RTOInvoice] Failed to delete Drive file:', err.message);
    });
  }
};

/**
 * Undo what uploading this invoice did to its application.
 *
 * Uploading is what stops the 21-day KPI clock, advances the journey stage and
 * raises the pending RTO payable — so a wrong invoice leaves the application
 * looking assessed, the KPI frozen at a bogus figure and a payable in the AP
 * queue for money nobody owes. Only runs when this was the application's last
 * live invoice; a second, correct invoice keeps the application where it is.
 */
const revertApplicationAfterRemoval = async (invoice, { reason, actor } = {}) => {
  const applicationId = invoice.applicationId;
  if (!applicationId) return;

  // Another live invoice still justifies the RTOInvoiceUploaded state.
  const remaining = await RTOInvoice.countDocuments({
    _id: { $ne: invoice._id },
    applicationId,
    status: { $ne: 'rejected' },
  });
  if (remaining > 0) return;

  const app = await Application.findById(applicationId).select('status statusHistory').lean();
  if (!app || app.status !== 'RTOInvoiceUploaded') return;

  // Go back to whatever stage the application was at before the upload.
  const history = app.statusHistory || [];
  const idx = history.findIndex((h) => h?.status === 'RTOInvoiceUploaded');
  const previous = idx > 0 ? history[idx - 1]?.status : null;
  const target = previous && previous !== 'RTOInvoiceUploaded' ? previous : 'ReadyForRTOPayment';

  // Restart the KPI clock — the assessment was never actually invoiced, so the
  // 21-day count must keep running from where it left off.
  await Application.findByIdAndUpdate(
    applicationId,
    { status: target, timerStoppedAt: null, timerDaysElapsed: null },
    { runValidators: true }
  );

  // The transition that just got undone was never real, so it must not survive
  // as a stage date on the Timeline tab. Separate write: Mongo refuses a $push
  // (added by the status-history hook above) and a $pull on the same path.
  await Application.updateOne(
    { _id: applicationId },
    { $pull: { statusHistory: { status: 'RTOInvoiceUploaded' } } }
  );

  // Void the auto-created payable so Supplier Liability and the AP totals stop
  // counting it. Reversed rather than deleted — it is a financial record.
  try {
    const payable = await Payment.findOne({
      applicationId,
      type: 'rtoPayable',
      status: 'pending',
    }).sort('-createdAt');

    if (payable) {
      payable.status = 'reversed';
      payable.notes = `${payable.notes || ''}\nReversed — RTO invoice ${invoice.invoiceId} removed${reason ? `: ${reason}` : ''}.`.trim();
      await payable.save();
    }
  } catch (err) {
    console.error('[RTOInvoice] Failed to reverse RTO payable:', err.message);
  }

  // Financial actions need a trail, and a deleted invoice leaves none of its own.
  try {
    await Application.findByIdAndUpdate(applicationId, {
      $push: {
        notes: {
          content: `RTO invoice ${invoice.invoiceId}${invoice.invoiceNumber ? ` (#${invoice.invoiceNumber})` : ''} was removed${reason ? `: ${reason}` : ''}. Status reverted to ${target} and the 21-day timer resumed.`,
          addedBy: actor?._id,
          authorRole: actor?.role,
          authorName: actor ? `${actor.firstName || ''} ${actor.lastName || ''}`.trim() : undefined,
          visibility: 'admin',
        },
      },
    });
  } catch (err) {
    console.error('[RTOInvoice] Failed to write removal note:', err.message);
  }
};

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

  // Advance the linked application to RTOInvoiceUploaded if eligible
  // Mirrors old project: invoice upload allowed from StudentCompleted or ReadyForRTOPayment
  if (data.applicationId) {
    const app = await Application.findById(data.applicationId).select('status').lean();
    const invoiceEligibleStatuses = ['StudentCompleted', 'SentToRTO', 'WaitingForVerification', 'ReadyForRTOPayment'];
    if (app && invoiceEligibleStatuses.includes(app.status)) {
      const applicationService = require('./applicationService');
      await applicationService.updateStatus(data.applicationId, 'RTOInvoiceUploaded');
    }
  }

  // Uploading the invoice stops the 21-day timer — that instant decides which
  // batch week this payable falls into.
  await syncToBatch(invoice._id);

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
 * Correct an already-uploaded invoice: edit its details and/or swap the file
 * for the right one, keeping the same invoice record, the same batch row and
 * the same application state.
 *
 * This is the safe half of the "wrong invoice" fix — nothing about the
 * application's journey stage, KPI timer or payable is disturbed, because the
 * invoice itself is still valid, only its contents were wrong. Removing is for
 * when the invoice should never have existed at all.
 */
const update = async (id, data = {}, { file, actor } = {}) => {
  const invoice = await RTOInvoice.findById(id);
  if (!invoice) throw new AppError('Invoice not found', 404);
  assertCorrectable(invoice, 'edited');

  // A caller echoing back the file it already has is an edit, not a swap —
  // treating it as one would delete the file and then point at the dead id.
  const isNewFile = file && (
    !invoice.googleDriveFileId || file.googleDriveFileId !== invoice.googleDriveFileId
  );

  if (isNewFile) {
    // Record what we are about to throw away, then drop the old file. Ordering
    // is deliberate: the replacement is already on Drive by the time we get
    // here (the route uploads it first), so a failure here can never leave the
    // invoice with no file at all.
    invoice.replacedFiles.push({
      originalFileName: invoice.originalFileName,
      googleDriveFileId: invoice.googleDriveFileId,
      replacedAt: new Date(),
      replacedBy: actor?._id,
    });
    await detachFile(invoice);

    invoice.originalFileName = file.originalFileName;
    invoice.originalFileUrl = file.originalFileUrl;
    invoice.googleDriveFileId = file.googleDriveFileId;
    invoice.documentId = file.documentId || undefined;
  }

  EDITABLE_FIELDS.forEach((key) => {
    if (data[key] !== undefined) invoice[key] = data[key] === '' ? undefined : data[key];
  });

  await invoice.save();

  // Amount, RTO and application may all have moved — refresh the queued row so
  // the pay run bills what the corrected invoice actually says.
  await syncToBatch(id);

  return RTOInvoice.findById(id).populate(POPULATE_FIELDS).lean();
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

  // Verification confirms the amount and the application mapping — refresh the
  // queued row and flip it to ready for payment.
  await syncToBatch(id);

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

  // A rejected invoice must not sit in a payment queue. Throws if it was
  // already paid — that needs a batch reversal, not a rejection.
  await require('./paymentBatchService').removeInvoice(id);

  return RTOInvoice.findById(id).populate(POPULATE_FIELDS).lean();
};

/**
 * Delete an invoice uploaded in error, and undo everything the upload did.
 *
 * The order matters: refuse first, unqueue second, and only delete the record
 * once the application has been put back — a crash midway then leaves an
 * invoice that the daily `reconcile()` cron re-queues, which is recoverable.
 * Deleting first would strand the application at RTOInvoiceUploaded with a
 * stopped timer and no invoice to explain it.
 */
const remove = async (id, { reason, actor } = {}) => {
  const invoice = await RTOInvoice.findById(id).lean();
  if (!invoice) throw new AppError('Invoice not found', 404);
  assertCorrectable(invoice, 'removed');

  // Pull it out of its batch week — removeInvoice refuses if the row has
  // already been paid, so a settled pay run can't be deleted out from under us.
  await require('./paymentBatchService').removeInvoice(id);

  await revertApplicationAfterRemoval(invoice, { reason, actor });
  await detachFile(invoice);

  await RTOInvoice.findByIdAndDelete(id);
  return { message: 'Invoice removed' };
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
    // The row now has an application — refresh its student/qualification/date columns.
    await syncToBatch(id);
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
  update,
  verify,
  schedule,
  markPaid,
  reject,
  remove,
  autoMap,
};
