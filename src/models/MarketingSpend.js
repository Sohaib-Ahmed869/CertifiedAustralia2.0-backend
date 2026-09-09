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
    /**
     * The `AdCampaign.key` this money was spent on, or NULL for platform-level
     * spend that isn't attributed to a specific campaign.
     *
     * NULL IS A REAL, SUPPORTED VALUE, not a migration gap. Every row written
     * before campaigns existed has no campaign and must keep counting toward its
     * platform, and staff can still book untagged platform spend afterwards. So
     * a platform's total is the sum of its campaign rows PLUS its untagged rows,
     * and campaign rows are a strict subdivision — never a replacement.
     *
     * That is also why the uniqueness key is (platform, campaignKey, week) and
     * why every write path scopes on campaignKey: without it, clearing a
     * campaign's cell would delete the platform-level row sitting in the same
     * week. A Mongo equality match on `null` matches missing fields too, which
     * is exactly the back-compat behaviour the legacy rows need.
     */
    campaignKey: {
      type: String,
      trim: true,
      lowercase: true,
      default: null,
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

// One cell per (platform, campaign, week). Not unique — `upsertMarketingSpend`
// already guarantees one row per cell via a range-matched upsert, and a unique
// index across a nullable field plus a date RANGE cannot express that rule.
marketingSpendSchema.index({ platform: 1, campaignKey: 1, weekOf: 1 });

module.exports = mongoose.model('MarketingSpend', marketingSpendSchema);
