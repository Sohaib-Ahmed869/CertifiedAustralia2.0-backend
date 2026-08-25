/**
 * Email-sequence (drip) send engine.
 *
 * A cron tick (every 5 min) sends each active enrollment's earliest DUE step.
 * The governing rule is "open = stop": sends re-read the enrollment immediately
 * before dispatch and abort if it opened since the tick started. Shares the
 * campaign mailbox pool + quota (via campaignSendService helpers) so both
 * features draw from one send budget.
 */
const Sequence = require('../models/Sequence');
const SequenceEnrollment = require('../models/SequenceEnrollment');
const SequenceRecipient = require('../models/SequenceRecipient');
const Mailbox = require('../models/Mailbox');
const AppError = require('../utils/AppError');
const {
  transportFor, reserveQuota, releaseQuota, injectPreheader,
  isThrottleError, coolDownMailbox, expireCooldowns,
} = require('./campaignSendService');
const { interpolate } = require('./emailTemplateService');
const { injectPixel, prependLogoHeader } = require('./sequenceTrackingService');

let emitSequenceProgress = () => {};
try {
  ({ emitSequenceProgress } = require('../socket'));
} catch { /* socket may be absent in scripts */ }

const SEND_THROTTLE_MS = 150;

// Pacing, ported from the legacy portal's marketingSequenceScheduler: a sequence
// sends at most BATCH_SIZE real emails per batch, then waits BATCH_INTERVAL before
// the next one. 400 due emails go out as 50 → wait → 50 → …, not 400 SMTP sessions
// in one burst, which is what tripped Gmail's 454 "Too many login attempts" there.
const BATCH_SIZE = Number(process.env.SEQ_BATCH_SIZE) || 50;
const BATCH_INTERVAL_MS = (Number(process.env.SEQ_BATCH_INTERVAL_MIN) || 20) * 60 * 1000;
// A `sending` claim older than this belonged to a process that died mid-send.
const STALE_CLAIM_MS = 10 * 60 * 1000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let running = false; // overlap guard — shared by the cron tick AND "Run due now"

/* ═══════════════════════════════════════════════════════
   HELPERS
   ═══════════════════════════════════════════════════════ */

function buildVars(enr) {
  const name = enr.name || '';
  const parts = name.split(' ');
  return {
    firstName: parts[0] || '',
    lastName: parts.slice(1).join(' ') || '',
    name,
    email: enr.email || '',
    qualification: enr.qualification || '',
    qualificationName: enr.qualification || '',
    applicationId: enr.displayApplicationId || '',
  };
}

async function emitProgress(sequenceId) {
  const s = await Sequence.findById(sequenceId).select('stats status').lean();
  if (s) emitSequenceProgress(sequenceId, s.stats, s.status);
}

/**
 * Record a step outcome on the enrollment and return the enrollment-level terminal
 * transition, if any ('bounced' | 'completed' | null). A hard bounce is terminal;
 * a sent/failed step completes the enrollment only once no pending steps remain.
 */
async function applyStepOutcome(enrollmentId, stepDef, outcome, extra = {}) {
  const enr = await SequenceEnrollment.findById(enrollmentId);
  if (!enr || enr.status !== 'active') return null;
  const step = enr.steps.find((s) => s.stepId === stepDef.stepId);
  if (!step) return null;

  step.status = outcome; // 'sent' | 'failed' | 'bounced'
  if (outcome === 'sent') { step.sentAt = new Date(); step.messageId = extra.messageId || null; }
  if (extra.failureReason) step.failureReason = String(extra.failureReason).slice(0, 300);

  let transition = null;
  if (outcome === 'bounced') {
    enr.status = 'bounced';
    transition = 'bounced';
  } else if (!enr.steps.some((s) => s.status === 'pending' || s.status === 'sending')) {
    enr.status = 'completed';
    enr.completedAt = new Date();
    transition = 'completed';
  }

  enr.markModified('steps');
  await enr.save();
  return transition;
}

/* ═══════════════════════════════════════════════════════
   SEND
   ═══════════════════════════════════════════════════════ */

/**
 * Atomically claim a due step (pending → sending) so exactly one runner can send
 * it. A plain read-then-send-then-write leaves the whole SMTP round-trip as a race
 * window, and two runners (concurrent cron tick, "Run due now", a second server
 * instance) both saw `pending` and both sent — the recipient got the email twice.
 * Returns the reloaded enrollment, or null if someone else already has it.
 */
