const CallEvent = require('../models/CallEvent');
const CallScorecardConfig = require('../models/CallScorecardConfig');
const Application = require('../models/Application');
const User = require('../models/User');
const AppError = require('../utils/AppError');
const contactTracking = require('./contactTrackingService');

/* ═══════════════════════════════════════════════════════
   CONSTANTS
   ═══════════════════════════════════════════════════════ */

const AEST_TZ = 'Australia/Sydney';

// Individual daily targets: 60 calls, 30 answered (50%), 15 quality conversations.
// Team target = per-agent target × agentCount.
const DEFAULT_TARGETS = {
  callsPerAgent: 60,
  answeredPerAgent: 30,
  qualityPerAgent: 15,
  agentCount: 3,
};

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/* ═══════════════════════════════════════════════════════
   TIME HELPERS (AEST)
   ═══════════════════════════════════════════════════════ */

function blockForHour(h) {
  const hh = ((h % 24) + 24) % 24;
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(hh)}:00 - ${pad((hh + 1) % 24)}:00`;
}

function aestPartsFromDate(date) {
  const dtf = new Intl.DateTimeFormat('en-AU', {
    timeZone: AEST_TZ,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
    weekday: 'long',
  });
  const p = dtf.formatToParts(date).reduce((a, x) => { a[x.type] = x.value; return a; }, {});
  const hour = p.hour === '24' ? '00' : p.hour;
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    time: `${hour}:${p.minute}`,
    day: p.weekday,
    timeBlock: blockForHour(parseInt(hour, 10)),
  };
}

function dayNameFromDateStr(dateStr) {
  const [y, m, d] = String(dateStr).split('-').map(Number);
  if (!y || !m || !d) return '';
  return DAY_NAMES[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
}

function resolveEventTime({ date, time, timestamp } = {}) {
  if (date && time) {
    const h = parseInt(String(time).split(':')[0], 10) || 0;
    return { date, time, day: dayNameFromDateStr(date), timeBlock: blockForHour(h) };
  }
  const base = timestamp ? new Date(timestamp) : new Date();
  return aestPartsFromDate(isNaN(base.getTime()) ? new Date() : base);
}

function todayAEST() {
  return aestPartsFromDate(new Date()).date;
}

/** Convert a JS Date to its AEST "YYYY-MM-DD" string (used to bridge week ranges). */
function dateStrAEST(date) {
  return aestPartsFromDate(date).date;
}

/* ═══════════════════════════════════════════════════════
   PURE HELPERS (exported — reused by the CEO weekly scorecard)
   ═══════════════════════════════════════════════════════ */

const toBool = (v) => v === true || v === 'Yes' || v === 'yes' || v === 'true' || v === 1 || v === '1';
const pct = (num, den) => (den > 0 ? Math.round((num / den) * 1000) / 10 : 0); // one-decimal %

// A row only counts if it is a real, attributable call event.
const isValidEvent = (e) => !!(e && e.date && e.agentId && (e.leadName || e.qualification || e.applicationId));

/**
 * aggregate(events) — the heart of the scorecard.
 * NOTE the outbound-vs-all asymmetry (matches the old project):
 *   calls / answered  → OUTBOUND only (direction !== 'incoming')
 *   quality / converted → ALL events (inbound + outbound)
 */
function aggregate(events) {
  const outbound = events.filter((e) => e.direction !== 'incoming');
  const calls = outbound.length;
  const answered = outbound.filter((e) => e.answered).length;
  const quality = events.filter((e) => e.qualityConversation).length;
  const converted = events.filter((e) => e.converted).length;
  const incoming = events.filter((e) => e.direction === 'incoming').length;
  return {
    calls, answered, quality, converted, incoming,
    answerRate: pct(answered, calls),
    qualityRate: calls > 0 ? pct(quality, calls) : 0,
    conversionRate: pct(converted, answered),
  };
}

/**
 * statusFor(agg, targets):
 *   On Track        ⟺ calls ≥ 100% AND answerRate ≥ 50% AND quality ≥ 100%
 *   Needs Attention ⟺ calls ≥ 80% (but not On Track)
 *   Off Track       ⟺ otherwise
 */
function statusFor(agg, targets) {
  const callsPct = targets.callsPerAgent > 0 ? agg.calls / targets.callsPerAgent : 0;
  const qualityPct = targets.qualityPerAgent > 0 ? agg.quality / targets.qualityPerAgent : 0;
  const answerRate = agg.answerRate / 100;
  if (callsPct >= 1 && answerRate >= 0.5 && qualityPct >= 1) return 'On Track';
  if (callsPct >= 0.8) return 'Needs Attention';
  return 'Off Track';
}

/**
 * queryEvents({ from, to, agentId, applicationId }) — fetch valid call events.
 * `date` is a lexicographic-safe YYYY-MM-DD string.
 */
async function queryEvents({ from, to, agentId, applicationId } = {}) {
  const filter = {};
  if (applicationId) filter.applicationId = applicationId;
  if (agentId) filter.agentId = agentId;
  if (from && to && from === to) {
    filter.date = from;
  } else if (from || to) {
    filter.date = {};
    if (from) filter.date.$gte = from;
    if (to) filter.date.$lte = to;
  }
  const events = await CallEvent.find(filter).lean();
  return events.filter(isValidEvent);
}

/* ═══════════════════════════════════════════════════════
   TARGETS
   ═══════════════════════════════════════════════════════ */

async function readTargets() {
  const doc = await CallScorecardConfig.findOne({ key: 'targets' }).lean();
  if (!doc) return { ...DEFAULT_TARGETS };
  return {
    callsPerAgent: doc.callsPerAgent ?? DEFAULT_TARGETS.callsPerAgent,
    answeredPerAgent: doc.answeredPerAgent ?? DEFAULT_TARGETS.answeredPerAgent,
    qualityPerAgent: doc.qualityPerAgent ?? DEFAULT_TARGETS.qualityPerAgent,
    agentCount: doc.agentCount ?? DEFAULT_TARGETS.agentCount,
  };
}

async function updateTargets(body = {}, userId) {
  const clean = {};
  ['callsPerAgent', 'answeredPerAgent', 'qualityPerAgent', 'agentCount'].forEach((k) => {
    if (body[k] != null && !isNaN(parseInt(body[k], 10))) clean[k] = parseInt(body[k], 10);
  });
  clean.updatedBy = userId || null;
  await CallScorecardConfig.findOneAndUpdate(
    { key: 'targets' },
    { $set: clean, $setOnInsert: { key: 'targets' } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  return readTargets();
}

/* ═══════════════════════════════════════════════════════
   EVENT CRUD
   ═══════════════════════════════════════════════════════ */

async function createEvent(body = {}, user) {
  const agentId = body.agentId || user._id;
  const agentName =
    (body.agentName || '').trim() ||
    `${user.firstName || ''} ${user.lastName || ''}`.trim() ||
    user.email;
  if (!agentId) throw new AppError('Missing agent.', 400);

  const answered = toBool(body.answered);
  // Quality / conversion only make sense on an answered call.
  const qualityConversation = answered && toBool(body.qualityConversation);
  const converted = answered && toBool(body.converted);

  const t = resolveEventTime(body);

  const event = await CallEvent.create({
    date: t.date,
    day: t.day,
    time: t.time,
    timeBlock: t.timeBlock,
    agentId,
    agentName,
    enteredById: user._id,
    enteredByName: `${user.firstName || ''} ${user.lastName || ''}`.trim() || user.email,
    leadName: (body.leadName ?? '').toString().trim() || null,
    qualification: (body.qualification ?? '').toString().trim() || null,
    applicationId: body.applicationId || null,
    displayApplicationId: body.displayApplicationId || null,
    answered,
    qualityConversation,
    converted,
    direction: body.direction === 'incoming' ? 'incoming' : 'outbound',
    note: (body.note ?? '').toString().trim() || null,
    entryMethod: body.entryMethod || 'manual',
    reviewStatus: 'logged',
  });

  // Contact Tracking on the application is derived from these events — no more
  // hand-cranking the +/- steppers after logging a call.
  await contactTracking.syncApplication(event.applicationId);

  return event.toObject();
}

async function updateEvent(id, body = {}) {
  const existing = await CallEvent.findById(id);
  if (!existing) throw new AppError('Call event not found.', 404);

  const updates = {};
  if (body.answered !== undefined) updates.answered = toBool(body.answered);
  const answeredNow = updates.answered !== undefined ? updates.answered : existing.answered;
  if (body.qualityConversation !== undefined) {
    updates.qualityConversation = answeredNow && toBool(body.qualityConversation);
  }
  if (body.converted !== undefined) updates.converted = answeredNow && toBool(body.converted);
  // If the call is flipped to not-answered, clear dependent flags.
  if (updates.answered === false) {
    updates.qualityConversation = false;
    updates.converted = false;
  }
  if (body.note !== undefined) updates.note = (body.note ?? '').toString().trim() || null;
  if (body.leadName !== undefined) updates.leadName = (body.leadName ?? '').toString().trim() || null;
  if (body.qualification !== undefined) updates.qualification = (body.qualification ?? '').toString().trim() || null;
  if (body.direction !== undefined) updates.direction = body.direction === 'incoming' ? 'incoming' : 'outbound';

  Object.assign(existing, updates);
  await existing.save();

  // Direction can flip outbound ⇄ incoming, which moves the count between the
  // two Contact Tracking counters.
  await contactTracking.syncApplication(existing.applicationId);

  return existing.toObject();
}

async function deleteEvent(id) {
  const deleted = await CallEvent.findByIdAndDelete(id);
  if (!deleted) throw new AppError('Call event not found.', 404);
  // Recompute so a mis-logged call doesn't leave the counter overstated.
  await contactTracking.syncApplication(deleted.applicationId);
  return { success: true };
}

async function listEvents({ date, agentId, applicationId, from, to } = {}) {
  const events = await queryEvents({
    from: from || date,
    to: to || date,
    agentId,
    applicationId,
  });
  events.sort((a, b) => (b.date + (b.time || '')).localeCompare(a.date + (a.time || '')));
  return events;
}

/* ═══════════════════════════════════════════════════════
   SCORECARDS
   ═══════════════════════════════════════════════════════ */

function buildCard(date, agentId, agentName, agg, targets) {
  return {
    date,
    agentId,
    agent: agentName,
    callsTarget: targets.callsPerAgent,
    answeredTarget: targets.answeredPerAgent,
    qualityTarget: targets.qualityPerAgent,
    ...agg,
    callsPct: pct(agg.calls, targets.callsPerAgent),
    qualityPct: pct(agg.quality, targets.qualityPerAgent),
    status: statusFor(agg, targets),
  };
}

async function getIndividualScorecard({ date, from, to, agentId } = {}) {
  const f = from || date || todayAEST();
  const t = to || date || f;
  const targets = await readTargets();
  const events = await queryEvents({ from: f, to: t, agentId });

  // Daily targets scale by the number of days in the range so week/month views
  // compare against the right cumulative goal (matches getTeamScorecard).
  const parts = (s) => s.split('-').map(Number);
  const [af, mf, df] = parts(f);
  const [at, mt, dt2] = parts(t);
  const days = Math.max(1, Math.round((Date.UTC(at, mt - 1, dt2) - Date.UTC(af, mf - 1, df)) / 86400000) + 1);
  const scaledTargets = {
    ...targets,
    callsPerAgent: targets.callsPerAgent * days,
    answeredPerAgent: targets.answeredPerAgent * days,
    qualityPerAgent: targets.qualityPerAgent * days,
  };

  const byAgent = {};
  events.forEach((e) => {
    const key = String(e.agentId);
    (byAgent[key] = byAgent[key] || { name: e.agentName, events: [] }).events.push(e);
  });

  // Ensure a card is returned even when a specific agent has zero calls.
  if (agentId && !byAgent[String(agentId)]) {
    let name = '';
    const u = await User.findById(agentId).select('firstName lastName email').lean();
    if (u) name = `${u.firstName || ''} ${u.lastName || ''}`.trim() || u.email;
    byAgent[String(agentId)] = { name, events: [] };
  }

  const label = f === t ? f : `${f}..${t}`;
  const cards = Object.entries(byAgent)
    .map(([id, group]) => buildCard(label, id, group.name, aggregate(group.events), scaledTargets))
    .sort((a, b) => b.calls - a.calls);

  return {
    date: f === t ? f : undefined,
    from: f,
    to: t,
    days,
    targets,
    cards: agentId ? (cards[0] ? [cards[0]] : []) : cards,
  };
}

// Set of user IDs (as strings) currently flagged as sales agents. Call Tracking
// only counts/shows calls made by active agents — staff who aren't agents but
// happen to have logged a call are excluded from the team scorecard, consistent
// with Agent Performance and the assign dropdowns.
async function activeAgentIdSet() {
  const agents = await User.find({ isSalesAgent: true, status: 'active' }).select('_id').lean();
  return new Set(agents.map((u) => String(u._id)));
}

async function getTeamScorecard({ from, to, date } = {}) {
  const f = from || date || todayAEST();
  const t = to || date || f;
  const targets = await readTargets();
  const agentIds = await activeAgentIdSet();
  const events = (await queryEvents({ from: f, to: t })).filter((e) => agentIds.has(String(e.agentId)));

  // Daily targets scale by the number of days in the range so a week/month view
  // compares against the right cumulative goal (returned `targets` stays daily).
  const parts = (s) => s.split('-').map(Number);
  const [af, mf, df] = parts(f);
  const [at, mt, dt2] = parts(t);
  const days = Math.max(1, Math.round((Date.UTC(at, mt - 1, dt2) - Date.UTC(af, mf - 1, df)) / 86400000) + 1);
  const scaledTargets = {
    ...targets,
    callsPerAgent: targets.callsPerAgent * days,
    answeredPerAgent: targets.answeredPerAgent * days,
    qualityPerAgent: targets.qualityPerAgent * days,
  };

  const team = aggregate(events);
  const byAgent = {};
  events.forEach((e) => {
    const key = String(e.agentId);
    (byAgent[key] = byAgent[key] || { name: e.agentName, events: [] }).events.push(e);
  });
  const agents = Object.entries(byAgent)
    .map(([id, group]) => buildCard(`${f}..${t}`, id, group.name, aggregate(group.events), scaledTargets))
    .sort((a, b) => b.calls - a.calls);

  return {
    from: f,
    to: t,
    days,
    targets,
    team: {
      ...team,
      callsTarget: scaledTargets.callsPerAgent * scaledTargets.agentCount,
      answeredTarget: scaledTargets.answeredPerAgent * scaledTargets.agentCount,
      qualityTarget: scaledTargets.qualityPerAgent * scaledTargets.agentCount,
      callsPct: pct(team.calls, scaledTargets.callsPerAgent * scaledTargets.agentCount),
      qualityPct: pct(team.quality, scaledTargets.qualityPerAgent * scaledTargets.agentCount),
    },
    agents,
  };
}

async function getByTimeDashboard({ from, to, date } = {}) {
  const f = from || date || todayAEST();
  const t = to || date || f;
  const agentIds = await activeAgentIdSet();
  const events = (await queryEvents({ from: f, to: t })).filter((e) => agentIds.has(String(e.agentId)));

  const BLOCKS = [];
  for (let h = 9; h <= 19; h++) BLOCKS.push(blockForHour(h));

  const rows = BLOCKS.map((block) => {
    const evs = events.filter((e) => e.timeBlock === block);
    const agg = aggregate(evs);
    return {
      timeBlock: block,
      calls: agg.calls, answered: agg.answered, answerRate: agg.answerRate,
      quality: agg.quality, qualityRate: agg.qualityRate,
      converted: agg.converted, conversionRate: agg.conversionRate,
    };
  });

  return { from: f, to: t, rows };
}

/* ═══════════════════════════════════════════════════════
   APPLICATION TYPEAHEAD
   ═══════════════════════════════════════════════════════ */

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function searchApplications(q) {
  const term = (q ?? '').toString().trim();
  if (term.length < 2) return { results: [] };
  const rx = new RegExp(escapeRegex(term), 'i');

  const users = await User.find({
    $or: [{ firstName: rx }, { lastName: rx }, { email: rx }],
  }).select('_id').lean();
  const userIds = users.map((u) => u._id);

  const apps = await Application.find({
    status: { $ne: 'Archived' },
    $or: [{ applicationId: rx }, ...(userIds.length ? [{ studentId: { $in: userIds } }] : [])],
  })
    .select('applicationId status studentId qualificationId')
    .populate('studentId', 'firstName lastName email')
    .populate('qualificationId', 'name')
    .limit(10)
    .lean();

  const needle = term.toUpperCase();
  const results = apps.map((a) => ({
    _id: a._id,
    displayApplicationId: a.applicationId || null,
    studentName:
      `${a.studentId?.firstName || ''} ${a.studentId?.lastName || ''}`.trim() || null,
    email: a.studentId?.email || null,
    qualification: a.qualificationId?.name || null,
    status: a.status || null,
  }));
  // Prefix matches on the display id first.
  results.sort((x, y) => {
    const ax = (x.displayApplicationId || '').toUpperCase().startsWith(needle) ? 0 : 1;
    const by = (y.displayApplicationId || '').toUpperCase().startsWith(needle) ? 0 : 1;
    return ax - by;
  });

  return { results };
}

module.exports = {
  // pure helpers reused by the CEO weekly scorecard
  queryEvents,
  aggregate,
  statusFor,
  pct,
  isValidEvent,
  dateStrAEST,
  todayAEST,
  DEFAULT_TARGETS,
  // targets
  readTargets,
  updateTargets,
  // event CRUD
  createEvent,
  updateEvent,
  deleteEvent,
  listEvents,
  // scorecards
  getIndividualScorecard,
  getTeamScorecard,
  getByTimeDashboard,
  // typeahead
  searchApplications,
};
