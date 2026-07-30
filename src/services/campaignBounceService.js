const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const Mailbox = require('../models/Mailbox');
const CampaignRecipient = require('../models/CampaignRecipient');
const Campaign = require('../models/Campaign');
const SequenceRecipient = require('../models/SequenceRecipient');
const Sequence = require('../models/Sequence');
const SequenceEnrollment = require('../models/SequenceEnrollment');
const { emitCampaignProgress, emitSequenceProgress } = require('../socket');

// Sent rows younger than this are still "Verifying" (accepted for relay, no bounce yet).
const VERIFY_GRACE_MS = 2 * 60 * 1000;
const LOOKBACK_DAYS = 7;

let polling = false; // overlap guard for the cron

/* ═══════════════════════════════════════════════════════
   HELPERS
   ═══════════════════════════════════════════════════════ */

function deriveImapHost(mailbox) {
  if (mailbox.provider === 'gmail') return 'imap.gmail.com';
  if (mailbox.provider === 'outlook') return 'outlook.office365.com';
  const host = mailbox.smtpHost || '';
  if (/^smtp\./i.test(host)) return host.replace(/^smtp\./i, 'imap.');
  return host;
}

function looksLikeBounce(parsed, raw) {
  const from = (parsed.from?.text || '').toLowerCase();
  if (from.includes('mailer-daemon') || from.includes('postmaster')) return true;
  const subject = (parsed.subject || '').toLowerCase();
  if (/undeliverable|delivery status|delivery failure|failure notice|returned mail|mail delivery failed|delivery has failed/i.test(subject)) return true;
  if (/multipart\/report/i.test(raw) && /delivery-status/i.test(raw)) return true;
  return false;
}

const NOISE = ['mailer-daemon', 'postmaster', 'no-reply', 'noreply', 'google.com'];

function extractFailure(parsed, raw, ownEmail) {
  // Message-IDs embedded in the DSN (includes the original message's id).
  const messageIds = [];
  const midRe = /Message-ID:\s*<([^>]+)>/gi;
  let m;
  while ((m = midRe.exec(raw)) !== null) messageIds.push(m[1].trim());

  // Failed recipient addresses — prefer structured DSN headers.
  const emails = new Set();
  const recRe = /(?:Final-Recipient|Original-Recipient):\s*[^;]*;\s*([^\s<>]+@[^\s<>]+)/gi;
  while ((m = recRe.exec(raw)) !== null) emails.add(m[1].trim().toLowerCase());

  // Fallback: scan for any address, dropping noise + our own mailbox.
  if (emails.size === 0) {
    const anyRe = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
    const hay = `${parsed.subject || ''} ${parsed.text || ''}`;
    while ((m = anyRe.exec(hay)) !== null) {
      const addr = m[0].toLowerCase();
      if (addr === (ownEmail || '').toLowerCase()) continue;
      if (NOISE.some((n) => addr.includes(n))) continue;
      emails.add(addr);
    }
  }

  const statusMatch = raw.match(/Status:\s*(\d\.\d+\.\d+)/i);
  const diagMatch = raw.match(/Diagnostic-Code:\s*(.+)/i);
  return {
    messageIds,
    emails: [...emails],
    failureCode: statusMatch ? statusMatch[1] : null,
    failureReason: (diagMatch ? diagMatch[1] : (parsed.subject || 'Bounced')).slice(0, 300),
  };
}

/* ═══════════════════════════════════════════════════════
   APPLY (idempotent, status-guarded)
   ═══════════════════════════════════════════════════════ */