async function claimStep(enrollmentId, stepId) {
  return SequenceEnrollment.findOneAndUpdate(
    {
      _id: enrollmentId,
      status: 'active',
      steps: { $elemMatch: { stepId, status: 'pending' } },
    },
    { $set: { 'steps.$.status': 'sending', 'steps.$.claimedAt': new Date() } },
    { new: true },
  );
}

/** Hand a claimed step back — the send never happened, so a later tick retries it. */
async function releaseStep(enrollmentId, stepId) {
  await SequenceEnrollment.updateOne(
    { _id: enrollmentId, steps: { $elemMatch: { stepId, status: 'sending' } } },
    { $set: { 'steps.$.status': 'pending' }, $unset: { 'steps.$.claimedAt': '' } },
  ).catch(() => {});
}

/**
 * Release claims orphaned by a process that died mid-send. Runs at the top of each
 * tick; the window is generous because a slow SMTP handshake is not a crash.
 */
async function reapStaleClaims() {
  const cutoff = new Date(Date.now() - STALE_CLAIM_MS);
  const stale = await SequenceEnrollment.find({
    status: 'active',
    steps: { $elemMatch: { status: 'sending', claimedAt: { $lt: cutoff } } },
  }).select('_id steps').lean();

  for (const enr of stale) {
    for (const s of enr.steps || []) {
      if (s.status === 'sending' && s.claimedAt && new Date(s.claimedAt) < cutoff) {
        // eslint-disable-next-line no-await-in-loop
        await releaseStep(enr._id, s.stepId);
        console.warn(`[sequence] released stale claim on step ${s.stepId} (enrollment ${enr._id})`);
      }
    }
  }
}

