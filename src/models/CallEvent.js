const mongoose = require('mongoose');

/**
 * CallEvent — event-sourced call log powering the per-agent Call Scorecard.
 *
 * One immutable-ish document per logged call. All scorecard numbers are
 * computed from these events on read (no stored counters), so metrics can
 * never drift. Kept separate from CallLog (which drives the per-application
 * call history + Application contact counters).
 *
 * `date`/`time`/`day`/`timeBlock` are derived in AEST (Australia/Sydney) at
 * write time; `date` is stored as a "YYYY-MM-DD" string so day/range queries
 * are simple lexicographic comparisons.
 */
const callEventSchema = new mongoose.Schema(
  {
    // AEST-derived time fields
    date: { type: String, required: true, index: true }, // YYYY-MM-DD
    day: { type: String, default: null }, // weekday name
    time: { type: String, default: null }, // HH:MM (24h)
    timeBlock: { type: String, default: null }, // "09:00 - 10:00"

    // Agent identity (ObjectId is the source of truth; name denormalised for grouping/labels)
    agentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    agentName: { type: String, required: true },
    enteredById: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    enteredByName: { type: String, default: null },

    // Lead / linked application (both optional — manual / cold calls have neither)
    leadName: { type: String, default: null },
    qualification: { type: String, default: null },
    applicationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Application',
      default: null,
    },
    displayApplicationId: { type: String, default: null }, // APP10000 display id

    // Outcome booleans — quality/converted only meaningful when answered
    answered: { type: Boolean, default: false },
    qualityConversation: { type: Boolean, default: false },
    converted: { type: Boolean, default: false },

    direction: { type: String, enum: ['outbound', 'incoming'], default: 'outbound' },
    note: { type: String, default: null },
    entryMethod: { type: String, default: 'manual' }, // 'manual' | 'call-button' | ...
    reviewStatus: { type: String, default: 'logged' },
  },
  { timestamps: true }
);

// Compound index for the common per-agent-per-day scorecard query
callEventSchema.index({ agentId: 1, date: 1 });
// Per-application lookups: the student-detail Call Log and the contact-counter
// recompute in contactTrackingService both hit this.
callEventSchema.index({ applicationId: 1, createdAt: -1 });

module.exports = mongoose.model('CallEvent', callEventSchema);
