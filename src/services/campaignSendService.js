const nodemailer = require('nodemailer');
const Campaign = require('../models/Campaign');
const CampaignRecipient = require('../models/CampaignRecipient');
const Application = require('../models/Application');
const Mailbox = require('../models/Mailbox');
const EmailTemplate = require('../models/EmailTemplate');
const { interpolate } = require('./emailTemplateService');
const { buildFilter } = require('./audienceService');
const { makeToken, trackingPixel } = require('./campaignTrackingService');
const { emitCampaignProgress, emitCampaignCompleted } = require('../socket');

const BATCH_SIZE = 25;
const BATCH_DELAY_MS = 1500;

// One worker per campaign at a time (guards against double-processing / re-entrancy).
const processing = new Set();
// Cached transports keyed by mailbox id.
const transports = new Map();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ═══════════════════════════════════════════════════════
   AUDIENCE RESOLUTION (application-based → unique students)
   ═══════════════════════════════════════════════════════ */

/** Resolve the audience to a deduped list of { leadId, applicationId, email, name, ... }. */
async function resolveAudience(campaign) {
  // Presets AND advanced filters both come from audienceService.buildFilter, the
  // same translator the sequence builder uses — a campaign and a sequence with the
  // same audience must never resolve to different people.
  const query = await buildFilter(campaign.audienceConfig);
  const excludeIds = (campaign.audienceConfig?.excludeIds || []).map(String);

  const apps = await Application.find(query)
    .select('_id applicationId studentId qualificationId')
    .populate('studentId', 'firstName lastName email status role')
    .populate('qualificationId', 'name')
    .lean();

  const byStudent = new Map();
  for (const app of apps) {
    const s = app.studentId;
    if (!s || !s.email) continue;
    if (s.status && s.status !== 'active') continue;
    if (excludeIds.includes(String(s._id))) continue;
    const key = String(s._id);
    if (byStudent.has(key)) continue; // dedupe: one email per student
    byStudent.set(key, {
      leadId: s._id,
      applicationId: app._id,
      email: s.email.trim().toLowerCase(),
      name: `${s.firstName || ''} ${s.lastName || ''}`.trim() || s.email,
      firstName: s.firstName || '',
      lastName: s.lastName || '',
      qualification: app.qualificationId?.name || '',
      applicationDisplayId: app.applicationId || '',
    });
  }
  return [...byStudent.values()];
}

/** Materialise recipient rows for a campaign (idempotent — safe to call again). */
async function buildRecipients(campaign) {
  const audience = await resolveAudience(campaign);
  let created = 0;
  for (const a of audience) {
    const token = makeToken(campaign._id, a.leadId);
    const res = await CampaignRecipient.updateOne(
      { campaignId: campaign._id, leadId: a.leadId },
      {
        $setOnInsert: {
          campaignId: campaign._id,
          leadId: a.leadId,
          applicationId: a.applicationId,
          email: a.email,
          recipientName: a.name,
          firstName: a.firstName,
          lastName: a.lastName,
          qualification: a.qualification,
          applicationDisplayId: a.applicationDisplayId,
          status: 'queued',
          trackingToken: token,
        },
      },
      { upsert: true }
    );
    if (res.upsertedCount) created += 1;
  }
  const total = await CampaignRecipient.countDocuments({ campaignId: campaign._id });
  const queued = await CampaignRecipient.countDocuments({ campaignId: campaign._id, status: 'queued' });
  await Campaign.updateOne(
    { _id: campaign._id },
    { $set: { 'stats.totalRecipients': total, 'stats.queued': queued } }
  );
  return { created, total };
}

/* ═══════════════════════════════════════════════════════
   MAILBOX / TRANSPORT / QUOTA
   ═══════════════════════════════════════════════════════ */

/**
 * Cached, POOLED transport per mailbox.
 *
 * `pool: true` is load-bearing, not a tuning knob. Without it nodemailer opens a
 * fresh connection and a fresh LOGIN for every single message, which is exactly
 * what tripped Gmail's `454 Too many login attempts` on the legacy portal — its
 * fix was one authenticated connection reused across the batch. `maxConnections: 1`
 * keeps it to a single session, `rateLimit` paces messages within that session, and
 * `maxMessages` recycles the connection before providers start refusing a long one.
 */
