const mongoose = require('mongoose');

/**
 * CallRecord — the persistent call-detail record (CDR) for the Call Tracking
 * view. One row per real Twilio call leg, INBOUND or OUTBOUND, fed from the
 * Twilio status/conference webhooks (not manual entry — that's CallEvent, the
 * scorecard). Captures who/when/whether-connected/how-long so Call Tracking can
 * answer "when was it made/received, did it connect, how long did it last, and
 * which user was on it".
 *
 * Keyed by twilioCallSid so webhooks can idempotently upsert a leg as it moves
 * initiated → ringing → in-progress → completed (or no-answer/busy/failed).
 * For outbound bursts, the winning leg is `connected:true`; dropped losers are
 * `canceled`. For inbound, an unanswered call rolls to `missed`, and a left
 * voicemail to `voicemail` with the recording URL.
 */
const callRecordSchema = new mongoose.Schema(
  {
    direction: {
      type: String,
      enum: ['inbound', 'outbound'],
      required: true,
      index: true,
    },
    // The org number involved. For outbound this is the agent's caller ID
    // (from), for inbound it's the dialed number (to) — i.e. the number that
    // maps back to `agent` via User.assignedPhoneNumber.
    orgNumber: { type: String, index: true },
    fromNumber: { type: String },
    toNumber: { type: String },

    // The staff user on this call: initiator (outbound) or the assignee whose
    // number was dialed (inbound). Null for inbound to an unassigned number.
    agentId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
    agentName: { type: String },

    // The counterparty (student/lead), matched by phone when we can.
    studentId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    applicationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Application' },
    displayApplicationId: { type: String },
    contactName: { type: String }, // student/lead name, or the raw number if unknown

    // Twilio identifiers. callSid is unique per leg → idempotent webhook upserts.
    twilioCallSid: { type: String, index: true, sparse: true },
    parentCallSid: { type: String }, // dial-child / conference relationship
    conferenceName: { type: String },
    burstId: { type: mongoose.Schema.Types.ObjectId, ref: 'CallBurst' },

    // Lifecycle. `connected` is the durable "did a real conversation happen"
    // flag (answered by a human on both ends), independent of the raw status.
    status: {
      type: String,
      enum: [
        'initiated',
        'ringing',
        'in-progress',
        'completed',
        'no-answer',
        'busy',
        'failed',
        'canceled',
        'missed',
        'voicemail',
      ],
      default: 'initiated',
      index: true,
    },
    connected: { type: Boolean, default: false },

    startedAt: { type: Date, default: Date.now, index: true },
    answeredAt: { type: Date },
    endedAt: { type: Date },
    durationSec: { type: Number, default: 0, min: 0 },

    // Inbound voicemail left after an unanswered call.
    voicemailUrl: { type: String },
    voicemailDurationSec: { type: Number },

    // Denormalised from the matched Application so Call Tracking can exclude
    // test traffic from real metrics without a join. See Application.isTest.
    isTest: { type: Boolean, default: false, index: true },
  },
  { timestamps: true }
);

// Common Call Tracking sort: newest first, filterable by direction/agent.
callRecordSchema.index({ startedAt: -1 });
callRecordSchema.index({ agentId: 1, startedAt: -1 });

module.exports = mongoose.model('CallRecord', callRecordSchema);
