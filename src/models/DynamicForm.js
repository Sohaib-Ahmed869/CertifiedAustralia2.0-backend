const mongoose = require('mongoose');

const fieldSchema = new mongoose.Schema(
  {
    fieldId: {
      type: String,
      required: true,
    },
    label: {
      type: String,
      required: true,
    },
    type: {
      type: String,
      enum: [
        'text', 'textarea', 'number', 'email', 'phone', 'date',
        'select', 'multiselect', 'radio', 'checkbox',
        'file', 'heading', 'paragraph',
      ],
      required: true,
    },
    placeholder: String,
    helpText: String,
    required: {
      type: Boolean,
      default: false,
    },
    options: [
      {
        label: String,
        value: String,
      },
    ],
    validations: {
      minLength: Number,
      maxLength: Number,
      min: Number,
      max: Number,
      pattern: String,
    },
    displayOrder: {
      type: Number,
      default: 0,
    },
    // For conditional fields
    conditionalOn: {
      fieldId: String,
      value: String,
    },
  },
  { _id: false }
);

const dynamicFormSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    description: {
      type: String,
      default: '',
    },
    fields: [fieldSchema],
    status: {
      type: String,
      enum: ['active', 'inactive', 'draft'],
      default: 'draft',
    },
    qualificationIds: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Qualification',
      },
    ],
    industryIds: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Industry',
      },
    ],
    filledBy: {
      type: String,
      enum: ['student', 'assessor', 'admin', 'any'],
      default: 'student',
    },
    isRequired: {
      type: Boolean,
      default: false,
    },
    displayOrder: {
      type: Number,
      default: 0,
    },
    version: {
      type: Number,
      default: 1,
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
  },
  { timestamps: true }
);

dynamicFormSchema.index({ status: 1 });
dynamicFormSchema.index({ qualificationIds: 1 });
dynamicFormSchema.index({ name: 'text', description: 'text' });

module.exports = mongoose.model('DynamicForm', dynamicFormSchema);
