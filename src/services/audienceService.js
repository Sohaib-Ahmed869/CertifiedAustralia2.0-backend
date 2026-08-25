/**
 * Audience resolution for email sequences AND campaigns — ONE seam, so the two
 * builders (which render the same audience UI) can never drift on what a preset
 * or a filter means. `buildFilter` is the single translator from an
 * `audienceConfig` to a Mongo filter on Application; `campaignSendService`
 * delegates to it rather than keeping its own preset-only copy.
 *
 * Supports the presets (all/active/paid/intake/leads/specific) plus the advanced
 * filter shape both wizards send (industries[]/qualifications[]/statuses[]/
 * sources[]/states[]/callAttempts/date range/readyForAssessmentOnly/archived).
 * Reuses READY_STATUSES from the admin student list service to keep "ready for
 * assessment" consistent.
 *
 * `resolveAudience`/`countAudience` here return the SEQUENCE recipient shape;
 * campaigns build their own rows (different merge-tag keys) off the same filter.
 */
const mongoose = require('mongoose');
const Application = require('../models/Application');
const ScreeningForm = require('../models/ScreeningForm');
const IntakeForm = require('../models/IntakeForm');
const { READY_STATUSES } = require('./adminStudentListService');
const { normalizeApplicationIds } = require('../utils/applicationIds');
const { aestDayStartUtc, aestDayEndUtc } = require('../utils/aestTime');

// Non-terminal ("active") application statuses — same set the campaign path uses.
const ACTIVE_STATUSES = [
  'New', 'WaitingForPayment', 'StudentIntakeForm', 'UploadDocuments',
  'DocumentsUploaded', 'StudentCompleted', 'SentToRTO', 'WaitingForVerification',
  'ReadyForRTOPayment', 'RTOInvoiceUploaded',
];

function oid(v) {
  return mongoose.isValidObjectId(v) ? new mongoose.Types.ObjectId(v) : v;
}

function toArray(v) {
  if (v === undefined || v === null) return [];
  const arr = Array.isArray(v) ? v : [v];
  return arr.filter((x) => x !== '' && x !== null && x !== undefined);
}

/** AND a second id set into an existing `_id.$in` (state → applicationId lookup). */
function intersectIds(filter, ids) {
  if (filter._id && Array.isArray(filter._id.$in)) {
    const set = new Set(ids.map(String));
    filter._id = { $in: filter._id.$in.filter((x) => set.has(String(x))) };
  } else {
    filter._id = { $in: ids };
  }
}

