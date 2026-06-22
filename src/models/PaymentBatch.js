const mongoose = require('mongoose');

const batchItemSchema = new mongoose.Schema({
  rtoInvoiceId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'RTOInvoice',
  },
  applicationId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Application',
  },
  rtoId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
  },
  amount: {
    type: Number,
    required: true,
    min: 0,
  },
  status: {
    type: String,
    enum: ['pending', 'paid', 'skipped'],
    default: 'pending',
  },
}, { _id: true });

const paymentBatchSchema = new mongoose.Schema({
  weekKey: {
    type: String,
    required: true,
    index: true,
  },
  items: [batchItemSchema],
  totalAmount: {
    type: Number,
    default: 0,
    min: 0,
  },
  status: {
    type: String,
    enum: ['draft', 'approved', 'released', 'completed'],
    default: 'draft',
  },
  approvedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
  },
  approvedAt: Date,
  releasedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
  },
  releasedAt: Date,
  completedAt: Date,
  notes: String,
  createdAt: {
    type: Date,
    default: Date.now,
    index: true,
  },
  updatedAt: {
    type: Date,
    default: Date.now,
  },
});

module.exports = mongoose.model('PaymentBatch', paymentBatchSchema);
