const crypto = require('crypto');
const CampaignRecipient = require('../models/CampaignRecipient');
const Campaign = require('../models/Campaign');

let emitCampaignProgress = () => {};
try {
  // Lazy — socket may not be initialised in scripts/tests.
  ({ emitCampaignProgress } = require('../socket'));
} catch { /* no-op */ }

// 1×1 transparent GIF.
const TRANSPARENT_GIF = Buffer.from(
  'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
  'base64'
);

const SECRET = () => process.env.CAMPAIGN_TRACKING_SECRET || process.env.JWT_SECRET || 'ca-campaign-tracking';

// Opens that land within this window of send are the recipient server / image
// proxy prefetching at scan time — not a human. Real opens never happen that fast.
const OPEN_GRACE_MS = 20 * 1000;

/** Deterministic, unguessable token stored on the recipient (never reverse-decoded). */
function makeToken(campaignId, leadId) {
  return crypto
    .createHmac('sha256', SECRET())
    .update(`${String(campaignId)}:${String(leadId)}`)
    .digest('hex');
}

/** Pixel HTML injected before </body>. */
function trackingPixel(token) {
  const base = (process.env.API_PUBLIC_URL || process.env.BACKEND_URL || 'http://localhost:5000').replace(/\/$/, '');
  const url = `${base}/api/track/${token}`;
  return `<img src="${url}" width="1" height="1" alt="" style="display:block;width:1px;height:1px;border:0;overflow:hidden;" />`;
}

/**
 * Record an open. Idempotent + defended against false positives:
 *  - only 'sent' recipients count (bounced/failed pixels get echoed in DSNs & prefetched)
 *  - hits inside the grace window are ignored
 *  - first-open is atomic; the campaign counter only moves on the real transition
 */
async function trackOpen(token) {
  if (!token) return;
  const recipient = await CampaignRecipient.findOne({ trackingToken: token })
    .select('_id campaignId status sentAt')
    .lean();
  if (!recipient) return;
  if (recipient.status !== 'sent') return; // bounced/failed/queued never count
  if (recipient.sentAt && Date.now() - new Date(recipient.sentAt).getTime() < OPEN_GRACE_MS) return;

  // Atomic first-open — counter only on the genuine null→now transition.
  const firstOpen = await CampaignRecipient.updateOne(
    { _id: recipient._id, openedAt: null },
    { $set: { openedAt: new Date() }, $inc: { openCount: 1 } }
  );

  if (firstOpen.modifiedCount) {
    await Campaign.updateOne({ _id: recipient.campaignId }, { $inc: { 'stats.opened': 1 } });
    const fresh = await Campaign.findById(recipient.campaignId).select('stats status').lean();
    if (fresh) emitCampaignProgress(recipient.campaignId, fresh.stats, fresh.status);
  } else {
    // Repeat open — bump the raw counter only.
    await CampaignRecipient.updateOne({ _id: recipient._id }, { $inc: { openCount: 1 } });
  }
}

module.exports = {
  TRANSPARENT_GIF,
  makeToken,
  trackingPixel,
  trackOpen,
  OPEN_GRACE_MS,
};
