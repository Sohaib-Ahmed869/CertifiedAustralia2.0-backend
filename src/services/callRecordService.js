/**
 * callRecordService — write + query layer for the persistent call-detail
 * records (CDR) behind the Call Tracking page. Fed by the Twilio webhooks for
 * both outbound bursts and inbound calls; NOT the manual scorecard (CallEvent).
 *
 *   • matchContactByPhone — resolve a raw phone number to a student/application
 *   • upsertLeg           — idempotent create/update keyed by Twilio Call SID
 *   • list / stats        — the Call Tracking table + summary cards
 *   • notifyMissed        — push a missed-call / voicemail notification
 */

const CallRecord = require('../models/CallRecord');
const User = require('../models/User');
const Application = require('../models/Application');

/* ── Phone matching ────────────────────────────────────────── */

// Australian numbers arrive in mixed shapes (+61468271890 / 0468271890 /
// 468271890). Compare on the last 9 significant digits, which are stable across
// the +61 / leading-0 variants.
function phoneKey(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  return digits.length > 9 ? digits.slice(-9) : digits;
}

/**
 * Resolve an inbound caller (or any raw number) to a known student + their most
 * recent application. Returns null-ish fields when we can't match — Call
 * Tracking then just shows the raw number.
 */
async function matchContactByPhone(rawPhone) {
  const key = phoneKey(rawPhone);
  const out = {
    studentId: null,
    applicationId: null,
    displayApplicationId: null,
    contactName: null,
    isTest: false,
  };
  if (!key || key.length < 6) return out;

  // Suffix-match against student phone numbers.
  const students = await User.find({
    userType: 'Student',
    phone: { $regex: `${key}$` },
  })
    .select('_id firstName lastName phone')
    .limit(5)
    .lean();

  const student = students.find((s) => phoneKey(s.phone) === key);
  if (!student) return out;

  out.studentId = student._id;
  out.contactName = `${student.firstName || ''} ${student.lastName || ''}`.trim() || null;

  const app = await Application.findOne({ studentId: student._id })
    .select('applicationId isTest')
    .sort('-updatedAt')
    .lean();
  if (app) {
    out.applicationId = app._id;
    out.displayApplicationId = app.applicationId || null;
    out.isTest = !!app.isTest;
  }
  return out;
}

/* ── Upsert ────────────────────────────────────────────────── */

/**
 * Idempotently create/update a CDR row keyed by Twilio Call SID. Safe to call
 * repeatedly from status webhooks as the leg progresses. Returns the doc.
 */
async function upsertLeg(twilioCallSid, fields = {}) {
  if (!twilioCallSid) {
    // No SID to key on (rare) — create a standalone row.
    return CallRecord.create(fields);
  }
  // twilioCallSid is seeded from the filter on insert — don't also put it in the
  // update (that raises a Mongo path-conflict). `fields` never contains it.
  return CallRecord.findOneAndUpdate(
    { twilioCallSid },
    { $set: fields },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );
}

async function findBySid(twilioCallSid) {
  if (!twilioCallSid) return null;
  return CallRecord.findOne({ twilioCallSid });
}

/* ── Notifications ─────────────────────────────────────────── */

// Missed / voicemail notification to the number's assignee. Non-throwing.
async function notifyMissed(record, { voicemail = false } = {}) {
  if (!record?.agentId) return;
  try {
    const { notify } = require('./notificationService');
    const who = record.contactName || record.fromNumber || 'Unknown caller';
    await notify(String(record.agentId), {
      type: 'missed_call',
      title: voicemail ? 'New voicemail' : 'Missed call',
      message: voicemail
        ? `${who} left you a voicemail.`
        : `You missed a call from ${who}.`,
      link: '/admin/call-tracking',
      relatedId: record._id,
    });
  } catch (err) {
    console.warn('[callRecord] notifyMissed failed:', err.message);
  }
  // Nudge any open Call Tracking page to refetch.
  try {
    require('../socket').emitCallRecordsUpdated();
  } catch { /* socket optional */ }
}

/* ── Query: Call Tracking table ────────────────────────────── */

