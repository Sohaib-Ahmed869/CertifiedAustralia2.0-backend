const mongoose = require('mongoose');

const messageSchema = new mongoose.Schema(
  {
    content: {
      type: String,
      required: true,
    },
    senderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    senderRole: {
      type: String,
    },
    isInternal: {
      type: Boolean,
      default: false,
    },
    attachments: [
      {
        fileName: String,
        fileUrl: String,
        fileType: String,
      },
    ],
    createdAt: {
      type: Date,
      default: Date.now,
    },
  },
  { _id: true }
);

const ticketSchema = new mongoose.Schema(
  {
    ticketId: {
      type: String,
      unique: true,
      required: true,
    },
    title: {
      type: String,
      required: true,
    },
    description: {
      type: String,
      required: true,
    },
    type: {
      type: String,
      enum: ['issue', 'query'],
      required: true,
    },
    category: {
      type: String,
      enum: [
        'intake_form',
        'documents',
        'payments',
        'technical',
        'rto_support',
        'general',
        'other',
      ],
      default: 'general',
    },
    priority: {
      type: String,
      enum: ['low', 'medium', 'high', 'urgent'],
      default: 'medium',
    },
    status: {
      type: String,
      enum: ['open', 'in_progress', 'waiting_on_customer', 'resolved', 'closed', 'escalated'],
      default: 'open',
    },
    source: {
      type: String,
      enum: ['student', 'rto', 'chatbot', 'portal'],
      required: true,
    },
    requesterId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    assignedTo: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    applicationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Application',
    },
    chatbotTranscript: [
      {
        role: String,
        content: String,
        timestamp: { type: Date, default: Date.now },
      },
    ],
    messages: [messageSchema],
    firstResponseAt: {
      type: Date,
    },
    resolvedAt: {
      type: Date,
    },
    closedAt: {
      type: Date,
    },
  },
  {
    timestamps: true,
  }
);

ticketSchema.index({ requesterId: 1 });
ticketSchema.index({ assignedTo: 1 });
ticketSchema.index({ status: 1 });
ticketSchema.index({ ticketId: 1 }, { unique: true });

module.exports = mongoose.model('Ticket', ticketSchema);
