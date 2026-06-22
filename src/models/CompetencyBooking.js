const mongoose = require('mongoose');

const competencyBookingSchema = new mongoose.Schema({
  applicationId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Application',
    required: true,
  },
  studentId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  assessorId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },
  scheduledAt: {
    type: Date,
    required: true,
    index: true,
  },
  durationMinutes: {
    type: Number,
    default: 30,
  },
  status: {
    type: String,
    enum: ['scheduled', 'rescheduled', 'completed', 'cancelled', 'no_show'],
    default: 'scheduled',
  },
  // Rescheduling
  rescheduledFrom: Date,
  rescheduledBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
  },
  rescheduledAt: Date,
  rescheduleReason: String,
  // Completion
  completedAt: Date,
  outcome: String,
  notes: String,
  // Calendar sync
  calendarEventId: String,
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
  updatedAt: {
    type: Date,
    default: Date.now,
  },
});

module.exports = mongoose.model('CompetencyBooking', competencyBookingSchema);
