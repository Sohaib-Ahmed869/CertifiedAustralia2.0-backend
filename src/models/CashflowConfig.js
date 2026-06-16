const mongoose = require('mongoose');

const cashflowItemSchema = new mongoose.Schema(
  {
    id: {
      type: String,
      required: true,
    },
    name: {
      type: String,
      required: true,
    },
    amount: {
      type: Number,
      required: true,
      default: 0,
    },
    debtTracking: {
      type: Boolean,
      default: false,
    },
    debtKey: {
      type: String,
    },
    flex: {
      type: Boolean,
      default: false,
    },
  },
  { _id: false }
);

const cashflowTierSchema = new mongoose.Schema(
  {
    id: {
      type: String,
      required: true,
    },
    name: {
      type: String,
      required: true,
    },
    priority: {
      type: Number,
      required: true,
    },
    color: {
      type: String,
    },
    protected: {
      type: Boolean,
      default: false,
    },
    items: [cashflowItemSchema],
  },
  { _id: false }
);

const cashflowConfigSchema = new mongoose.Schema(
  {
    weeklyTarget: {
      type: Number,
      default: 60000,
    },
    stretchTarget: {
      type: Number,
      default: 70000,
    },
    tiers: [cashflowTierSchema],
    debtBalances: {
      executive: {
        type: Number,
        default: 0,
      },
      dlk: {
        type: Number,
        default: 0,
      },
      bizcap: {
        type: Number,
        default: 0,
      },
      super: {
        type: Number,
        default: 0,
      },
    },
    updatedBy: {
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

module.exports = mongoose.model('CashflowConfig', cashflowConfigSchema);