async function applyBounce(recipient, failureReason, failureCode) {
  // Flip sent → bounced at most once. Pre-update doc tells us whether to retract a spurious open.
  const prev = await CampaignRecipient.findOneAndUpdate(
    { _id: recipient._id, status: 'sent' },
    {
      $set: {
        status: 'bounced',
        bouncedAt: new Date(),
        failureReason,
        failureCode,
        openedAt: null,
        openCount: 0,
      },
    },
    { new: false }
  );
  if (!prev) return false; // already handled

  const inc = { 'stats.sent': -1, 'stats.bounced': 1 };
  if (prev.openedAt) inc['stats.opened'] = -1; // retract the DSN-echoed pixel open
  await Campaign.updateOne({ _id: recipient.campaignId }, { $inc: inc });
  // An already-"sent" campaign becomes partially_failed for an honest outcome.
  await Campaign.updateOne(
    { _id: recipient.campaignId, status: 'sent' },
    { $set: { status: 'partially_failed' } }
  );

  const c = await Campaign.findById(recipient.campaignId).select('stats status').lean();
  if (c) emitCampaignProgress(recipient.campaignId, c.stats, c.status);
  return true;
}

async function matchRecipient({ messageIds, email }) {
  if (messageIds && messageIds.length) {
    const candidates = messageIds.flatMap((id) => [id, `<${id}>`]);
    const byId = await CampaignRecipient.findOne({ messageId: { $in: candidates }, status: 'sent' });
    if (byId) return byId;
  }
  if (email) {
    const since = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
    return CampaignRecipient.findOne({ email, status: 'sent', sentAt: { $gte: since } }).sort({ sentAt: -1 });
  }
  return null;
}

/* ── Email-sequence bounce reconciliation (shares this IMAP pass) ── */

async function matchSequenceRecipient({ messageIds, email }) {
  if (messageIds && messageIds.length) {
    const candidates = messageIds.flatMap((id) => [id, `<${id}>`]);
    const byId = await SequenceRecipient.findOne({ messageId: { $in: candidates }, status: 'sent' });
    if (byId) return byId;
  }
  if (email) {
    const since = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
    return SequenceRecipient.findOne({ email, status: 'sent', sentAt: { $gte: since } }).sort({ sentAt: -1 });
  }
  return null;
}

/**
 * Apply a bounce to a sequence step (idempotent, status-guarded). Retracts any
 * DSN-echoed open, and reconciles the enrollment: a bounce on the step the
 * enrollment engaged on is a false open (→ bounced); otherwise an active/completed
 * enrollment moves to the terminal bounced bucket. `stats.bounced` only moves on a
 * genuine enrollment transition (buckets stay exclusive).
 */
async function applySequenceBounce(recipient, failureReason, failureCode) {
  const prev = await SequenceRecipient.findOneAndUpdate(
    { _id: recipient._id, status: 'sent' },
    {
      $set: {
        status: 'bounced',
        bouncedAt: new Date(),
        failureReason,
        failureCode,
        openedAt: null,
        openCount: 0,
      },
    },
    { new: false }
  );
  if (!prev) return false; // already handled

  const inc = { [`stats.byStep.${prev.stepId}.bounced`]: 1 };
  if (prev.openedAt) inc[`stats.byStep.${prev.stepId}.opened`] = -1; // retract DSN-echoed step open

  const enr = await SequenceEnrollment.findById(prev.enrollmentId);
  if (enr) {
    const step = enr.steps.find((s) => s.stepId === prev.stepId);
    if (step) step.status = 'bounced';

    const openedOnThisStep = enr.openedStepId === prev.stepId && enr.status === 'opened';
    let bouncedTransition = false;
    if (openedOnThisStep) {
      // The engaging open was on the bounced step → false open. Retract + bounce.
      inc['stats.opened'] = -1;
      enr.status = 'bounced';
      enr.openedAt = null;
      enr.openedAtOrder = null;
      enr.openedStepId = null;
      bouncedTransition = true;
    } else if (enr.status === 'active') {
      enr.status = 'bounced';
      bouncedTransition = true;
    } else if (enr.status === 'completed') {
      inc['stats.completed'] = -1;
      enr.status = 'bounced';
      bouncedTransition = true;
    }
    // (enrollment opened on a DIFFERENT step stays engaged — no terminal change)
    if (bouncedTransition) inc['stats.bounced'] = 1;

    enr.markModified('steps');
    await enr.save();
  }

  await Sequence.updateOne({ _id: prev.sequenceId }, { $inc: inc });
  const s = await Sequence.findById(prev.sequenceId).select('stats status').lean();
  if (s) emitSequenceProgress(prev.sequenceId, s.stats, s.status);
  return true;
}

