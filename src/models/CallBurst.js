const mongoose = require('mongoose');

/**
 * CallBurst — one "call burst" session.
 *
 * An agent selects N applicants and blasts a simultaneous outbound call to all
 * of them through a Twilio conference. The FIRST recipient whose line answers
 * and joins the conference wins — every other still-ringing leg is hung up.
 * The winner stays connected to the agent (who talks through the in-browser
 * softphone). A single-recipient burst backs the 1-on-1 call buttons.
 *
 * Winner selection is atomic: the first conference `participant-join` webhook
 * that flips `winnerCallSid` from null claims the burst (findOneAndUpdate guard),
 * so two near-simultaneous answers can never both connect.
 */

const participantSchema = new mongoose.Schema(
  {
    applicationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Application', default: null },
    studentId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    displayApplicationId: { type: String, default: null }, // APP10000
    name: { type: String, default: null },
    qualification: { type: String, default: null },
    phone: { type: String, required: true },
    callSid: { type: String, default: null, index: true },
    // ringing → in-progress (answered) → completed | no-answer | busy | failed | canceled
    status: { type: String, default: 'queued' },
    isWinner: { type: Boolean, default: false },
    answeredAt: { type: Date, default: null },
    // whether a CallEvent scorecard row has already been written for this leg
    logged: { type: Boolean, default: false },
  },
  { _id: false }
);

const callBurstSchema = new mongoose.Schema(
  {
    agentId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    agentName: { type: String, default: null },

    conferenceName: { type: String, required: true, unique: true },
    conferenceSid: { type: String, default: null },

    // The agent's own softphone leg (the browser WebRTC call)
    agentCallSid: { type: String, default: null, index: true },
    agentJoined: { type: Boolean, default: false },

    participants: { type: [participantSchema], default: [] },

    // callSid of the recipient that won the race (null until someone connects)
    winnerCallSid: { type: String, default: null },

    // initiating → ringing → connected → ended | failed
    status: {
      type: String,
      enum: ['initiating', 'ringing', 'connected', 'ended', 'failed'],
      default: 'initiating',
      index: true,
    },

    mode: { type: String, enum: ['burst', 'single'], default: 'burst' },

    startedAt: { type: Date, default: Date.now },
    connectedAt: { type: Date, default: null },
    endedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model('CallBurst', callBurstSchema);
