const mongoose = require('mongoose');

const emailTemplateSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },
    subject: {
      type: String,
      required: true,
      trim: true,
    },
    body: {
      type: String,
      required: true,
    },
    category: {
      type: String,
      enum: ['application', 'payment', 'notification', 'marketing', 'system'],
      default: 'system',
    },
    variables: {
      type: [String],
      default: [],
    },
    active: {
      type: Boolean,
      default: true,
    },
  },
  {
    timestamps: true,
  }
);

emailTemplateSchema.index({ category: 1 });
emailTemplateSchema.index({ name: 1 }, { unique: true });

module.exports = mongoose.model('EmailTemplate', emailTemplateSchema);
