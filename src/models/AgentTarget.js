const mongoose = require('mongoose');

const agentTargetSchema = new mongoose.Schema(
  {
    agentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    period: {
      type: String,
      enum: ['weekly', 'monthly'],
      required: true,
    },
    // The start date of the target period (Monday for weekly, 1st for monthly)
    periodStart: {
      type: Date,
      required: true,
    },
    revenueTarget: {
      type: Number,
      default: 0,
      min: 0,
    },
    paidAppsTarget: {
      type: Number,
      default: 0,
      min: 0,
    },
    callsTarget: {
      type: Number,
      default: 0,
      min: 0,
    },
    conversionTarget: {
      type: Number,
      default: 0,
      min: 0,
      max: 100,
    },
    notes: {
      type: String,
      default: '',
    },
    setBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
  },
  {
    timestamps: true,
  }
);

// Unique constraint: one target per agent per period per start date
agentTargetSchema.index({ agentId: 1, period: 1, periodStart: 1 }, { unique: true });
agentTargetSchema.index({ periodStart: -1 });

module.exports = mongoose.model('AgentTarget', agentTargetSchema);
