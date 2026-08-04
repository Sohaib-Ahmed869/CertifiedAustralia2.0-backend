/**
 * callBurstService — orchestrates a call burst end-to-end.
 *
 * Flow (in-browser softphone + connect-on-answer):
 *   1. startBurst()  — resolve recipients, create the CallBurst, mint the agent
 *                      access token. No PSTN calls yet.
 *   2. Agent's browser Device.connect() hits /voice/agent → registerAgentLeg().
 *   3. Agent joins the conference → onConferenceEvent(join) blasts all students.
 *   4. First student to answer joins the conference → atomic winner-lock:
 *      that recipient wins, every other ringing leg is hung up.
 *   5. Agent hangs up → conference ends → endBurst() writes scorecard events.
 *
 * The winner-lock (findOneAndUpdate on winnerCallSid:null) guarantees exactly
 * one recipient can ever connect, even on simultaneous answers.
 */

const mongoose = require('mongoose');
const CallBurst = require('../models/CallBurst');
const Application = require('../models/Application');
const AppError = require('../utils/AppError');
const twilioVoice = require('./twilioVoiceService');
const callScorecardService = require('./callScorecardService');
const callRecordService = require('./callRecordService');
const { emitBurstUpdate, emitCallRecordsUpdated } = require('../socket');

const RING_TIMEOUT = 30; // seconds

/* ── Serialisation ─────────────────────────────────────────── */

function sanitize(burst) {
  const b = burst.toObject ? burst.toObject() : burst;
  return {
    _id: String(b._id),
    status: b.status,
    mode: b.mode,
    conferenceName: b.conferenceName,
    agentJoined: b.agentJoined,
    winnerCallSid: b.winnerCallSid,
    startedAt: b.startedAt,
    connectedAt: b.connectedAt,
    endedAt: b.endedAt,
    participants: (b.participants || []).map((p) => ({
      applicationId: p.applicationId ? String(p.applicationId) : null,
      displayApplicationId: p.displayApplicationId,
      name: p.name,
      qualification: p.qualification,
      phone: p.phone,
      status: p.status,
      isWinner: p.isWinner,
    })),
  };
}

function emit(burst, type) {
  try {
    emitBurstUpdate(burst.agentId, type, sanitize(burst));
  } catch { /* socket optional */ }
}

/* ── Start ─────────────────────────────────────────────────── */

/**
 * startBurst — resolve the selected applications into recipients and create a
 * CallBurst. Returns { burstId, conferenceName, token } for the browser.
 * `mode` is 'single' for the 1-on-1 call buttons.
 */
async function startBurst({ agent, applicationIds, mode = 'burst' }) {
  if (!twilioVoice.isBrowserConfigured()) {
    throw new AppError('Calling is not configured. Add the Twilio voice credentials first.', 503);
  }
  const ids = [...new Set((applicationIds || []).map(String).filter(Boolean))];
  if (!ids.length) throw new AppError('Select at least one recipient to call.', 400);

  const apps = await Application.find({ _id: { $in: ids } })
    .populate('studentId', 'firstName lastName phone')
    .populate('qualificationId', 'name')
    .lean();

  const participants = [];
  for (const app of apps) {
    const phone = app.studentId?.phone;
    if (!phone) continue; // no number → can't call
    const name = `${app.studentId?.firstName || ''} ${app.studentId?.lastName || ''}`.trim() || null;
    participants.push({
      applicationId: app._id,
      studentId: app.studentId?._id || null,
      displayApplicationId: app.applicationId || null,
      name,
      qualification: app.qualificationId?.name || null,
      phone,
      isTest: !!app.isTest,
      status: 'queued',
      isWinner: false,
    });
  }

  if (!participants.length) {
    throw new AppError('None of the selected recipients have a phone number on file.', 400);
  }

  const agentName = `${agent.firstName || ''} ${agent.lastName || ''}`.trim() || agent.email;
  const conferenceName = `burst-${new mongoose.Types.ObjectId()}`;

  const burst = await CallBurst.create({
    agentId: agent._id,
    agentName,
    // Per-user caller ID: this agent's allotted number, else the global default.
    callerId: agent.assignedPhoneNumber || process.env.TWILIO_PHONE_NUMBER || null,
    conferenceName,
    participants,
    status: 'initiating',
    mode: mode === 'single' ? 'single' : 'burst',
  });

  const { token, edge } = twilioVoice.createAccessToken(`agent:${agent._id}`);

  console.log(`[callBurst] ${burst._id} created — ${participants.length} recipient(s), conf=${conferenceName}`);
  emit(burst, 'created');
  return {
    burstId: String(burst._id),
    conferenceName,
    token,
    edge,
    burst: sanitize(burst),
  };
}