/** Translate an audienceConfig into a Mongo filter on the Application collection. */
async function buildFilter(audienceConfig = {}) {
  const target = audienceConfig.target || 'all';
  const filters = audienceConfig.filters || {};

  // "Specific applications" — exact ids, ignore other constraints. The picker can
  // hand us display ids (APP95959) as well as _ids, so normalise before querying.
  if (target === 'specific') {
    const ids = await normalizeApplicationIds(toArray(audienceConfig.includeApplicationIds));
    return { _id: { $in: ids } };
  }

  const filter = {};
  const archivedOnly = filters.archivedOnly === true;
  const includeArchived = filters.includeArchived === true || archivedOnly;

  // --- Status ---
  if (archivedOnly) {
    filter.status = 'Archived';
  } else {
    const statuses = toArray(filters.statuses);
    let statusCond = null;
    if (filters.readyForAssessmentOnly === true) statusCond = { $in: READY_STATUSES };
    else if (statuses.length) statusCond = { $in: statuses };
    else if (target === 'active') statusCond = { $in: ACTIVE_STATUSES };
    else if (target === 'leads') statusCond = 'New';

    if (statusCond) {
      filter.status = statusCond; // these sets never include 'Archived'
    } else if (!includeArchived) {
      filter.status = { $ne: 'Archived' };
    }
    // else: includeArchived with no explicit status → no status constraint

    if (target === 'paid') filter.paymentCompleted = true;
    if (target === 'intake') filter.intakeFormSubmitted = true;
  }

  // --- Advanced field filters ---
  const industries = toArray(filters.industries).map(oid);
  if (industries.length) filter.industryId = { $in: industries };

  const quals = toArray(filters.qualifications).map(oid);
  if (quals.length) filter.qualificationId = { $in: quals };

  const sources = toArray(filters.sources);
  if (sources.length) filter['sourceAttribution.source'] = { $in: sources };

  // Lead status = Application.color (Hot/Warm/Neutral/Cold/…), NOT `leadStatus`.
  // 'cleared' is the UI's name for the empty colour, which toArray would otherwise
  // strip along with genuine blanks — map it back to '' explicitly.
  const leadStatuses = toArray(filters.leadStatuses).map((v) => (v === 'cleared' ? '' : v));
  if (leadStatuses.length) {
    filter.color = leadStatuses.includes('')
      ? { $in: [...leadStatuses, null] } // legacy rows have no `color` at all
      : { $in: leadStatuses };
  }

  if (filters.callAttempts !== undefined && filters.callAttempts !== '' && filters.callAttempts !== null) {
    filter.contactAttempts = filters.callAttempts === '5+'
      ? { $gte: 5 }
      : Number(filters.callAttempts);
  }

  // Date range on lead-creation date. The picker hands us a Sydney civil date, so
  // the boundaries must be Sydney day start/end — `setHours` would use the SERVER's
  // timezone and silently shift the window 10 hours on a UTC host.
  if (filters.dateFrom || filters.dateTo) {
    const range = {};
    const from = aestDayStartUtc(String(filters.dateFrom || '').slice(0, 10));
    const to = aestDayEndUtc(String(filters.dateTo || '').slice(0, 10));
    if (from) range.$gte = from;
    if (to) range.$lte = to;
    if (Object.keys(range).length) filter.createdAt = range;
  }

  // State lives on the intake/screening forms — union both → applicationId set.
  const states = toArray(filters.states);
  if (states.length) {
    const [sf, itf] = await Promise.all([
      ScreeningForm.find({ state: { $in: states } }).select('applicationId').lean(),
      IntakeForm.find({ state: { $in: states } }).select('applicationId').lean(),
    ]);
    const ids = [...new Set([...sf, ...itf].map((f) => f.applicationId).filter(Boolean).map(String))];
    intersectIds(filter, ids);
  }

  return filter;
}

/** Resolve to a deduped list of { userId, applicationId, displayApplicationId, email, name, qualification }. */
async function resolveAudience(audienceConfig = {}) {
  const filter = await buildFilter(audienceConfig);
  const excludeIds = toArray(audienceConfig.excludeIds).map(String);

  const apps = await Application.find(filter)
    .select('_id applicationId studentId qualificationId')
    .populate('studentId', 'firstName lastName email status')
    .populate('qualificationId', 'name')
    .lean();

  const byUser = new Map();
  for (const app of apps) {
    const s = app.studentId;
    if (!s || !s.email) continue;
    if (s.status && s.status !== 'active') continue;
    const key = String(s._id);
    if (excludeIds.includes(key)) continue;
    if (byUser.has(key)) continue; // one email per student
    byUser.set(key, {
      userId: s._id,
      applicationId: app._id,
      displayApplicationId: app.applicationId || null,
      email: s.email.trim().toLowerCase(),
      name: `${s.firstName || ''} ${s.lastName || ''}`.trim() || s.email,
      qualification: app.qualificationId?.name || null,
    });
  }
  return [...byUser.values()];
}

/** Preview count + a small sample of the resolved audience. */
async function countAudience(audienceConfig = {}) {
  const recipients = await resolveAudience(audienceConfig);
  return {
    count: recipients.length,
    sample: recipients.slice(0, 5).map((r) => ({ name: r.name, email: r.email })),
  };
}

module.exports = {
  resolveAudience,
  countAudience,
  buildFilter,
  ACTIVE_STATUSES,
};
