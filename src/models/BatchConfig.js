const mongoose = require('mongoose');

/**
 * BatchConfig — single-document settings for the RTO batch payment queue.
 *
 * The one setting that actually changes behaviour is `weekEndingDay`: it decides
 * which "BATCH WEEK ENDING" bucket an uploaded RTO invoice lands in. The client's
 * workbook runs Friday pay weeks (5), but it is stored rather than hardcoded so
 * the pay-run day can move without a redeploy.
 *
 * Changing it does NOT re-bucket existing batches — weeks already generated keep
 * their rows so a historical pay run is never silently rewritten. New invoices
 * bucket on the new day; `paymentBatchService.reconcile()` reports the drift.
 */
const batchConfigSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true, default: 'default' },

    // 0 = Sunday … 6 = Saturday. 5 (Friday) matches the client's sheet.
    weekEndingDay: { type: Number, default: 5, min: 0, max: 6 },

    // Rows within this many days of their eligibility date show as "Due Soon".
    dueSoonDays: { type: Number, default: 5, min: 0, max: 60 },

    // Auto-assign uploaded RTO invoices into their batch week. Off = manual only.
    autoAssign: { type: Boolean, default: true },

    // Require the week to be CEO-approved before any row can be marked paid.
    requireApprovalBeforePayment: { type: Boolean, default: true },

    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model('BatchConfig', batchConfigSchema);
