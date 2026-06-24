const mongoose = require('mongoose');

const expenseSchema = new mongoose.Schema({
  applicationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Application' },
  studentName: { type: String, required: true },
  qualification: String,
  rtoName: String,
  category: {
    type: String,
    enum: ['RTO Fee', 'Assessment Fee', 'Material Cost', 'Admin Fee', 'Other'],
    default: 'RTO Fee',
  },
  rtoCost: { type: Number, required: true, min: 0 },
  studentRevenue: { type: Number, required: true, min: 0 },
  profit: { type: Number, default: 0 },
  date: { type: Date, required: true },
  notes: String,
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

expenseSchema.index({ date: -1 });
expenseSchema.index({ rtoName: 1, date: -1 });

expenseSchema.pre('save', function (next) {
  this.profit = (this.studentRevenue || 0) - (this.rtoCost || 0);
  next();
});

module.exports = mongoose.model('Expense', expenseSchema);