async function list(query = {}) {
  const filter = {};

  if (query.direction && ['inbound', 'outbound'].includes(query.direction)) {
    filter.direction = query.direction;
  }
  if (query.agentId) filter.agentId = query.agentId;
  if (query.status) filter.status = query.status;

  // Connected / missed quick filters
  if (query.connected === 'true') filter.connected = true;
  if (query.connected === 'false') filter.connected = false;
  if (query.missed === 'true') filter.status = { $in: ['missed', 'no-answer', 'voicemail', 'busy'] };
  if (query.voicemail === 'true') filter.status = 'voicemail';

  // Exclude test traffic by default (opt back in with includeTest=true).
  if (query.includeTest !== 'true') filter.isTest = { $ne: true };

  if (query.dateFrom || query.dateTo) {
    filter.startedAt = {};
    if (query.dateFrom) {
      const d = new Date(query.dateFrom);
      if (!isNaN(d.getTime())) filter.startedAt.$gte = d;
    }
    if (query.dateTo) {
      const d = new Date(query.dateTo);
      if (!isNaN(d.getTime())) {
        d.setHours(23, 59, 59, 999);
        filter.startedAt.$lte = d;
      }
    }
  }

  if (query.search) {
    const rx = { $regex: String(query.search).trim(), $options: 'i' };
    filter.$or = [
      { contactName: rx },
      { fromNumber: rx },
      { toNumber: rx },
      { displayApplicationId: rx },
      { agentName: rx },
    ];
  }

  const page = parseInt(query.page, 10) || 1;
  const limit = Math.min(parseInt(query.limit, 10) || 25, 200);
  const skip = (page - 1) * limit;

  const [items, total] = await Promise.all([
    CallRecord.find(filter)
      .populate('agentId', 'firstName lastName')
      .sort({ startedAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean(),
    CallRecord.countDocuments(filter),
  ]);

  return { items, pagination: { page, limit, total, pages: Math.ceil(total / limit) } };
}

/* ── Query: summary cards ──────────────────────────────────── */

async function stats(query = {}) {
  const match = {};
  if (query.includeTest !== 'true') match.isTest = { $ne: true };
  if (query.agentId) {
    match.agentId = require('mongoose').Types.ObjectId.createFromHexString(String(query.agentId));
  }
  if (query.dateFrom || query.dateTo) {
    match.startedAt = {};
    if (query.dateFrom) {
      const d = new Date(query.dateFrom);
      if (!isNaN(d.getTime())) match.startedAt.$gte = d;
    }
    if (query.dateTo) {
      const d = new Date(query.dateTo);
      if (!isNaN(d.getTime())) {
        d.setHours(23, 59, 59, 999);
        match.startedAt.$lte = d;
      }
    }
  }

  const rows = await CallRecord.aggregate([
    { $match: match },
    {
      $group: {
        _id: null,
        total: { $sum: 1 },
        inbound: { $sum: { $cond: [{ $eq: ['$direction', 'inbound'] }, 1, 0] } },
        outbound: { $sum: { $cond: [{ $eq: ['$direction', 'outbound'] }, 1, 0] } },
        connected: { $sum: { $cond: ['$connected', 1, 0] } },
        missed: {
          $sum: {
            $cond: [{ $in: ['$status', ['missed', 'no-answer', 'voicemail', 'busy']] }, 1, 0],
          },
        },
        voicemails: { $sum: { $cond: [{ $eq: ['$status', 'voicemail'] }, 1, 0] } },
        totalDuration: { $sum: '$durationSec' },
      },
    },
  ]);

  const r = rows[0] || {};
  const connected = r.connected || 0;
  return {
    total: r.total || 0,
    inbound: r.inbound || 0,
    outbound: r.outbound || 0,
    connected,
    missed: r.missed || 0,
    voicemails: r.voicemails || 0,
    totalDurationSec: r.totalDuration || 0,
    avgDurationSec: connected ? Math.round((r.totalDuration || 0) / connected) : 0,
  };
}

module.exports = {
  phoneKey,
  matchContactByPhone,
  upsertLeg,
  findBySid,
  notifyMissed,
  list,
  stats,
};
