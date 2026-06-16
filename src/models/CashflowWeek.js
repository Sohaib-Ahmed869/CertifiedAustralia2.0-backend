const mongoose = require('mongoose');

const paidItemSchema = new mongoose.Schema(
  {
    paid: {
      type: Boolean,
    },
    paidAt: {
      type: Date,
    },
    amount: {
      type: Number,
    },
    notes: {
      type: String,
    },
    paidBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
  },
  { _id: false }
);

const cashflowWeekSchema = new mongoose.Schema(
  {
    weekKey: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    weekStart: {
      type: Date,
    },
    weekEnd: {
      type: Date,
    },
    itemsPaid: {
      type: Map,
      of: paidItemSchema,
      default: () => new Map(),
    },
    flexAllocations: {
      type: Map,
      of: Number,
      default: () => new Map(),
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

module.exports = mongoose.model('CashflowWeek', cashflowWeekSchema);