/* ── Agent leg ─────────────────────────────────────────────── */

/**
 * registerAgentLeg — called from /voice/agent when the browser call reaches us.
 * Records the agent's CallSid so we can tell the agent apart from recipients in
 * conference events. Returns the TwiML that parks the agent in the conference.
 */
async function registerAgentLeg(burstId, callSid) {
  const burst = await CallBurst.findById(burstId);
  if (!burst) throw new AppError('Burst not found', 404);
  burst.agentCallSid = callSid;
  await burst.save();
  return twilioVoice.agentConferenceTwiml(burst.conferenceName);
}

/** Blast the outbound calls to every recipient. Idempotent-ish via status. */
async function blastRecipients(burst) {
  for (const p of burst.participants) {
    if (p.callSid) continue; // already dialed
    try {
      const sid = await twilioVoice.callStudent({
        to: p.phone,
        burstId: String(burst._id),
        from: burst.callerId,
        timeout: RING_TIMEOUT,
      });
      p.callSid = sid;
      p.status = 'ringing';
      console.log(`[callBurst] dialing ${p.phone} (${p.displayApplicationId || '—'}) sid=${sid}`);
      // Persist an outbound CDR row for Call Tracking, keyed by the leg's SID.
      await writeLegRecord(burst, p, sid);
    } catch (err) {
      p.status = 'failed';
      console.warn(`[callBurst] dial ${p.phone} FAILED: ${err.message}`);
    }
  }
  burst.status = 'ringing';
  await burst.save();
  emit(burst, 'ringing');
  try { emitCallRecordsUpdated(); } catch { /* socket optional */ }
}

/** Create/refresh the outbound CallRecord for one dialed recipient leg. */
async function writeLegRecord(burst, p, sid) {
  try {
    await callRecordService.upsertLeg(sid, {
      direction: 'outbound',
      orgNumber: burst.callerId || null,
      fromNumber: burst.callerId || null,
      toNumber: p.phone,
      agentId: burst.agentId,
      agentName: burst.agentName,
      studentId: p.studentId || null,
      applicationId: p.applicationId || null,
      displayApplicationId: p.displayApplicationId || null,
      contactName: p.name || p.phone,
      burstId: burst._id,
      conferenceName: burst.conferenceName,
      status: 'ringing',
      connected: false,
      startedAt: new Date(),
      isTest: !!p.isTest,
    });
  } catch (err) {
    console.warn(`[callBurst] CDR write failed for ${p.phone}: ${err.message}`);
  }
}

/* ── Conference events (join / leave / end) ────────────────── */

async function onConferenceEvent(body) {
  const event = body.StatusCallbackEvent;
  const callSid = body.CallSid;
  const conferenceName = body.FriendlyName;
  if (!conferenceName) return;

  const burst = await CallBurst.findOne({ conferenceName });
  if (!burst) return;
  if (body.ConferenceSid && !burst.conferenceSid) burst.conferenceSid = body.ConferenceSid;

  if (event === 'participant-join') {
    // Agent joined → open the floodgates and blast the recipients.
    if (callSid && callSid === burst.agentCallSid) {
      if (!burst.agentJoined) {
        burst.agentJoined = true;
        await burst.save();
        console.log(`[callBurst] ${burst._id} agent joined conference — blasting recipients`);
        await blastRecipients(await CallBurst.findById(burst._id));
      }
      return;
    }
    // A recipient joined → try to claim the win atomically.
    await claimWinner(burst._id, callSid);
    return;
  }

  if (event === 'participant-leave') {
    // Winner or agent left → the conversation is over.
    if (callSid === burst.winnerCallSid || callSid === burst.agentCallSid) {
      await endBurst(burst._id, 'hangup');
    }
    return;
  }

  if (event === 'conference-end') {
    await endBurst(burst._id, 'conference-end');
  }
}

