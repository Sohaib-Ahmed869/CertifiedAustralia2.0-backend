const mongoose = require('mongoose');

const qualificationSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    industryId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Industry',
      required: true,
    },
    caPrice: {
      type: Number,
      required: true,
      min: 0,
    },
    rtoCosts: [
      {
        rtoName: {
          type: String,
          required: true,
          trim: true,
        },
        rtoCost: {
          type: Number,
          required: true,
          min: 0,
        },
        rtoId: {
          type: mongoose.Schema.Types.ObjectId,
          ref: 'RTO',
        },
        _id: false,
      },
    ],
    status: {
      type: String,
      enum: ['active', 'inactive'],
      default: 'active',
    },
    checklistId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Checklist',
    },
    referenceLetterTemplateId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ReferenceLetterTemplate',
    },
    // Document requirements (default same for all, can be overridden per application)
    requiredDocuments: {
      type: [String],
      default: [
        'Identity Verification',
        'Work Experience Certificate',
        'Educational Qualifications',
        'Reference Letter',
      ],
    },
    enableUnitByUnitUpload: {
      type: Boolean,
      default: false,
    },
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

module.exports = mongoose.model('Qualification', qualificationSchema);
