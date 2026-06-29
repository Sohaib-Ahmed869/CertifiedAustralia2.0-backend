const mongoose = require('mongoose');

const taskSchema = new mongoose.Schema(
  {
    scopeType: {
      type: String,
      enum: ['general', 'application', 'student'],
      default: 'general',
    },
    applicationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Application',
    },
    studentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    title: {
      type: String,
      required: true,
    },
    description: String,
    status: {
      type: String,
      enum: ['todo', 'in_progress', 'done'],
      default: 'todo',
    },
    priority: {
      type: String,
      enum: ['low', 'medium', 'high'],
      default: 'medium',
    },
    assignedTo: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    dueDate: Date,
    completedAt: Date,
    checklist: [
      {
        text: { type: String, required: true },
        completed: { type: Boolean, default: false },
        _id: { type: mongoose.Schema.Types.ObjectId, auto: true },
      },
    ],
    comments: [
      {
        text: { type: String, required: true },
        author: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
        authorName: String,
        createdAt: { type: Date, default: Date.now },
        _id: { type: mongoose.Schema.Types.ObjectId, auto: true },
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

taskSchema.index({ assignedTo: 1 });
taskSchema.index({ applicationId: 1 });
taskSchema.index({ studentId: 1 });
taskSchema.index({ status: 1 });

module.exports = mongoose.model('Task', taskSchema);
