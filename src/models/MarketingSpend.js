const mongoose = require('mongoose');

const marketingSpendSchema = new mongoose.Schema(
  {
    platform: {
      type: String,
      required: true,
      enum: [
        'tiktok',
        'meta_paid',
        'meta_ads',
        'linkedin',
        'google',
        'print_qr',
        'mainline',
        'vip_line',
        'gabby_line',
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