function transportFor(mailbox) {
  const key = String(mailbox._id);
  if (transports.has(key)) return transports.get(key);
  const t = nodemailer.createTransport({
    host: mailbox.smtpHost,
    port: mailbox.smtpPort || 587,
    secure: (mailbox.smtpPort || 587) === 465,
    auth: { user: mailbox.email, pass: mailbox.appPassword },
    pool: true,
    maxConnections: 1,
    maxMessages: Number(process.env.SMTP_MAX_MESSAGES) || 50,
    rateDelta: 1000,
    rateLimit: Number(process.env.SMTP_RATE_LIMIT) || 3, // messages per second
  });
  transports.set(key, t);
  return t;
}

/** Drop a cached transport (after credential edits, or a poisoned pool). */
function resetTransport(mailboxId) {
  const key = String(mailboxId);
  const t = transports.get(key);
  if (t) { try { t.close(); } catch { /* already closed */ } transports.delete(key); }
}

/** An active, healthy mailbox not in cooldown — or null. */
async function pickMailbox() {
  const now = new Date();
  return Mailbox.findOne({
    isActive: true,
    healthStatus: { $ne: 'unhealthy' },
    $or: [{ cooldownUntil: null }, { cooldownUntil: { $exists: false } }, { cooldownUntil: { $lte: now } }],
  }).sort({ 'usage.sentToday': 1 });
}

/**
 * Reserve one send against a mailbox's hourly/daily quota, resetting windows as
 * they roll over. Returns true if the send may proceed.
 */
async function reserveQuota(mailbox) {
  const now = new Date();
  const usage = mailbox.usage || {};
  const q = mailbox.quotaConfig || {};

  if (!usage.dailyResetAt || now >= usage.dailyResetAt) {
    usage.sentToday = 0;
    usage.dailyResetAt = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  }
  if (!usage.hourlyResetAt || now >= usage.hourlyResetAt) {
    usage.sentThisHour = 0;
    usage.hourlyResetAt = new Date(now.getTime() + 60 * 60 * 1000);
  }
  const dailyLimit = q.dailyLimit ?? 500;
  const hourlyLimit = q.hourlyLimit ?? 20;
  if (usage.sentToday >= dailyLimit || usage.sentThisHour >= hourlyLimit) {
    mailbox.usage = usage;
    await mailbox.save();
    return false;
  }
  usage.sentToday += 1;
  usage.sentThisHour += 1;
  mailbox.usage = usage;
  await mailbox.save();
  return true;
}

/**
 * A rate-limit / throttle refusal (Gmail's 454 "Too many login attempts", 421, 450)
 * as opposed to a bad address. Shared by campaigns and sequences: both must treat
 * these as "try again later", never as a recipient failure.
 */
function isThrottleError(err) {
  const code = Number(err?.responseCode);
  if (code === 454 || code === 421 || code === 450) return true;
  return /too many|rate limit|throttl|try again later/i.test(err?.message || '');
}

/** Park a mailbox the provider is refusing, so the next pass doesn't hammer it. */
async function coolDownMailbox(mailbox, err) {
  const mins = Number(process.env.MAILBOX_THROTTLE_COOLDOWN_MIN) || 30;
  const until = new Date(Date.now() + mins * 60 * 1000);
  // `healthStatus` too, not just the timestamp — the Mailbox Config page only
  // renders the cooldown banner for the 'cooldown' state, so setting one without
  // the other leaves a parked mailbox looking perfectly healthy in the UI.
  await Mailbox.updateOne(
    { _id: mailbox._id },
    { $set: { cooldownUntil: until, healthStatus: 'cooldown' } },
  ).catch(() => {});
  resetTransport(mailbox._id); // a refused pool is not worth reusing
  console.warn(`[mailbox] ${mailbox.email} throttled (${err?.responseCode || err?.message}) → cooldown until ${until.toISOString()}`);
}

/**
 * Return mailboxes whose cooldown has elapsed to 'healthy'. Called at the top of
 * each send pass — otherwise a throttled mailbox keeps its 'cooldown' badge (and
 * its scary banner) forever until somebody clicks Verify.
 */
async function expireCooldowns() {
  await Mailbox.updateMany(
    {
      healthStatus: 'cooldown',
      $or: [{ cooldownUntil: null }, { cooldownUntil: { $exists: false } }, { cooldownUntil: { $lte: new Date() } }],
    },
    { $set: { healthStatus: 'healthy' }, $unset: { cooldownUntil: '' } },
  ).catch(() => {});
}

/**
 * Hand back a reservation whose send never happened (transport refused, connection
 * dropped). Without this a mailbox that is merely unreachable burns its hourly and
 * daily budget on retries and locks itself out for the rest of the day.
 */
