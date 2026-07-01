const mongoose = require('mongoose');

const expenseSchema = new mongoose.Schema({
  /* Student or company expense */
  expenseType: {
    type: String,
    enum: ['student', 'company'],
    default: 'student',
  },

  /* ── Student expense fields ── */
  applicationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Application' },
  studentName: String,
  qualification: String,
  rtoName: String,
  category: {
    type: String,
    enum: ['RTO Fee', 'Assessment Fee', 'Material Cost', 'Admin Fee', 'Other'],
    default: 'RTO Fee',
  },
  studentRevenue: { type: Number, default: 0, min: 0 },
  profit: { type: Number, default: 0 },

  /* ── Company expense fields ── */
  companyCategory: {
    type: String,
    enum: [
      'Rent & Utilities', 'Software & Subscriptions', 'Office Supplies',
      'Travel & Transport', 'Marketing & Advertising', 'Professional Services',
      'Insurance', 'Equipment', 'Salaries & Wages', 'Training & Development',
      'Telecommunications', 'Custom',
    ],
  },
  customCategory: String, // user-defined when companyCategory is 'Custom'
  description: String,    // description for company expenses

  /* ── Shared fields ── */
  rtoCost: { type: Number, required: true, min: 0 }, // amount for both types
  date: { type: Date, required: true },
  notes: String,
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

expenseSchema.index({ date: -1 });
expenseSchema.index({ rtoName: 1, date: -1 });
expenseSchema.index({ expenseType: 1, date: -1 });

expenseSchema.pre('save', function (next) {
  if (this.expenseType === 'company') {
    this.profit = -(this.rtoCost || 0);
    this.studentRevenue = 0;
  } else {
    this.profit = (this.studentRevenue || 0) - (this.rtoCost || 0);
  }
  next();
});

/* Validate studentName required for student expenses */
expenseSchema.pre('validate', function (next) {
  if (this.expenseType !== 'company' && !this.studentName) {
    this.invalidate('studentName', 'Student name is required for student expenses');
  }
  next();
});

module.exports = mongoose.model('Expense', expenseSchema);