/* ═══════════════════════════════════════════════════════
   POLL
   ═══════════════════════════════════════════════════════ */

async function pollMailbox(mailbox) {
  const result = { mailbox: mailbox.email, scanned: 0, bounces: 0, error: null };
  const host = deriveImapHost(mailbox);
  if (!host) { result.error = 'Could not derive IMAP host'; return result; }

  const client = new ImapFlow({
    host,
    port: 993,
    secure: true,
    auth: { user: mailbox.email, pass: mailbox.appPassword },
    logger: false,
  });

  try {
    await client.connect();
    await client.mailboxOpen('INBOX');
    const since = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000);

    const uidsA = await client.search({ since, from: 'mailer-daemon' }, { uid: true });
    const uidsB = await client.search({ since, from: 'postmaster' }, { uid: true });
    const uids = [...new Set([...(uidsA || []), ...(uidsB || [])])];

    if (uids.length) {
      for await (const msg of client.fetch(uids, { source: true }, { uid: true })) {
        result.scanned += 1;
        const raw = msg.source.toString();
        const parsed = await simpleParser(msg.source);
        if (!looksLikeBounce(parsed, raw)) continue;

        const { messageIds, emails, failureReason, failureCode } = extractFailure(parsed, raw, mailbox.email);
        const targets = emails.length ? emails : [null];

        // --- Campaign match first: id-match once, then per-address fallback. ---
        let matchedAny = false;
        const matched = await matchRecipient({ messageIds, email: null });
        if (matched) {
          if (await applyBounce(matched, failureReason, failureCode)) result.bounces += 1;
          matchedAny = true;
        } else {
          for (const email of targets) {
            const r = await matchRecipient({ messageIds: [], email });
            if (r && await applyBounce(r, failureReason, failureCode)) { result.bounces += 1; matchedAny = true; }
          }
        }
        if (matchedAny) continue;

        // --- Sequence fallback: same DSN, matched against sequence recipients. ---
        const seqMatched = await matchSequenceRecipient({ messageIds, email: null });
        if (seqMatched) {
          if (await applySequenceBounce(seqMatched, failureReason, failureCode)) result.bounces += 1;
          continue;
        }
        for (const email of targets) {
          const r = await matchSequenceRecipient({ messageIds: [], email });
          if (r && await applySequenceBounce(r, failureReason, failureCode)) result.bounces += 1;
        }
      }
    }
  } catch (err) {
    result.error = err.message;
  } finally {
    try { await client.logout(); } catch { /* ignore */ }
  }
  return result;
}

/** Stamp sent rows past the grace window with no bounce → UI flips "Verifying" to "Sent". */
async function stampVerified() {
  const cutoff = new Date(Date.now() - VERIFY_GRACE_MS);
  await CampaignRecipient.updateMany(
    { status: 'sent', bounceCheckedAt: null, sentAt: { $lte: cutoff } },
    { $set: { bounceCheckedAt: new Date() } }
  );
  await SequenceRecipient.updateMany(
    { status: 'sent', bounceCheckedAt: null, sentAt: { $lte: cutoff } },
    { $set: { bounceCheckedAt: new Date() } }
  );
}

/** Poll every active mailbox for bounce DSNs. Never throws. */
async function pollAll() {
  if (polling) return { skipped: true };
  polling = true;
  const results = [];
  try {
    const mailboxes = await Mailbox.find({ isActive: true }).lean();
    for (const mb of mailboxes) {
      if (!mb.appPassword) continue;
      results.push(await pollMailbox(mb));
    }
    await stampVerified();
  } catch (err) {
    console.error('[campaignBounce] pollAll error:', err.message);
  } finally {
    polling = false;
  }
  return { results };
}

module.exports = {
  pollAll,
  pollMailbox,
  applyBounce,
  applySequenceBounce,
  matchSequenceRecipient,
  stampVerified,
};
