const mongoose = require('mongoose');

const screeningFormSchema = new mongoose.Schema(
  {
    applicationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Application',
      required: true,
    },
    // Industry & Qualification
    industryId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Industry',
      required: true,
    },
    qualificationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Qualification',
      required: true,
    },
    // Your Experience
    yearsOfExperience: {
      type: String,
      enum: ['1-2 years', '3-4 years', '5-9 years', '10+ years'],
      required: true,
    },
    experienceLocation: {
      type: String,
      enum: ['Australia', 'Overseas', 'Both'],
      required: true,
    },
    // Your Location
    state: {
      type: String,
      enum: [
        'NSW',
        'VIC',
        'QLD',
        'SA',
        'WA',
        'ACT',
        'NT',
        'TAS',
      ],
      required: true,
    },
    // Educational Background
    hasFormalQualifications: Boolean,
    formalQualifications: [String],
    status: {
      type: String,
      enum: ['incomplete', 'submitted'],
      default: 'incomplete',
    },
    submittedAt: Date,
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

module.exports = mongoose.model('ScreeningForm', screeningFormSchema);
