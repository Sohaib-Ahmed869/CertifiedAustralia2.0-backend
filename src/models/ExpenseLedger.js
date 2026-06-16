const mongoose = require('mongoose');

const expenseLedgerSchema = new mongoose.Schema(
  {
    weekKey: {
      type: String,
      required: true,
      index: true,
    },
    tierId: {
      type: String,
      required: true,
    },
    tierName: {
      type: String,
    },
    itemId: {
      type: String,
      required: true,
    },
    itemName: {
      type: String,
    },
    amount: {
      type: Number,
      required: true,
    },
    paidAt: {
      type: Date,
      default: Date.now,
    },
    paidBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    notes: {
      type: String,
    },
    debtKey: {
      type: String,
    },
    debtBalanceAfter: {
      type: Number,
    },
    createdAt: {
      type: Date,
      default: Date.now,
    },
  }
);

module.exports = mongoose.model('ExpenseLedger', expenseLedgerSchema);
