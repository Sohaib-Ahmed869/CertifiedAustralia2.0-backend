const crypto = require('crypto');
const asyncHandler = require('../utils/asyncHandler');
const AppError = require('../utils/AppError');
const Sequence = require('../models/Sequence');
const SequenceEnrollment = require('../models/SequenceEnrollment');
const SequenceRecipient = require('../models/SequenceRecipient');
const EmailTemplate = require('../models/EmailTemplate');
const audienceService = require('../services/sequenceAudienceService');
const { makeToken } = require('../services/campaignTrackingService');
const { emitSequenceProgress } = require('../socket');

/* ═══════════════════════════════════════════════════════
   HELPERS
   ═══════════════════════════════════════════════════════ */

/** `active` is derived, never stored: totalEnrolled − (opened + completed + bounced). */
function withDerivedStats(stats = {}) {
  const s = {
    totalEnrolled: 0, opened: 0, completed: 0, bounced: 0, sent: 0, failed: 0, byStep: {},
    ...stats,
  };
  s.active = Math.max(0, (s.totalEnrolled || 0) - (s.opened || 0) - (s.completed || 0) - (s.bounced || 0));
  return s;
}

function withDerived(seq) {
  if (!seq) return seq;
  return { ...seq, stats: withDerivedStats(seq.stats) };
}

async function generateSequenceId() {
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const suffix = String(10000 + Math.floor(Math.random() * 90000));
    const sequenceId = `SEQ${suffix}`;
    // eslint-disable-next-line no-await-in-loop
    const existing = await Sequence.exists({ sequenceId });
    if (!existing) return sequenceId;
  }
  throw new AppError('Unable to generate sequence ID', 500);
}

function normalizeSteps(steps) {
  if (!Array.isArray(steps)) return [];
  return steps.map((s, i) => ({
    stepId: s.stepId || crypto.randomUUID(),
    order: i,
    templateId: s.templateId || null,
    templateName: s.templateName || null,
    subject: s.subject || null,
    previewText: s.previewText || null,
    replyTo: s.replyTo || null,
    sendAt: s.sendAt || null,
    htmlContent: s.htmlContent || null,
  }));
}

function initByStep(steps) {
  const byStep = {};
  (steps || []).forEach((s) => {
    byStep[s.stepId] = { sent: 0, opened: 0, bounced: 0, failed: 0 };
  });
  return byStep;
}

/** Materialise enrollments in the background, then flip the sequence to active. */
async function enrollSequence(sequence, recipients) {
  const seqId = sequence._id;
  for (const r of recipients) {
    const enrollmentKey = makeToken(seqId, r.email);
    const steps = (sequence.steps || []).map((s) => ({
      stepId: s.stepId,
      order: s.order,
      status: 'pending',
      trackingToken: makeToken(`${seqId}:${s.stepId}`, r.email),
    }));
    // eslint-disable-next-line no-await-in-loop
    await SequenceEnrollment.updateOne(
      { sequenceId: seqId, userId: r.userId },
      {
        $setOnInsert: {
          sequenceId: seqId,
          enrollmentKey,
          mailboxId: sequence.mailboxId || null,
          email: r.email,
          name: r.name,
          userId: r.userId,
          applicationId: r.applicationId || null,
          displayApplicationId: r.displayApplicationId || null,
          qualification: r.qualification || null,
          status: 'active',
          steps,
          enrolledAt: new Date(),
        },
      },
      { upsert: true }
    ).catch((e) => { if (e.code !== 11000) throw e; });
  }

  const total = await SequenceEnrollment.countDocuments({ sequenceId: seqId });
  await Sequence.updateOne(
    { _id: seqId },
    { $set: { status: 'active', startedAt: new Date(), 'stats.totalEnrolled': total } }
  );
  const fresh = await Sequence.findById(seqId).select('stats status').lean();
  if (fresh) emitSequenceProgress(seqId, fresh.stats, fresh.status);
}

/* ═══════════════════════════════════════════════════════
   CRUD + LIST
   ═══════════════════════════════════════════════════════ */

const getSequences = asyncHandler(async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(200, parseInt(req.query.limit, 10) || 20);
  const filter = {};
  if (req.query.status) filter.status = req.query.status;

  const [items, total] = await Promise.all([
    Sequence.find(filter)
      .populate('mailboxId', 'email displayName')
      .populate('createdBy', 'firstName lastName')
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    Sequence.countDocuments(filter),
  ]);

  res.status(200).json({
    items: items.map(withDerived),
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
  });
});

const getSequenceStats = asyncHandler(async (req, res) => {
  const [result] = await Sequence.aggregate([
    {
      $facet: {
        byStatus: [{ $group: { _id: '$status', count: { $sum: 1 } } }],
        totals: [
          {
            $group: {
              _id: null,
              totalEnrolled: { $sum: '$stats.totalEnrolled' },
              opened: { $sum: '$stats.opened' },
              completed: { $sum: '$stats.completed' },
              bounced: { $sum: '$stats.bounced' },
              sent: { $sum: '$stats.sent' },
            },
          },
        ],
      },
    },
  ]);

  const statusMap = {};
  (result?.byStatus || []).forEach(({ _id, count }) => { statusMap[_id] = count; });
  const totals = result?.totals?.[0] || {};

  res.status(200).json({
    byStatus: statusMap,
    total: Object.values(statusMap).reduce((sum, c) => sum + c, 0),
    totalEnrolled: totals.totalEnrolled || 0,
    totalOpened: totals.opened || 0,
    totalCompleted: totals.completed || 0,
    totalBounced: totals.bounced || 0,
    totalSent: totals.sent || 0,
  });
});

