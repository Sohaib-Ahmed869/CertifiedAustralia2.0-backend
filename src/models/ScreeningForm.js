const mongoose = require('mongoose');

// Options for "How did you hear about us?" on the initial screening form.
// Mirror any change in the frontend RegisterPage / RegisterCustomerPage lists —
// the enum rejects anything not in here.
const HEAR_ABOUT_OPTIONS = [
  'Google',
  'Facebook',
  'Instagram',
  'TikTok',
  'YouTube',
  'Twitter / X',
  'LinkedIn',
  'A friend or colleague',
  'My employer',
  'Newspaper or magazine',
  'Other',
];

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
    // Lead attribution — self-reported at sign-up. Distinct from
    // `sourceAttribution` (campaign tags carried on the register URL): this is
    // what the student says, not what the link says.
    howDidYouHear: {
      type: String,
      enum: HEAR_ABOUT_OPTIONS,
    },
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
module.exports.HEAR_ABOUT_OPTIONS = HEAR_ABOUT_OPTIONS;
