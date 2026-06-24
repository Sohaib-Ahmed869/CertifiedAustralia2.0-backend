const mongoose = require('mongoose');

const callLogSchema = new mongoose.Schema({
  applicationId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Application',
    required: true,
    index: true,
  },
  agentId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },
  direction: {
    type: String,
    enum: ['outbound', 'inbound', 'support'],
    required: true,
  },
  outcome: {
    type: String,
    enum: [
      'answered',
      'not_answered',
      'voicemail',
      'callback',
      'converted',
      'follow_up_required',
      'progressed',
      'support_completed',
      'no_action',
    ],
    required: true,
  },
  duration: {
    type: Number,
    min: 0,
  },
  notes: {
    type: String,
    default: '',
  },
  createdAt: {
    type: Date,
    default: Date.now,
    index: true,
  },
});

module.exports = mongoose.model('CallLog', callLogSchema);
