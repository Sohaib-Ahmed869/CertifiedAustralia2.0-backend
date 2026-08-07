const mongoose = require('mongoose');

const intakeFormSchema = new mongoose.Schema(
  {
    applicationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Application',
      required: true,
    },
    // Personal Information
    firstName: {
      type: String,
      required: true,
    },
    middleName: String,
    surname: {
      type: String,
      required: true,
    },
    usi: String,
    // Personal Details
    gender: String,
    dateOfBirth: Date,
    // Address Information
    streetAddress: {
      type: String,
      required: true,
    },
    suburb: {
      type: String,
      required: true,
    },
    postcode: {
      type: String,
      required: true,
    },
    state: {
      type: String,
      required: true,
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
    },
    // Contact Information
    phoneNumber: {
      type: String,
      required: true,
    },
    email: {
      type: String,
      required: true,
    },
    countryOfBirth: String,
    englishLevel: String,
    // Additional Information
    isAustralianCitizen: Boolean,
    isAboriginalOrTorresStrait: Boolean,
    hasDisability: Boolean,
    // Education & Employment
    previousQualifications: String,
    employmentStatus: String,
    // Employment Details
    businessName: String,
    position: String,
    employerLegalName: String,
    employerPhone: String,
    employerAddress: String,
    // Credits Transfer
    hasCreditToTransfer: Boolean,
    creditQualificationName: String,
    creditYearCompleted: Number,
    // Student agreement acknowledgement (student consents on submit; admin can set when filling on behalf)
    agreementAccepted: Boolean,
    status: {
      type: String,
      enum: ['incomplete', 'submitted', 'approved', 'rejected'],
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

module.exports = mongoose.model('IntakeForm', intakeFormSchema);
