const mongoose = require('mongoose');

const knowledgeBaseSchema = new mongoose.Schema({
  category: {
    type: String,
    required: true,
    index: true,
  },
  question: {
    type: String,
    required: true,
  },
  answer: {
    type: String,
    required: true,
  },
  // Tags for search matching
  tags: [String],
  // Which application stage this answer is relevant to (optional)
  applicationStage: {
    type: String,
    enum: [
      'New', 'WaitingForPayment', 'StudentIntakeForm', 'UploadDocuments',
      'DocumentsUploaded', 'StudentCompleted', 'SentToRTO',
      'WaitingForVerification', 'ReadyForRTOPayment', 'RTOInvoiceUploaded',
      'CertificateGenerated', 'CertificateIssued', null,
    ],
  },
  // Priority for matching (higher = more relevant)
  priority: {
    type: Number,
    default: 0,
  },
  // Audit
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
});

knowledgeBaseSchema.index({ question: 'text', answer: 'text', tags: 'text' });

module.exports = mongoose.model('KnowledgeBase', knowledgeBaseSchema);
