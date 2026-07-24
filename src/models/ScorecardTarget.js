const mongoose = require('mongoose');

const scorecardTargetSchema = new mongoose.Schema({
  weekKey: { type: String, required: true, unique: true, index: true }, // e.g. '2026-W27' or 'default'
  revenue: { type: Number, default: 60000 },
  leads: { type: Number, default: 75 },
  appsPaid: { type: Number, default: 10 },
  appsCompleted: { type: Number, default: 10 },
  certsReleased: { type: Number, default: 10 },
  callsPerAgent: { type: Number, default: 300 },
  conversionPerAgent: { type: Number, default: 75 },
  expenses: { type: Number, default: 35000 },
  // Weekly/monthly review notes (EOS scorecard meeting notes)
  notes: { type: String, default: '' },
  // Per-metric manual overrides: { [metricKey]: { actual: Number|null, status: String|null } }
  // metricKey ∈ revenue|leads|appsPaid|appsCompleted|certsReleased|forecastRevenue
  // status ∈ on_track|close|off_track|not_scored
  metricOverrides: { type: mongoose.Schema.Types.Mixed, default: {} },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { timestamps: true });

module.exports = mongoose.model('ScorecardTarget', scorecardTargetSchema);
