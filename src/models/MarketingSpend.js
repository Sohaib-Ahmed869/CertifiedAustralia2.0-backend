const mongoose = require('mongoose');

const marketingSpendSchema = new mongoose.Schema(
  {
    platform: {
      type: String,
      required: true,
      enum: [
        'tiktok',
        'meta',
        'meta_paid',
        'meta_ads',
        'facebook',
        'facebook_ads',
        'instagram',
        'instagram_ads',
        'linkedin',
        'google',
        'linktree',
        'seo',
        'print',
        'print_qr',
        'mainline',
        'vip',
        'vip_line',
        'gabby',
        'gabby_line',
        'rsg',
        'edm_campaign_floor_pricing',
      ],
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