/**
 * claimWinner — atomic first-to-answer lock. The findOneAndUpdate only succeeds
 * for the first recipient (winnerCallSid still null); everyone else is dropped.
 */
async function claimWinner(burstId, callSid) {
  const claimed = await CallBurst.findOneAndUpdate(
    { _id: burstId, winnerCallSid: null },
    { $set: { winnerCallSid: callSid, status: 'connected', connectedAt: new Date() } },
    { new: true }
  );

  if (claimed && claimed.winnerCallSid === callSid) {
    // We won the race. Mark winner + hang up every other leg.
    const winner = claimed.participants.find((p) => p.callSid === callSid);
    if (winner) {
      winner.isWinner = true;
      winner.status = 'in-progress';
      winner.answeredAt = new Date();
      // The winning leg is the only one that reaches a real conversation.
      try {
        await callRecordService.upsertLeg(callSid, {
          status: 'in-progress',
          connected: true,
          answeredAt: winner.answeredAt,
        });
        emitCallRecordsUpdated();
      } catch { /* CDR best-effort */ }
    }
    await claimed.save();
    console.log(`[callBurst] ${claimed._id} WINNER ${winner?.name || callSid} — dropping ${claimed.participants.filter((p) => p.callSid && p.callSid !== callSid).length} other leg(s)`);

    await Promise.all(
      claimed.participants
        .filter((p) => p.callSid && p.callSid !== callSid && ['ringing', 'queued', 'in-progress'].includes(p.status))
        .map((p) => twilioVoice.endCall(p.callSid))
    );
    emit(claimed, 'connected');
    return;
  }

  // Someone else already won — drop this straggler so it can't linger in the room.
  const existing = await CallBurst.findById(burstId);
  if (existing && existing.winnerCallSid && existing.winnerCallSid !== callSid) {
    await twilioVoice.endCall(callSid);
  }
}

/* ── Per-leg call status ───────────────────────────────────── */

const STATUS_MAP = {
  initiated: 'ringing',
  ringing: 'ringing',
  'in-progress': 'in-progress',
  answered: 'in-progress',
  completed: 'completed',
  busy: 'busy',
  'no-answer': 'no-answer',
  failed: 'failed',
  canceled: 'canceled',
};

async function onStatusEvent(body) {
  const callSid = body.CallSid;
  const raw = body.CallStatus;
  if (!callSid) return;

  const burst = await CallBurst.findOne({ 'participants.callSid': callSid });
  if (!burst) return;

  const p = burst.participants.find((x) => x.callSid === callSid);
  if (!p) return;

  const mapped = STATUS_MAP[raw] || raw;
  // Never downgrade the winner away from in-progress until it truly completes.
  if (p.isWinner && mapped !== 'completed') return;
  p.status = mapped;
  await burst.save();
  emit(burst, 'progress');

  // Mirror the leg's terminal state onto its CDR row (duration on completion).
  try {
    const patch = { status: mapped };
    if (mapped === 'completed') {
      patch.endedAt = new Date();
      const dur = parseInt(body.CallDuration, 10);
      if (!isNaN(dur)) patch.durationSec = dur;
      // A non-winner that "completed" was hung up mid-ring → not a real convo.
      if (!p.isWinner) { patch.status = 'canceled'; patch.connected = false; }
    }
    await callRecordService.upsertLeg(callSid, patch);
    emitCallRecordsUpdated();
  } catch { /* CDR best-effort */ }

  // If every recipient leg has finished and nobody connected, wrap it up.
  const anyLive = burst.participants.some((x) => ['ringing', 'queued', 'in-progress'].includes(x.status));
  if (!anyLive && !burst.winnerCallSid && burst.status !== 'ended') {
    await endBurst(burst._id, 'no-answer');
  }
}

/* ── End + scorecard logging ───────────────────────────────── */

