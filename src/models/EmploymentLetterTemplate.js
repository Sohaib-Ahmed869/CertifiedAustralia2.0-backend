const mongoose = require('mongoose');

// Mirrors ReferenceLetterTemplate — one admin-uploaded "Employment Details"
// template per qualification, handed to the student's employer to complete.
const employmentLetterTemplateSchema = new mongoose.Schema(
  {
    qualificationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Qualification',
      required: true,
    },
    fileName: {
      type: String,
      required: true,
    },
    fileType: {
      type: String,
      enum: ['doc', 'docx', 'pdf'],
      required: true,
    },
    googleDriveFileId: {
      type: String,
      required: true,
    },
    googleDriveLink: {
      type: String,
      required: true,
    },
    version: {
      type: Number,
      default: 1,
    },
    uploadedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    uploadedAt: {
      type: Date,
      default: Date.now,
    },
    notes: {
      type: String,
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

module.exports = mongoose.model('EmploymentLetterTemplate', employmentLetterTemplateSchema);
