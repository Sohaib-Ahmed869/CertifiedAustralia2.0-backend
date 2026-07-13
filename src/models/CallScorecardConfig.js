const mongoose = require('mongoose');

/**
 * CallScorecardConfig — single-document store for the Call Scorecard daily
 * targets (per agent). Mirrors the old project's callTrackingConfig/targets.
 * Fetched/merged over DEFAULT_TARGETS in callScorecardService.
 */
const callScorecardConfigSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true, default: 'targets' },
    callsPerAgent: { type: Number, default: 60 },
    answeredPerAgent: { type: Number, default: 30 },
    qualityPerAgent: { type: Number, default: 15 },
    agentCount: { type: Number, default: 3 },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model('CallScorecardConfig', callScorecardConfigSchema);