async function sendStepToEnrollment(seq, stepDef, enrollmentId) {
  // Claim first: this both re-checks "open = stop" (the filter requires an active
  // enrollment) and locks the step against a concurrent runner.
  const enr = await claimStep(enrollmentId, stepDef.stepId);
  if (!enr) return 'skip';
  const stepEntry = (enr.steps || []).find((s) => s.stepId === stepDef.stepId);
  if (!stepEntry) { await releaseStep(enrollmentId, stepDef.stepId); return 'skip'; }

  // The sequence's chosen mailbox must be available + within quota, else retry later.
  const mailbox = await Mailbox.findById(seq.mailboxId);
  if (!mailbox || !mailbox.isActive || mailbox.healthStatus === 'unhealthy'
    || (mailbox.cooldownUntil && new Date(mailbox.cooldownUntil) > new Date())) {
    await releaseStep(enrollmentId, stepDef.stepId);
    return 'unavailable';
  }
  const quotaOk = await reserveQuota(mailbox);
  if (!quotaOk) {
    await releaseStep(enrollmentId, stepDef.stepId);
    return 'unavailable';
  }

  const vars = buildVars(enr);
  const subject = interpolate(stepDef.subject || seq.name || '', vars);
  let html = interpolate(stepDef.htmlContent || '', vars);
  html = prependLogoHeader(html);
  html = injectPreheader(html, stepDef.previewText);
  html = injectPixel(html, stepEntry.trackingToken);

  let info;
  try {
    info = await transportFor(mailbox).sendMail({
      from: mailbox.displayName ? `"${mailbox.displayName}" <${mailbox.email}>` : mailbox.email,
      to: enr.email,
      subject,
      html,
      replyTo: stepDef.replyTo || undefined,
    });
    if (info.rejected && info.rejected.length) throw new Error('Address rejected by SMTP server');
  } catch (err) {
    // Distinguish a mailbox/transport problem (retry the step later) from a real
    // recipient failure. Connection/auth codes and 4xx responses are transient.
    const code = err.code || '';
    const transient = ['EAUTH', 'ECONNECTION', 'ECONNREFUSED', 'ETIMEDOUT', 'ESOCKET', 'EDNS'].includes(code)
      || (Number(err.responseCode) >= 400 && Number(err.responseCode) < 500);
    if (transient && !/rejected/i.test(err.message || '')) {
      // Nothing was delivered: hand the quota and the claim back, and if the server
      // is throttling us (Gmail's 454 "Too many login attempts") park the mailbox so
      // the next tick doesn't walk straight back into the same wall.
      await releaseQuota(mailbox);
      await releaseStep(enrollmentId, stepDef.stepId);
      if (isThrottleError(err)) await coolDownMailbox(mailbox, err);
      return 'unavailable'; // step is pending again; a later tick retries it
    }

    const isHardBounce = Number(err.responseCode) >= 500;
    const outStatus = isHardBounce ? 'bounced' : 'failed';
    await SequenceRecipient.create({
      trackingToken: stepEntry.trackingToken,
      sequenceId: seq._id,
      stepId: stepDef.stepId,
      stepOrder: stepDef.order,
      enrollmentId: enr._id,
      mailboxId: mailbox._id,
      userId: enr.userId,
      email: enr.email,
      name: enr.name,
      applicationId: enr.applicationId,
      status: outStatus,
      failureReason: (err.message || 'Send failed').slice(0, 300),
      failureCode: err.responseCode ? String(err.responseCode) : null,
      sentAt: new Date(),
    }).catch(() => {});

    const transition = await applyStepOutcome(enr._id, stepDef, outStatus, { failureReason: err.message });
    const inc = { [`stats.byStep.${stepDef.stepId}.${outStatus}`]: 1 };
    inc[`stats.${outStatus}`] = 1;
    if (transition === 'completed') inc['stats.completed'] = 1;
    await Sequence.updateOne({ _id: seq._id }, { $inc: inc });
    await emitProgress(seq._id);
    return outStatus;
  }

  // ── The message IS delivered from here on. ──
  // Bookkeeping gets its OWN guard: a failure here (duplicate token, a dropped
  // connection while writing) must never be re-read as a send failure, or the
  // sequence reports a phantom `failed` for an email the student actually received.
  try {
    await SequenceRecipient.create({
      trackingToken: stepEntry.trackingToken,
      sequenceId: seq._id,
      stepId: stepDef.stepId,
      stepOrder: stepDef.order,
      enrollmentId: enr._id,
      mailboxId: mailbox._id,
      userId: enr.userId,
      email: enr.email,
      name: enr.name,
      applicationId: enr.applicationId,
      status: 'sent',
      messageId: info.messageId || null,
      sentAt: new Date(),
      openCount: 0,
    });

    const transition = await applyStepOutcome(enr._id, stepDef, 'sent', { messageId: info.messageId });
    const inc = { 'stats.sent': 1, [`stats.byStep.${stepDef.stepId}.sent`]: 1 };
    if (transition === 'completed') inc['stats.completed'] = 1;
    await Sequence.updateOne({ _id: seq._id }, { $inc: inc });
    await emitProgress(seq._id);
  } catch (err) {
    console.error(`[sequence] post-send bookkeeping failed (${seq.sequenceId}, ${enr.email}):`, err.message);
    // Never leave the step claimed — it was sent, so mark it sent even if the
    // recipient row or the counters didn't make it.
    await applyStepOutcome(enr._id, stepDef, 'sent', { messageId: info?.messageId }).catch(() => {});
  }
  return 'sent';
}

/* ═══════════════════════════════════════════════════════
   TICK
   ═══════════════════════════════════════════════════════ */

async function completeSequence(sequenceId) {
  await Sequence.updateOne(
    { _id: sequenceId, status: 'active' },
    { $set: { status: 'completed', completedAt: new Date() } }
  );
  await emitProgress(sequenceId);
}

