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
      'LeadCaptured', 'ScreeningCompleted', 'AgentAssigned', 'PaymentPending',
      'PaymentCompleted', 'IntakeFormCompleted', 'DocumentsUploaded',
      'SubmissionReview', 'ResubmissionRequired', 'SentToRTO', 'RTOReview',
      'RTOFeedback', 'RTOCompleted', 'CertificateIssued', 'InDelivery',
      'Delivered', 'Archived', null,
    ],
  },
  // OpenAI embedding vector for semantic search
  embedding: {
    type: [Number],
    default: undefined,
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
