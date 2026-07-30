/**
 * Open-tracking for email sequences — the "open = stop" engine's read side.
 *
 * Reuses the campaign token/secret/grace primitives (same HMAC secret + pixel
 * host env) but keys per (sequence, step, email) and drives the sequence's own
 * enrollment/recipient state. Also holds the pixel + logo-header injectors used
 * by the send worker.
 */
const Sequence = require('../models/Sequence');
const SequenceEnrollment = require('../models/SequenceEnrollment');
const SequenceRecipient = require('../models/SequenceRecipient');
const { makeToken, OPEN_GRACE_MS } = require('./campaignTrackingService');

let emitSequenceProgress = () => {};
try {
  ({ emitSequenceProgress } = require('../socket'));
} catch { /* socket may be absent in scripts */ }

// Certified Australia brand logo — prepended above every sequence email.
const CERTIFIED_LOGO_URL =
  'https://logosca.s3.ap-southeast-2.amazonaws.com/image-removebg-preview+(18).png';

/** Pixel URL for the sequence open-tracking endpoint (distinct from campaigns). */
function trackingPixel(token) {
  const base = (process.env.API_PUBLIC_URL || process.env.BACKEND_URL || 'http://localhost:5000').replace(/\/$/, '');
  const url = `${base}/api/track/seq/${token}`;
  return `<img src="${url}" width="1" height="1" alt="" style="display:block;width:1px;height:1px;border:0;overflow:hidden;" />`;
}

function injectPixel(html, token) {
  const pixel = trackingPixel(token);
  return /<\/body>/i.test(html) ? html.replace(/<\/body>/i, `${pixel}</body>`) : (html || '') + pixel;
}

/** Centered logo band above the template content (template markup untouched). */
function prependLogoHeader(html) {
  const band = `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;"><tr><td align="center" style="padding:24px 0 6px;"><img src="${CERTIFIED_LOGO_URL}" alt="Certified Australia" width="180" style="display:block;width:180px;max-width:180px;height:auto;margin:0 auto;border:0;" /></td></tr></table>`;
  if (!html) return band;
  if (/<body[^>]*>/i.test(html)) {
    return html.replace(/(<body[^>]*>)/i, `$1${band}`);
  }
  return band + html;
}

async function emitProgress(sequenceId) {
  const s = await Sequence.findById(sequenceId).select('stats status').lean();
  if (s) emitSequenceProgress(sequenceId, s.stats, s.status);
}

/**
 * Record an open. Idempotent + defended against false positives:
 *  - only 'sent' recipients count (bounced/failed pixels get echoed in DSNs)
 *  - hits inside the grace window are scanners/prefetchers, not humans
 *  - first-open is atomic; only the genuine transition drives handleSequenceOpen
 */
async function trackOpen(token) {
  if (!token) return;
  const recipient = await SequenceRecipient.findOne({ trackingToken: token })
    .select('_id sequenceId stepId stepOrder enrollmentId status sentAt')
    .lean();
  if (!recipient) return;
  if (recipient.status !== 'sent') return; // bounced/failed never count
  if (recipient.sentAt && Date.now() - new Date(recipient.sentAt).getTime() < OPEN_GRACE_MS) return;

  const firstOpen = await SequenceRecipient.updateOne(
    { _id: recipient._id, openedAt: null },
    { $set: { openedAt: new Date() }, $inc: { openCount: 1 } }
  );

  if (firstOpen.modifiedCount) {
    await handleSequenceOpen(recipient);
  } else {
    // Repeat open — bump the raw counter only.
    await SequenceRecipient.updateOne({ _id: recipient._id }, { $inc: { openCount: 1 } });
  }
}

/**
 * Apply the "open = stop" transition: mark the opened step, skip the enrollment's
 * remaining pending steps, move it to the terminal `opened` bucket, and adjust the
 * exclusive stat buckets. The enrollment status flip is guarded atomically so
 * concurrent pixel hits only transition once.
 */
async function handleSequenceOpen(rec) {
  const { sequenceId, stepId, stepOrder, enrollmentId } = rec;
  if (!sequenceId || !enrollmentId) return;
  const now = new Date();

  // Win the first-open race atomically (only one hit flips openedAt null→now).
  const prev = await SequenceEnrollment.findOneAndUpdate(
    { _id: enrollmentId, openedAt: null },
    { $set: { status: 'opened', openedAt: now, openedAtOrder: stepOrder ?? null, openedStepId: stepId ?? null } },
    { new: false }
  );

  if (prev) {
    // We won: mark this step opened + skip all still-pending steps.
    const enr = await SequenceEnrollment.findById(enrollmentId);
    if (enr) {
      enr.steps.forEach((s) => {
        if (s.stepId === stepId) { s.status = 'opened'; s.openedAt = now; }
        else if (s.status === 'pending') { s.status = 'skipped'; }
      });
      enr.markModified('steps');
      await enr.save();
    }
    const inc = { 'stats.opened': 1, [`stats.byStep.${stepId}.opened`]: 1 };
    // Leaving the (previously terminal) completed bucket keeps buckets exclusive.
    if (prev.status === 'completed') inc['stats.completed'] = -1;
    await Sequence.updateOne({ _id: sequenceId }, { $inc: inc });
  } else {
    // Enrollment already opened on some step — just reflect this step's open.
    await SequenceEnrollment.updateOne(
      { _id: enrollmentId, 'steps.stepId': stepId, 'steps.status': { $ne: 'opened' } },
      { $set: { 'steps.$.status': 'opened', 'steps.$.openedAt': now } }
    );
    await Sequence.updateOne({ _id: sequenceId }, { $inc: { [`stats.byStep.${stepId}.opened`]: 1 } });
  }

  await emitProgress(sequenceId);
}

module.exports = {
  makeToken,
  trackingPixel,
  injectPixel,
  prependLogoHeader,
  trackOpen,
  handleSequenceOpen,
};