async function endBurst(burstId, reason = 'ended') {
  const burst = await CallBurst.findById(burstId);
  if (!burst || burst.status === 'ended') return burst ? sanitize(burst) : null;

  burst.status = 'ended';
  burst.endedAt = new Date();
  await burst.save();

  // Best-effort: hang up any legs still open.
  await Promise.all(
    burst.participants
      .filter((p) => p.callSid && ['ringing', 'queued', 'in-progress'].includes(p.status))
      .map((p) => twilioVoice.endCall(p.callSid))
  );
  if (burst.agentCallSid) await twilioVoice.endCall(burst.agentCallSid);

  await writeCallEvents(burst);

  console.log(`[callBurst] ${burst._id} ended (${reason})`);
  emit(burst, 'ended');
  return sanitize(burst);
}

/**
 * writeCallEvents — one CallEvent (scorecard row) per dialed recipient.
 * Only the winner counts as `answered` — losers were dropped before any real
 * conversation. Guarded by participant.logged so retries don't double-count.
 */
async function writeCallEvents(burst) {
  const agentUser = {
    _id: burst.agentId,
    firstName: (burst.agentName || '').split(' ')[0] || '',
    lastName: (burst.agentName || '').split(' ').slice(1).join(' ') || '',
    email: burst.agentName,
  };

  let touched = false;
  for (const p of burst.participants) {
    if (p.logged || !p.callSid) continue;
    try {
      await callScorecardService.createEvent(
        {
          agentId: burst.agentId,
          agentName: burst.agentName,
          leadName: p.name,
          qualification: p.qualification,
          applicationId: p.applicationId,
          displayApplicationId: p.displayApplicationId,
          answered: p.isWinner, // connect-on-answer: only the winner actually spoke
          direction: 'outbound',
          entryMethod: 'call-burst',
        },
        agentUser
      );
      p.logged = true;
      touched = true;
    } catch (err) {
      console.warn(`[callBurst] scorecard log failed for ${p.displayApplicationId}: ${err.message}`);
    }
  }
  if (touched) await burst.save();
}

/* ── Manual hangup ─────────────────────────────────────────── */

async function hangup(burstId, user) {
  const burst = await CallBurst.findById(burstId);
  if (!burst) throw new AppError('Burst not found', 404);
  if (String(burst.agentId) !== String(user._id) && !['Admin', 'CEOReportingManager'].includes(user.role)) {
    throw new AppError('Not your call', 403);
  }
  return endBurst(burstId, 'manual');
}

/* ── Recipient picker ──────────────────────────────────────── */

/**
 * listRecipients — callable applicants (those with a phone on file) for the
 * Call Burst selection UI. Supports search (name / APP id), status filter, and
 * "mine" to scope to the agent's own assigned applications.
 */
async function listRecipients({ search, status, mine, agent, limit = 100 } = {}) {
  const match = {};
  if (status) match.status = status;
  if (mine === 'true' || mine === true) match.assignedAgentId = agent?._id;

  const apps = await Application.find(match)
    .populate('studentId', 'firstName lastName phone')
    .populate('qualificationId', 'name')
    .sort('-updatedAt')
    .limit(Math.min(Number(limit) || 100, 300))
    .lean();

  const q = (search || '').trim().toLowerCase();
  const items = apps
    .filter((a) => a.studentId?.phone)
    .map((a) => ({
      applicationId: String(a._id),
      displayApplicationId: a.applicationId || null,
      name: `${a.studentId?.firstName || ''} ${a.studentId?.lastName || ''}`.trim() || null,
      phone: a.studentId.phone,
      qualification: a.qualificationId?.name || null,
      status: a.status,
    }))
    .filter((a) =>
      !q ||
      (a.name && a.name.toLowerCase().includes(q)) ||
      (a.displayApplicationId && a.displayApplicationId.toLowerCase().includes(q)) ||
      (a.phone && a.phone.includes(q))
    );

  return { items };
}

async function getBurst(burstId, user) {
  const burst = await CallBurst.findById(burstId);
  if (!burst) throw new AppError('Burst not found', 404);
  if (String(burst.agentId) !== String(user._id) && !['Admin', 'CEOReportingManager'].includes(user.role)) {
    throw new AppError('Not your call', 403);
  }
  return sanitize(burst);
}

module.exports = {
  startBurst,
  listRecipients,
  registerAgentLeg,
  onConferenceEvent,
  onStatusEvent,
  endBurst,
  hangup,
  getBurst,
  sanitize,
};