const getSequenceById = asyncHandler(async (req, res) => {
  const sequence = await Sequence.findById(req.params.id)
    .populate('mailboxId', 'email displayName')
    .populate('createdBy', 'firstName lastName')
    .lean();
  if (!sequence) throw new AppError('Sequence not found', 404);
  res.status(200).json({ item: withDerived(sequence) });
});

const getSequenceEnrollments = asyncHandler(async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(200, parseInt(req.query.limit, 10) || 50);
  const filter = { sequenceId: req.params.id };
  if (req.query.status) filter.status = req.query.status;

  const [rows, total] = await Promise.all([
    SequenceEnrollment.find(filter)
      .select('email name status openedAt openedAtOrder openedStepId steps enrolledAt')
      .lean(),
    SequenceEnrollment.countDocuments(filter),
  ]);

  // Openers first, then most-recently enrolled.
  const rank = { opened: 0, bounced: 1, completed: 2, active: 3 };
  rows.sort((a, b) => {
    const r = (rank[a.status] ?? 9) - (rank[b.status] ?? 9);
    if (r !== 0) return r;
    return new Date(b.enrolledAt || 0) - new Date(a.enrolledAt || 0);
  });

  const items = rows.slice((page - 1) * limit, page * limit).map((e) => ({
    email: e.email,
    name: e.name,
    status: e.status,
    openedAt: e.openedAt,
    openedAtOrder: e.openedAtOrder,
    stepsSent: (e.steps || []).filter((s) => ['sent', 'opened', 'bounced'].includes(s.status)).length,
    totalSteps: (e.steps || []).length,
  }));

  res.status(200).json({ items, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
});

const createSequence = asyncHandler(async (req, res) => {
  const { name } = req.body;
  if (!name) throw new AppError('Sequence name is required', 400);

  const steps = normalizeSteps(req.body.steps);
  const sequenceId = await generateSequenceId();

  const sequence = await Sequence.create({
    sequenceId,
    name,
    description: req.body.description || '',
    audienceConfig: req.body.audienceConfig || { target: 'all', filters: {}, excludeIds: [], includeApplicationIds: [] },
    mailboxId: req.body.mailboxId || null,
    steps,
    status: 'draft',
    stats: { totalEnrolled: 0, opened: 0, completed: 0, bounced: 0, sent: 0, failed: 0, byStep: initByStep(steps) },
    createdBy: req.user._id,
  });

  res.status(201).json({ item: withDerived(sequence.toObject()) });
});

const updateSequence = asyncHandler(async (req, res) => {
  const sequence = await Sequence.findById(req.params.id);
  if (!sequence) throw new AppError('Sequence not found', 404);
  if (sequence.status !== 'draft') throw new AppError('Only a draft sequence can be edited', 400);

  const { name, description, audienceConfig, mailboxId } = req.body;
  if (name !== undefined) sequence.name = name;
  if (description !== undefined) sequence.description = description;
  if (audienceConfig !== undefined) sequence.audienceConfig = audienceConfig;
  if (mailboxId !== undefined) sequence.mailboxId = mailboxId || null;

  if (req.body.steps !== undefined) {
    sequence.steps = normalizeSteps(req.body.steps);
    sequence.stats.byStep = initByStep(sequence.steps);
    sequence.markModified('stats');
  }

  await sequence.save();
  res.status(200).json({ item: withDerived(sequence.toObject()) });
});

const duplicateSequence = asyncHandler(async (req, res) => {
  const source = await Sequence.findById(req.params.id).lean();
  if (!source) throw new AppError('Sequence not found', 404);

  // Clone into a fresh draft: new step ids, cleared HTML snapshots (re-snapshot on
  // start), reset stats/enrollments. The full audienceConfig (incl. filters) carries
  // over so it can be tweaked and re-launched.
  const steps = (source.steps || []).map((s, i) => ({
    stepId: crypto.randomUUID(),
    order: i,
    templateId: s.templateId || null,
    templateName: s.templateName || null,
    subject: s.subject || null,
    previewText: s.previewText || null,
    replyTo: s.replyTo || null,
    sendAt: s.sendAt || null,
    htmlContent: null,
  }));

  const sequenceId = await generateSequenceId();
  const dup = await Sequence.create({
    sequenceId,
    name: `${source.name} (copy)`,
    description: source.description || '',
    audienceConfig: source.audienceConfig || { target: 'all', filters: {}, excludeIds: [], includeApplicationIds: [] },
    mailboxId: source.mailboxId || null,
    steps,
    status: 'draft',
    stats: { totalEnrolled: 0, opened: 0, completed: 0, bounced: 0, sent: 0, failed: 0, byStep: initByStep(steps) },
    createdBy: req.user._id,
  });

  res.status(201).json({ item: withDerived(dup.toObject()) });
});

const deleteSequence = asyncHandler(async (req, res) => {
  const sequence = await Sequence.findById(req.params.id);
  if (!sequence) throw new AppError('Sequence not found', 404);
  if (sequence.status === 'active' || sequence.status === 'paused') {
    throw new AppError('Cancel the sequence before deleting it', 400);
  }
  await Promise.all([
    SequenceEnrollment.deleteMany({ sequenceId: sequence._id }),
    SequenceRecipient.deleteMany({ sequenceId: sequence._id }),
  ]);
  await sequence.deleteOne();
  res.status(200).json({ message: 'Sequence deleted' });
});

/* ═══════════════════════════════════════════════════════
   AUDIENCE
   ═══════════════════════════════════════════════════════ */

const getAudienceCount = asyncHandler(async (req, res) => {
  const audienceConfig = req.body.audienceConfig || req.body || {};
  const result = await audienceService.countAudience(audienceConfig);
  res.status(200).json(result);
});

/* ═══════════════════════════════════════════════════════
   LIFECYCLE
   ═══════════════════════════════════════════════════════ */

const startSequence = asyncHandler(async (req, res) => {
  const sequence = await Sequence.findById(req.params.id);
  if (!sequence) throw new AppError('Sequence not found', 404);
  if (sequence.status !== 'draft') throw new AppError('Only a draft sequence can be started', 400);
  if (!sequence.mailboxId) throw new AppError('Select a sending mailbox before starting', 400);
  if (!sequence.steps || sequence.steps.length === 0) throw new AppError('Add at least one step before starting', 400);

  for (const s of sequence.steps) {
    if (!s.templateId) throw new AppError(`Step ${s.order + 1} needs a template`, 400);
    if (!s.sendAt) throw new AppError(`Step ${s.order + 1} needs a send time`, 400);
  }

  // Snapshot template content so later template edits don't mutate an in-flight drip.
  for (const s of sequence.steps) {
    // eslint-disable-next-line no-await-in-loop
    const tpl = await EmailTemplate.findById(s.templateId).lean();
    if (!tpl) throw new AppError(`Template not found for step ${s.order + 1}`, 404);
    s.htmlContent = tpl.body || '';
    s.subject = s.subject || tpl.subject || sequence.name;
    s.templateName = tpl.name || s.templateName;
  }
  sequence.markModified('steps');
  await sequence.save();

  const recipients = await audienceService.resolveAudience(sequence.audienceConfig);
  if (!recipients.length) throw new AppError('No recipients matched this audience', 400);

  // Respond immediately; enroll + activate in the background so the scheduler
  // never sees a half-enrolled sequence.
  res.status(202).json({ message: 'Sequence starting', totalRecipients: recipients.length });
  enrollSequence(sequence, recipients).catch((err) =>
    console.error('[sequence] enrollment error:', err.message)
  );
});

const pauseSequence = asyncHandler(async (req, res) => {
  const sequence = await Sequence.findById(req.params.id);
  if (!sequence) throw new AppError('Sequence not found', 404);
  if (sequence.status !== 'active') throw new AppError('Only an active sequence can be paused', 400);
  sequence.status = 'paused';
  await sequence.save();
  emitSequenceProgress(sequence._id, sequence.stats, sequence.status);
  res.status(200).json({ item: withDerived(sequence.toObject()) });
});

const resumeSequence = asyncHandler(async (req, res) => {
  const sequence = await Sequence.findById(req.params.id);
  if (!sequence) throw new AppError('Sequence not found', 404);
  if (sequence.status !== 'paused') throw new AppError('Only a paused sequence can be resumed', 400);
  sequence.status = 'active';
  await sequence.save();
  emitSequenceProgress(sequence._id, sequence.stats, sequence.status);
  res.status(200).json({ item: withDerived(sequence.toObject()) });
});

const cancelSequence = asyncHandler(async (req, res) => {
  const sequence = await Sequence.findById(req.params.id);
  if (!sequence) throw new AppError('Sequence not found', 404);
  if (!['draft', 'active', 'paused'].includes(sequence.status)) {
    throw new AppError(`Cannot cancel a ${sequence.status} sequence`, 400);
  }
  sequence.status = 'cancelled';
  await sequence.save();
  emitSequenceProgress(sequence._id, sequence.stats, sequence.status);
  res.status(200).json({ item: withDerived(sequence.toObject()) });
});

const runSequenceNow = asyncHandler(async (req, res) => {
  // Lazy require to avoid a require cycle at module load.
  const { runSequenceNow: runNow } = require('../services/sequenceService');
  const result = await runNow(req.params.id);
  res.status(200).json({ item: withDerived(result) });
});

module.exports = {
  getSequences,
  getSequenceStats,
  getSequenceById,
  getSequenceEnrollments,
  createSequence,
  updateSequence,
  duplicateSequence,
  deleteSequence,
  getAudienceCount,
  startSequence,
  pauseSequence,
  resumeSequence,
  cancelSequence,
  runSequenceNow,
};
