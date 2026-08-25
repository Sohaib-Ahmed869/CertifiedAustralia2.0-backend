const mongoose = require('mongoose');

const emailTemplateSchema = new mongoose.Schema(
  {
    // NOT unique. A template name is a label, nothing looks a template up by it,
    // and the legacy portal allowed duplicates — the unique index only ever showed
    // up as an unexplained "failed to save" when staff reused a naming pattern.
    // (Run scripts/drop-email-template-name-index.js once to drop the old index.)
    name: {
      type: String,
      required: true,
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
emailTemplateSchema.index({ name: 1 });

module.exports = mongoose.model('EmailTemplate', emailTemplateSchema);
