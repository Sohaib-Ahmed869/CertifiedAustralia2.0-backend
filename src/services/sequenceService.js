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
const { transportFor, reserveQuota, injectPreheader } = require('./campaignSendService');
const { interpolate } = require('./emailTemplateService');
const { injectPixel, prependLogoHeader } = require('./sequenceTrackingService');

let emitSequenceProgress = () => {};
try {
  ({ emitSequenceProgress } = require('../socket'));
} catch { /* socket may be absent in scripts */ }

const SEND_THROTTLE_MS = 150;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let running = false; // overlap guard for the cron

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
  } else if (!enr.steps.some((s) => s.status === 'pending')) {
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

async function sendStepToEnrollment(seq, stepDef, enrollmentId) {
  // Re-read immediately before sending — an open since the tick started aborts us.
  const enr = await SequenceEnrollment.findById(enrollmentId);
  if (!enr || enr.status !== 'active') return 'skip';
  const stepEntry = (enr.steps || []).find((s) => s.stepId === stepDef.stepId);
  if (!stepEntry || stepEntry.status !== 'pending') return 'skip';

  // The sequence's chosen mailbox must be available + within quota, else retry later.
  const mailbox = await Mailbox.findById(seq.mailboxId);
  if (!mailbox || !mailbox.isActive || mailbox.healthStatus === 'unhealthy') return 'unavailable';
  if (mailbox.cooldownUntil && new Date(mailbox.cooldownUntil) > new Date()) return 'unavailable';
  const quotaOk = await reserveQuota(mailbox);
  if (!quotaOk) return 'unavailable';

  const vars = buildVars(enr);
  const subject = interpolate(stepDef.subject || seq.name || '', vars);
  let html = interpolate(stepDef.htmlContent || '', vars);
  html = prependLogoHeader(html);
  html = injectPreheader(html, stepDef.previewText);
  html = injectPixel(html, stepEntry.trackingToken);

  try {
    const info = await transportFor(mailbox).sendMail({
      from: mailbox.displayName ? `"${mailbox.displayName}" <${mailbox.email}>` : mailbox.email,
      to: enr.email,
      subject,
      html,
      replyTo: stepDef.replyTo || undefined,
    });
    if (info.rejected && info.rejected.length) throw new Error('Address rejected by SMTP server');

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
    return 'sent';
  } catch (err) {
    // Distinguish a mailbox/transport problem (retry the step later) from a real
    // recipient failure. Connection/auth codes and 4xx responses are transient.
    const code = err.code || '';
    const transient = ['EAUTH', 'ECONNECTION', 'ECONNREFUSED', 'ETIMEDOUT', 'ESOCKET', 'EDNS'].includes(code)
      || (Number(err.responseCode) >= 400 && Number(err.responseCode) < 500);
    if (transient && !/rejected/i.test(err.message || '')) {
      return 'unavailable'; // leave the step pending; next tick retries
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
      return 'mailbox_unavailable';
    }
    if (outcome === 'sent' || outcome === 'failed' || outcome === 'bounced') {
      await sleep(SEND_THROTTLE_MS);
    }
  }

  // Prompt completion if everyone went terminal this pass.
  const remaining = await SequenceEnrollment.countDocuments({ sequenceId: seq._id, status: 'active' });
  if (remaining === 0) await completeSequence(seq._id);
  return null;
}

async function runSequenceTick() {
  if (running) return;
  running = true;
  try {
    const now = Date.now();
    const seqs = await Sequence.find({ status: 'active' }).lean();
    for (const seq of seqs) {
      const outcome = await processSequence(seq, now)
        .catch((e) => { console.error(`[sequence] tick error (${seq.sequenceId}):`, e.message); return null; });
      if (outcome === 'mailbox_unavailable') break;
    }
  } catch (err) {
    console.error('[sequence] runSequenceTick error:', err.message);
  } finally {
    running = false;
  }
}

/** On-demand tick for one sequence (POST /:id/run-now). */
async function runSequenceNow(sequenceId) {
  const seq = await Sequence.findById(sequenceId).lean();
  if (!seq) throw new AppError('Sequence not found', 404);
  if (seq.status !== 'active') throw new AppError('Only an active sequence can be run', 400);
  await processSequence(seq, Date.now());
  return Sequence.findById(sequenceId).lean();
}

module.exports = {
  runSequenceTick,
  runSequenceNow,
};
