const mongoose = require('mongoose');

const rtoInvoiceSchema = new mongoose.Schema({
  // Auto-generated ID (INV10000 format)
  invoiceId: {
    type: String,
    unique: true,
    index: true,
  },
  // Linked application (mapped after extraction)
  applicationId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Application',
  },
  // RTO who issued the invoice
  rtoId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
  },
  // Invoice details (extracted or manually entered)
  invoiceNumber: String,
  invoiceDate: Date,
  dueDate: Date,
  amount: {
    type: Number,
    min: 0,
  },
  taxAmount: {
    type: Number,
    default: 0,
    min: 0,
  },
  totalAmount: {
    type: Number,
    min: 0,
  },
  description: String,
  // File storage
  originalFileName: String,
  originalFileUrl: String,
  googleDriveFileId: String,
  // Data extracted from the uploaded file
  extractedData: {
    raw: String,
    invoiceNumber: String,
    date: String,
    amount: String,
    rtoName: String,
    studentName: String,
    applicationRef: String,
    confidence: {
      type: Number,
      min: 0,
      max: 100,
    },
  },
  // Workflow status
  status: {
    type: String,
    enum: ['draft', 'extracted', 'verified', 'scheduled', 'paid', 'rejected'],
    default: 'draft',
  },
  // Batch scheduling
  batchWeekKey: String,
  // Audit
  uploadedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
  },
  verifiedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
  },
  verifiedAt: Date,
  rejectedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
  },
  rejectedAt: Date,
  rejectionReason: String,
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

// Auto-generate invoice ID
rtoInvoiceSchema.pre('save', async function (next) {
  if (!this.invoiceId) {
    const last = await this.constructor.findOne().sort('-createdAt').lean();
    if (!last || !last.invoiceId) {
      this.invoiceId = 'INV10000';
    } else {
      const num = parseInt(last.invoiceId.replace('INV', ''), 10);
      this.invoiceId = `INV${num + 1}`;
    }
  }
  this.updatedAt = new Date();
  next();
});

module.exports = mongoose.model('RTOInvoice', rtoInvoiceSchema);
