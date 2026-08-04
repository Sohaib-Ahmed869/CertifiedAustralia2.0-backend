/**
 * inboundCallService — handles a PSTN call arriving on one of the org's Twilio
 * numbers. Routing is DYNAMIC: the dialed number (To) is matched to the user
 * who has it allotted (User.assignedPhoneNumber), and the call is bridged to
 * that user's browser softphone. Unanswered calls (or calls to an unassigned
 * number) fall through to voicemail. Every leg is persisted as a CallRecord for
 * the Call Tracking page.
 *
 * Webhook chain:
 *   /voice/inbound         → handleIncoming  (ring the assignee's client)
 *   /voice/inbound/action  → handleDialAction (answered? else → voicemail)
 *   /voice/inbound/voicemail → handleVoicemail (store recording + notify)
 */

const User = require('../models/User');
const twilioVoice = require('./twilioVoiceService');
const callRecords = require('./callRecordService');
const {
  emitIncomingCall,
  emitIncomingResolved,
  emitCallRecordsUpdated,
} = require('../socket');

/** Find the active staff user who has `number` allotted (suffix-matched). */
async function findAssignee(number) {
  const key = callRecords.phoneKey(number);
  if (!key || key.length < 6) return null;
  const candidates = await User.find({
    assignedPhoneNumber: { $regex: `${key}$` },
    status: 'active',
  })
    .select('_id firstName lastName assignedPhoneNumber')
    .lean();
  return candidates.find((u) => callRecords.phoneKey(u.assignedPhoneNumber) === key) || null;
}

/* ── 1. Incoming call ──────────────────────────────────────── */

async function handleIncoming(body) {
  const callSid = body.CallSid;
  const from = body.From;
  const to = body.To;

  const [assignee, contact] = await Promise.all([
    findAssignee(to),
    callRecords.matchContactByPhone(from),
  ]);

  const agentName = assignee
    ? `${assignee.firstName || ''} ${assignee.lastName || ''}`.trim()
    : null;

  // Persist the ringing leg (idempotent on CallSid).
  const record = await callRecords.upsertLeg(callSid, {
    direction: 'inbound',
    orgNumber: to,
    fromNumber: from,
    toNumber: to,
    agentId: assignee?._id || null,
    agentName,
    studentId: contact.studentId,
    applicationId: contact.applicationId,
    displayApplicationId: contact.displayApplicationId,
    contactName: contact.contactName || from,
    status: 'ringing',
    connected: false,
    startedAt: new Date(),
    isTest: contact.isTest,
  });

  emitCallRecordsUpdated();

  if (!assignee) {
    // Nobody owns this number → straight to voicemail (no one to ring/notify).
    return twilioVoice.voicemailTwiml();
  }

  // Push rich caller context to the assignee's tabs so the global incoming-call
  // modal can render name/application while the browser Device also rings.
  emitIncomingCall(String(assignee._id), {
    callSid,
    from,
    to,
    contactName: contact.contactName || from,
    displayApplicationId: contact.displayApplicationId || null,
    applicationId: contact.applicationId ? String(contact.applicationId) : null,
    recordId: String(record._id),
    startedAt: record.startedAt,
  });

  return twilioVoice.dialClientTwiml({
    userId: String(assignee._id),
    callerNumber: from,
    contactName: contact.contactName || from,
    displayApplicationId: contact.displayApplicationId,
  });
}

/* ── 2. After the <Dial> to the client ends ────────────────── */

async function handleDialAction(body) {
  const callSid = body.CallSid; // parent (inbound) call
  const dialStatus = body.DialCallStatus; // completed | no-answer | busy | failed | canceled
  const dialDuration = parseInt(body.DialCallDuration, 10) || 0;

  const record = await callRecords.findBySid(callSid);

  if (dialStatus === 'completed') {
    // Agent answered and the call is now over.
    if (record) {
      record.status = 'completed';
      record.connected = true;
      record.answeredAt = record.answeredAt || new Date(Date.now() - dialDuration * 1000);
      record.endedAt = new Date();
      record.durationSec = dialDuration;
      await record.save();
      emitIncomingResolved(String(record.agentId || ''), { callSid, outcome: 'answered' });
      emitCallRecordsUpdated();
    }
    // Conversation finished — hang up cleanly.
    const res = new (require('twilio').twiml.VoiceResponse)();
    res.hangup();
    return res.toString();
  }

  // Not answered → mark missed, notify, and offer voicemail.
  if (record) {
    record.status = 'missed';
    record.endedAt = new Date();
    await record.save();
    emitIncomingResolved(String(record.agentId || ''), { callSid, outcome: 'missed' });
    await callRecords.notifyMissed(record);
  }
  return twilioVoice.voicemailTwiml();
}

/* ── 3. Voicemail recording ────────────────────────────────── */

async function handleVoicemail(body) {
  const callSid = body.CallSid;
  const recordingUrl = body.RecordingUrl ? `${body.RecordingUrl}.mp3` : null;
  const recordingDuration = parseInt(body.RecordingDuration, 10) || 0;

  const record = await callRecords.findBySid(callSid);
  if (record) {
    record.status = 'voicemail';
    record.voicemailUrl = recordingUrl;
    record.voicemailDurationSec = recordingDuration;
    if (!record.endedAt) record.endedAt = new Date();
    await record.save();
    await callRecords.notifyMissed(record, { voicemail: true });
    emitCallRecordsUpdated();
  }

  const res = new (require('twilio').twiml.VoiceResponse)();
  res.say({ voice: 'alice' }, 'Thank you for your message. Goodbye.');
  res.hangup();
  return res.toString();
}

module.exports = { handleIncoming, handleDialAction, handleVoicemail, findAssignee };