async function releaseQuota(mailbox) {
  if (!mailbox?._id) return;
  await Mailbox.updateOne(
    { _id: mailbox._id },
    { $inc: { 'usage.sentToday': -1, 'usage.sentThisHour': -1 } },
  ).catch(() => {});
  // Never let a race drive a counter negative.
  await Mailbox.updateOne(
    { _id: mailbox._id, 'usage.sentToday': { $lt: 0 } },
    { $set: { 'usage.sentToday': 0 } },
  ).catch(() => {});
  await Mailbox.updateOne(
    { _id: mailbox._id, 'usage.sentThisHour': { $lt: 0 } },
    { $set: { 'usage.sentThisHour': 0 } },
  ).catch(() => {});
}

/* ═══════════════════════════════════════════════════════
   PERSONALISATION
   ═══════════════════════════════════════════════════════ */

/** Build the {{key}} → value map for a recipient's merge tags. */
function mergeVariables(recipient) {
  return {
    firstName: recipient.firstName || (recipient.recipientName || '').split(' ')[0] || '',
    lastName: recipient.lastName || '',
    name: recipient.recipientName || '',
    email: recipient.email || '',
    qualification: recipient.qualification || '',
    qualificationName: recipient.qualification || '',
    applicationId: recipient.applicationDisplayId || '',
  };
}

function personalize(html, recipient) {
  return interpolate(String(html || ''), mergeVariables(recipient));
}

function injectPreheader(html, preview) {
  if (!preview) return html;
  const block = `<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${preview}</div>`;
  return /<body[^>]*>/i.test(html)
    ? html.replace(/(<body[^>]*>)/i, `$1${block}`)
    : block + html;
}

function injectPixel(html, token) {
  const pixel = trackingPixel(token);
  return /<\/body>/i.test(html) ? html.replace(/<\/body>/i, `${pixel}</body>`) : html + pixel;
}

async function resolveHtml(campaign) {
  if (campaign.htmlContent && campaign.htmlContent.trim()) return campaign.htmlContent;
  if (campaign.templateId) {
    const tpl = await EmailTemplate.findById(campaign.templateId).lean();
    if (tpl) return tpl.htmlContent || tpl.content || tpl.body || '';
  }
  return '';
}

/* ═══════════════════════════════════════════════════════
   COUNTERS + STATUS
   ═══════════════════════════════════════════════════════ */

async function emitProgress(campaignId) {
  const c = await Campaign.findById(campaignId).select('stats status').lean();
  if (c) emitCampaignProgress(campaignId, c.stats, c.status);
}

async function pauseWithError(campaignId, message) {
  await Campaign.updateOne(
    { _id: campaignId, status: 'sending' },
    { $set: { status: 'paused', pausedAt: new Date(), lastError: message } }
  );
  const c = await Campaign.findById(campaignId).select('stats status').lean();
  if (c) emitCampaignCompleted(campaignId, c.status, c.stats);
}

async function finalize(campaignId) {
  const c = await Campaign.findById(campaignId);
  if (!c || c.status !== 'sending') return;
  const failed = c.stats.failed || 0;
  const bounced = c.stats.bounced || 0;
  c.status = failed > 0 || bounced > 0 ? 'partially_failed' : 'sent';
  c.completedAt = new Date();
  c.stats.queued = 0;
  await c.save();
  emitCampaignCompleted(campaignId, c.status, c.stats);
}

/* ═══════════════════════════════════════════════════════
   SEND WORKER
   ═══════════════════════════════════════════════════════ */

