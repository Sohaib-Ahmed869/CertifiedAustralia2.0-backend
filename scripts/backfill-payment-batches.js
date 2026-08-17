/**
 * Backfill the RTO batch payment queue.
 *
 * Batch weeks are built automatically when an RTO invoice is uploaded, so any
 * invoice uploaded BEFORE that behaviour shipped (Aug 2026) has no row. This
 * sweeps every existing RTO invoice into its batch week, bucketed by the week
 * its upload falls in — exactly what the live hook does, just retroactively.
 *
 * Safe to re-run: assignment is keyed on rtoInvoiceId and paid rows are frozen.
 *
 *   node scripts/backfill-payment-batches.js            # dry run — reports only
 *   node scripts/backfill-payment-batches.js --apply    # writes
 *   node scripts/backfill-payment-batches.js --apply --drop-empty
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const mongoose = require('mongoose');

const APPLY = process.argv.includes('--apply');
const DROP_EMPTY = process.argv.includes('--drop-empty');

(async () => {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('MONGODB_URI is not set — check certfied-australia-v2-be/.env');
    process.exit(1);
  }

  await mongoose.connect(uri);
  console.log('Connected to MongoDB\n');

  const RTOInvoice = require('../src/models/RTOInvoice');
  const PaymentBatch = require('../src/models/PaymentBatch');
  const paymentBatchService = require('../src/services/paymentBatchService');
  const { weekKeyFor, formatWeekKey } = require('../src/utils/batchWeek');

  const cfg = await paymentBatchService.getConfig();
  const dayName = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][cfg.weekEndingDay];
  console.log(`Batch weeks end on ${dayName} (weekEndingDay=${cfg.weekEndingDay})\n`);

  const invoices = await RTOInvoice.find({ status: { $ne: 'rejected' } })
    .select('_id invoiceId invoiceNumber status createdAt totalAmount amount')
    .sort({ createdAt: 1 })
    .lean();

  console.log(`${invoices.length} RTO invoice(s) found.\n`);

  const preview = {};
  let alreadyQueued = 0;

  for (const inv of invoices) {
    const existing = await PaymentBatch.findOne({ 'items.rtoInvoiceId': inv._id }).select('weekKey').lean();
    if (existing) { alreadyQueued += 1; continue; }
    const weekKey = weekKeyFor(inv.createdAt, cfg.weekEndingDay);
    preview[weekKey] = preview[weekKey] || { count: 0, amount: 0 };
    preview[weekKey].count += 1;
    preview[weekKey].amount += inv.totalAmount || inv.amount || 0;
  }

  const weeks = Object.keys(preview).sort();
  if (!weeks.length) {
    console.log(`Nothing to backfill — all ${alreadyQueued} invoice(s) are already queued.`);
  } else {
    console.log('Week ending      Rows   Amount');
    console.log('------------------------------------');
    for (const w of weeks) {
      console.log(`${formatWeekKey(w).padEnd(14)}  ${String(preview[w].count).padStart(4)}   $${preview[w].amount.toLocaleString('en-AU')}`);
    }
    console.log('------------------------------------');
    console.log(`${weeks.length} batch week(s), ${alreadyQueued} invoice(s) already queued.\n`);
  }

  if (!APPLY) {
    console.log('Dry run — nothing written. Re-run with --apply to write.');
    await mongoose.disconnect();
    return;
  }

  const result = await paymentBatchService.reconcile({ force: true });
  console.log(`Reconcile: ${result.added} queued, ${result.refreshed} refreshed, ${result.skipped} skipped, ${result.errors.length} error(s)`);
  for (const e of result.errors) console.error(`  ! ${e.invoiceId}: ${e.message}`);

  if (DROP_EMPTY) {
    // reconcile() always opens the current week — never delete that one.
    const { currentWeekKey } = require('../src/utils/batchWeek');
    const keep = currentWeekKey(cfg.weekEndingDay);
    const del = await PaymentBatch.deleteMany({ items: { $size: 0 }, weekKey: { $ne: keep }, status: 'draft' });
    console.log(`Dropped ${del.deletedCount} empty draft week(s).`);
  }

  const total = await PaymentBatch.countDocuments();
  console.log(`\nDone — ${total} batch week(s) in the queue.`);
  await mongoose.disconnect();
})().catch(async (err) => {
  console.error('Backfill failed:', err);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
