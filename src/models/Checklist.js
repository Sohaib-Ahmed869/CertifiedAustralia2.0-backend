const mongoose = require('mongoose');

const checklistSchema = new mongoose.Schema(
  {
    qualificationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Qualification',
    },
    industryId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Industry',
    },
    rawText: {
      type: String,
      default: '',
    },
    units: [
      {
        unitCode: {
          type: String,
          default: '',
        },
        unitTitle: {
          type: String,
          default: '',
        },
        evidenceItems: [
          {
            type: String,
          },
        ],
        _id: false,
      },
    ],
    createdAt: {
      type: Date,
      default: Date.now,
    },
    updatedAt: {
      type: Date,
      default: Date.now,
    },
  }
);

module.exports = mongoose.model('Checklist', checklistSchema);
