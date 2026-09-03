const mongoose = require('mongoose');

const marketingSpendSchema = new mongoose.Schema(
  {
    /**
     * A marketing source key (or one of its legacy aliases — see MarketingSource).
     *
     * This carried a hardcoded enum until the source registry moved to the
     * MarketingSource collection: a key added at runtime can never be in a compiled
     * enum, so the cockpit would have offered a row whose save failed Mongoose
     * validation. The gate did not disappear with it — `marketingSourceService
     * .assertValidSpendPlatform` runs on the one write path (`upsertMarketingSpend`),
     * because an unvalidated key holds money no platform card ever reads.
     */
    platform: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
    },
    amount: {
      type: Number,
      required: true,
      min: 0,
    },
    weekOf: {
      type: Date,
      required: true,
      index: true,
    },
    notes: {
      type: String,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    createdAt: {
      type: Date,
      default: Date.now,
    },
    updatedAt: {
      type: Date,
      default: Date.now,
    },
  }
);

module.exports = mongoose.model('MarketingSpend', marketingSpendSchema);