async function processSequence(seq, now) {
  const stepDefById = {};
  for (const s of seq.steps || []) stepDefById[s.stepId] = s;

  const enrollments = await SequenceEnrollment.find({ sequenceId: seq._id, status: 'active' });
  if (enrollments.length === 0) {
    await completeSequence(seq._id);
    return null;
  }

  // Pacing gate: keep ≥ BATCH_INTERVAL between batches so a big audience never goes
  // out as one burst. Only applies once a batch has actually been filled.
  if (seq.lastBatchAt && Date.now() - new Date(seq.lastBatchAt).getTime() < BATCH_INTERVAL_MS) {
    return null;
  }

  let sentThisBatch = 0;

  for (const enr of enrollments) {
    // Earliest pending step whose absolute sendAt is due.
    const dueStep = (enr.steps || [])
      .filter((es) => es.status === 'pending')
      .sort((a, b) => a.order - b.order)
      .find((es) => {
        const def = stepDefById[es.stepId];
        return def && def.sendAt && new Date(def.sendAt).getTime() <= now;
      });
    if (!dueStep) continue;

    const outcome = await sendStepToEnrollment(seq, stepDefById[dueStep.stepId], enr._id)
      .catch((e) => { console.error(`[sequence] send error (${seq.sequenceId}):`, e.message); return 'error'; });

    if (outcome === 'unavailable') {
      // The (shared) mailbox can't send right now — every remaining sequence would
      // hit the same wall this tick. Stop; the next tick retries from the top once
      // the mailbox frees. Prevents one cap hit cascading into failed steps.
      // Deliberately NOT stamped as a batch — the mailbox gate (quota/cooldown)
      // already decides when we may try again; adding 20 min on top would stall
      // a sequence that only needed to wait out an hourly cap.
      return 'mailbox_unavailable';
    }
    if (outcome === 'sent' || outcome === 'failed' || outcome === 'bounced') {
      sentThisBatch += 1;
      if (sentThisBatch >= BATCH_SIZE) {
        // Batch full — stop here and let BATCH_INTERVAL elapse. Everyone still
        // pending keeps their step pending, so nobody is skipped.
        await stampBatch(seq._id);
        console.log(`[sequence] ${seq.sequenceId}: batch of ${sentThisBatch} sent, pausing ${BATCH_INTERVAL_MS / 60000} min`);
        return null;
      }
      await sleep(SEND_THROTTLE_MS);
    }
  }

  // Prompt completion if everyone went terminal this pass.
  const remaining = await SequenceEnrollment.countDocuments({ sequenceId: seq._id, status: 'active' });
  if (remaining === 0) await completeSequence(seq._id);
  return null;
}

/** Stamp the batch time so the next batch waits BATCH_INTERVAL. */
async function stampBatch(sequenceId) {
  await Sequence.updateOne({ _id: sequenceId }, { $set: { lastBatchAt: new Date() } }).catch(() => {});
}

async function runSequenceTick() {
  if (running) return;
  running = true;
  try {
    await reapStaleClaims().catch((e) => console.error('[sequence] reap error:', e.message));
    await expireCooldowns();
    const now = Date.now();
    const seqs = await Sequence.find({ status: 'active' }).lean();
    // A mailbox that can't send this pass takes out only the sequences that USE it.
    // (This used to `break` the whole tick, so one capped mailbox stalled every
    // other sequence too — wrong as soon as there is more than one mailbox.)
    const blockedMailboxes = new Set();
    for (const seq of seqs) {
      const mbox = String(seq.mailboxId || '');
      if (blockedMailboxes.has(mbox)) continue;
      const outcome = await processSequence(seq, now)
        .catch((e) => { console.error(`[sequence] tick error (${seq.sequenceId}):`, e.message); return null; });
      if (outcome === 'mailbox_unavailable') blockedMailboxes.add(mbox);
    }
  } catch (err) {
    console.error('[sequence] runSequenceTick error:', err.message);
  } finally {
    running = false;
  }
}

/**
 * On-demand tick for one sequence (POST /:id/run-now).
 *
 * Takes the SAME overlap guard as the cron. Without it, clicking "Run due now"
 * while the 5-minute tick happened to be running put two runners on the same
 * enrollment. (The atomic step claim now stops the duplicate send regardless —
 * this just avoids the wasted pass and the confusing double bookkeeping.)
 */
async function runSequenceNow(sequenceId) {
  const seq = await Sequence.findById(sequenceId).lean();
  if (!seq) throw new AppError('Sequence not found', 404);
  if (seq.status !== 'active') throw new AppError('Only an active sequence can be run', 400);
  if (running) throw new AppError('A send pass is already running — try again in a moment', 409);

  running = true;
  try {
    // Bypass the batch pacing gate: this is an explicit human "go now".
    await processSequence({ ...seq, lastBatchAt: null }, Date.now());
  } finally {
    running = false;
  }
  return Sequence.findById(sequenceId).lean();
}

module.exports = {
  runSequenceTick,
  runSequenceNow,
};