async function processCampaign(campaignId) {
  const id = String(campaignId);
  if (processing.has(id)) return;
  processing.add(id);
  try {
    let campaign = await Campaign.findById(campaignId);
    if (!campaign || campaign.status !== 'sending') return;

    // Self-heal any rows stuck in 'sending' from a prior crash.
    await CampaignRecipient.updateMany(
      { campaignId, status: 'sending' },
      { $set: { status: 'queued' } }
    );

    // First send — materialise recipients.
    const existing = await CampaignRecipient.countDocuments({ campaignId });
    if (existing === 0) {
      await buildRecipients(campaign);
      if ((await CampaignRecipient.countDocuments({ campaignId, status: 'queued' })) === 0) {
        await Campaign.updateOne({ _id: campaignId }, { $set: { lastError: 'No recipients matched this audience.' } });
        await finalize(campaignId);
        return;
      }
    }

    await expireCooldowns();
    const baseHtml = await resolveHtml(campaign);

    // eslint-disable-next-line no-constant-condition
    while (true) {
      campaign = await Campaign.findById(campaignId).lean();
      if (!campaign || campaign.status !== 'sending') return; // paused / cancelled

      const batch = await CampaignRecipient.find({ campaignId, status: 'queued' }).limit(BATCH_SIZE);
      if (batch.length === 0) break;

      const mailbox = await pickMailbox();
      if (!mailbox) {
        await pauseWithError(campaignId, 'No active mailbox available to send from. Connect a mailbox and resume.');
        return;
      }

      for (const recipient of batch) {
        const ok = await reserveQuota(mailbox);
        if (!ok) {
          await pauseWithError(campaignId, `Mailbox ${mailbox.email} hit its sending quota. Resume later or add another mailbox.`);
          return;
        }

        recipient.status = 'sending';
        await recipient.save();

        try {
          let html = personalize(baseHtml, recipient);
          html = injectPreheader(html, campaign.previewText);
          html = injectPixel(html, recipient.trackingToken);

          const info = await transportFor(mailbox).sendMail({
            from: mailbox.displayName ? `"${mailbox.displayName}" <${mailbox.email}>` : mailbox.email,
            to: recipient.email,
            subject: personalize(campaign.subject, recipient),
            html,
            replyTo: campaign.replyTo || undefined,
          });

          if (info.rejected && info.rejected.length) throw new Error('Address rejected by SMTP server');

          recipient.status = 'sent';
          recipient.sentAt = new Date();
          recipient.messageId = info.messageId || null;
          recipient.mailboxId = mailbox._id;
          await recipient.save();
          await Campaign.updateOne({ _id: campaignId }, { $inc: { 'stats.sent': 1, 'stats.queued': -1 } });
        } catch (err) {
          // A throttle refusal is NOT a bad address. Marking these `failed` would
          // permanently drop real students from the send (they are never retried),
          // so requeue the recipient, park the mailbox, and pause for a human.
          if (isThrottleError(err)) {
            await releaseQuota(mailbox);
            recipient.status = 'queued';
            await recipient.save();
            await coolDownMailbox(mailbox, err);
            await pauseWithError(
              campaignId,
              `Mailbox ${mailbox.email} is being rate limited by its provider (${err.responseCode || 'throttled'}). Nobody was skipped — resume once it settles.`,
            );
            return;
          }
          recipient.status = 'failed';
          recipient.failureReason = (err && err.message) ? err.message.slice(0, 300) : 'Send failed';
          recipient.failureCode = err && err.responseCode ? String(err.responseCode) : null;
          await recipient.save();
          await Campaign.updateOne({ _id: campaignId }, { $inc: { 'stats.failed': 1, 'stats.queued': -1 } });
        }
      }

      await emitProgress(campaignId);
      await sleep(BATCH_DELAY_MS);
    }

    await finalize(campaignId);
  } catch (err) {
    console.error('[campaignSend] worker error:', err.message);
    await Campaign.updateOne(
      { _id: campaignId, status: 'sending' },
      { $set: { status: 'paused', pausedAt: new Date(), lastError: `Send interrupted: ${err.message}` } }
    ).catch(() => {});
  } finally {
    processing.delete(id);
  }
}

/** Fire-and-forget kick — used by the controller on send/resume. */
function startCampaign(campaignId) {
  setImmediate(() => processCampaign(campaignId).catch((e) => console.error('[campaignSend]', e.message)));
}

/**
 * Startup recovery: any campaign left 'sending' when the process died is paused
 * with its in-flight rows requeued, so it never gets stuck and can be resumed.
 */
async function recoverInterrupted() {
  const stuck = await Campaign.find({ status: 'sending' }).select('_id').lean();
  for (const c of stuck) {
    await CampaignRecipient.updateMany({ campaignId: c._id, status: 'sending' }, { $set: { status: 'queued' } });
    await Campaign.updateOne(
      { _id: c._id },
      { $set: { status: 'paused', pausedAt: new Date(), lastError: 'Server restarted mid-send. Resume to continue.' } }
    );
  }
  if (stuck.length) console.log(`[campaignSend] recovered ${stuck.length} interrupted campaign(s) → paused`);
}

module.exports = {
  resolveAudience,
  buildRecipients,
  processCampaign,
  startCampaign,
  recoverInterrupted,
  // Shared send primitives — reused by the sequence (drip) scheduler so both
  // features draw from one mailbox pool / quota budget.
  transportFor,
  resetTransport,
  pickMailbox,
  reserveQuota,
  releaseQuota,
  isThrottleError,
  coolDownMailbox,
  expireCooldowns,
  injectPreheader,
};
