const mongoose = require('mongoose');

const formSubmissionSchema = new mongoose.Schema(
  {
    formId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'DynamicForm',
      required: true,
    },
    applicationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Application',
      required: true,
    },
    submittedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    data: {
      type: Map,
      of: mongoose.Schema.Types.Mixed,
      default: {},
    },
    status: {
      type: String,
      enum: ['draft', 'submitted', 'reviewed', 'approved', 'rejected'],
      default: 'draft',
    },
    reviewedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    reviewedAt: Date,
    reviewNotes: String,
  },
  { timestamps: true }
);

formSubmissionSchema.index({ formId: 1, applicationId: 1 });
formSubmissionSchema.index({ applicationId: 1 });
formSubmissionSchema.index({ submittedBy: 1 });

module.exports = mongoose.model('FormSubmission', formSubmissionSchema);
