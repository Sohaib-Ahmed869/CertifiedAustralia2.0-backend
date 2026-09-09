/**
 * Ad campaign registry service — the second dimension of marketing attribution.
 *
 * A `MarketingSource` is the platform (`?source=tiktok`); an `AdCampaign` is one
 * paid push on it (`&campaign=summer_sale`). This module owns the campaign half:
 * the CRUD behind Marketing Links, the creative image, and — most importantly —
 * `resolveAttribution`, the ONE place that decides what a register URL's
 * source/campaign pair actually means.
 *
 * See `models/AdCampaign.js` for why it is not called `Campaign` (that name
 * belongs to the unrelated email-campaign feature).
 */
const AdCampaign = require('../models/AdCampaign');
const MarketingSource = require('../models/MarketingSource');
const marketingSourceService = require('./marketingSourceService');
const driveService = require('./googleDriveService');
const AppError = require('../utils/AppError');

const KEY_RE = /^[a-z0-9][a-z0-9_]*$/;
const RESERVED_KEYS = new Set(['direct', 'none', 'unknown', '']);

/** Images only — this field renders in an <img>, so anything else is a mistake. */
const IMAGE_MIME_RE = /^image\/(png|jpe?g|gif|webp|avif|svg\+xml)$/i;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/** "Summer Sale 2026!" → "summer_sale_2026" — same slug rule as source keys. */
const slugifyKey = (name) => marketingSourceService.slugifyKey(name);

/* ── Reads ─────────────────────────────────────────────────────────────────── */

/**
 * Campaigns, newest-relevant first. `sourceKey` narrows to one platform;
 * `activeOnly` is for the pickers that start NEW attribution (the spend editor,
 * the link cards) — reporting must never pass it, or a finished campaign's
 * history drops out of the numbers.
 */
async function list({ sourceKey, activeOnly = false } = {}) {
  const filter = {};
  if (sourceKey) filter.sourceKey = String(sourceKey).trim().toLowerCase();
  if (activeOnly) filter.isActive = { $ne: false };
  return AdCampaign.find(filter).sort({ sourceKey: 1, order: 1, name: 1 }).lean();
}

/**
 * One campaign, by Mongo id OR by its `key`.
 *
 * Both are accepted because the image route is reached from places that hold
 * different things: the Marketing Links rows carry the full document, while the
 * dashboard's campaign cards and the spend cockpit only carry the key.
 */
async function findByIdOrKey(idOrKey) {
  const raw = String(idOrKey || '').trim();
  if (!raw) return null;
  if (/^[a-f0-9]{24}$/i.test(raw)) {
    const byId = await AdCampaign.findById(raw).lean();
    if (byId) return byId;
  }
  return AdCampaign.findOne({ key: raw.toLowerCase() }).lean();
}

/** Every campaign key → its row, for labelling a rollup without an N+1. */
async function keyMap() {
  const all = await AdCampaign.find().lean();
  return Object.fromEntries(all.map((c) => [c.key, c]));
}

/**
 * The PUBLIC projection the register page reads. Trimmed to what that page needs
 * to resolve a link, so an unauthenticated caller can't enumerate spend or
 * ordering. INACTIVE campaigns are included deliberately — a finished campaign's
 * ad can still be live in someone's feed, and a lead arriving on it must be
 * attributed rather than dropped.
 */
async function listPublic() {
  const all = await AdCampaign.find().select('key name sourceKey').lean();
  return all.map((c) => ({ key: c.key, name: c.name, sourceKey: c.sourceKey }));
}

/**
 * Decide what a register URL's `?source=` / `?campaign=` pair means.
 *
 * THE CAMPAIGN WINS. It is the more specific claim and it carries its own
 * platform, so when a recognised campaign is present its `sourceKey` overrides
 * whatever `?source=` said. That is what stops the two fields contradicting each
 * other — the same rule `resolveHearAbout` applies to the screening answer, and
 * for the same reason: a hand-edited or stale URL must not be able to file a
 * TikTok lead under Facebook.
 *
 * An UNRECOGNISED campaign key is kept, not discarded. Attribution has always
 * been captured free-form (`sourceAttribution.campaign` is a plain String), and
 * silently dropping a typo'd or not-yet-created campaign would lose the only
 * evidence of where the lead came from. It simply won't roll up until someone
 * registers it — the same quiet degradation an unregistered `?source=` has.
 */
async function resolveAttribution({ source, campaign } = {}) {
  const campaignKey = String(campaign || '').trim().toLowerCase();
  const sourceKey = String(source || '').trim().toLowerCase();
  if (!campaignKey) return { source: sourceKey, campaign: '' };

  const row = await AdCampaign.findOne({ key: campaignKey }).lean();
  return {
    source: row ? row.sourceKey : sourceKey,
    campaign: campaignKey,
  };
}

/* ── Writes ────────────────────────────────────────────────────────────────── */

async function assertSourceExists(sourceKey) {
  if (!sourceKey) throw new AppError('A marketing source is required for a campaign', 400);
  const sources = await marketingSourceService.listAll();
  if (!sources.some((s) => s.key === sourceKey)) {
    throw new AppError(`"${sourceKey}" is not a known marketing source`, 400);
  }
}

async function assertKeyUsable(key) {
  if (!key) throw new AppError('Campaign key is required', 400);
  if (RESERVED_KEYS.has(key)) throw new AppError(`"${key}" is a reserved key`, 400);
  if (!KEY_RE.test(key)) {
    throw new AppError('Campaign key may only contain lowercase letters, numbers and underscores', 400);
  }
  // A campaign key that collides with a SOURCE key would make a bare
  // `?campaign=tiktok` ambiguous to read and impossible to chart.
  const sources = await marketingSourceService.listAll();
  if (sources.some((s) => s.key === key || (s.aliases || []).includes(key))) {
    throw new AppError(`"${key}" is already a marketing source key`, 409);
  }
  if (await AdCampaign.exists({ key })) {
    throw new AppError(`Campaign "${key}" already exists`, 409);
  }
}

async function create(data, userId) {
  const name = String(data.name || '').trim();
  if (!name) throw new AppError('Campaign name is required', 400);

  const sourceKey = String(data.sourceKey || '').trim().toLowerCase();
  await assertSourceExists(sourceKey);

  const key = String(data.key || '').trim().toLowerCase() || slugifyKey(name);
  await assertKeyUsable(key);

  const last = await AdCampaign.find({ sourceKey }).select('order').lean();
  const doc = await AdCampaign.create({
    sourceKey,
    key,
    name,
    description: String(data.description || '').trim(),
    isActive: data.isActive === undefined ? true : !!data.isActive,
    order: Number.isFinite(Number(data.order))
      ? Number(data.order)
      : Math.max(0, ...last.map((c) => c.order || 0)) + 10,
    createdBy: userId,
  });
  return doc.toObject();
}

async function update(id, data) {
  const doc = await AdCampaign.findById(id);
  if (!doc) throw new AppError('Campaign not found', 404);

  // The key IS the attribution — leads already carry the string.
  if (data.key !== undefined && String(data.key).trim().toLowerCase() !== doc.key) {
    throw new AppError(
      'A campaign key cannot be changed — leads are already attributed to it. Edit the name instead.',
      400
    );
  }
  // Moving a campaign to another platform would re-file every lead it has
  // already produced, so it is refused once anything is attributed to it.
  if (data.sourceKey !== undefined) {
    const next = String(data.sourceKey).trim().toLowerCase();
    if (next !== doc.sourceKey) {
      const used = await countAttributed(doc.key);
      if (used > 0) {
        throw new AppError(
          `"${doc.name}" already has ${used} lead(s) attributed to it, so it cannot be moved to another platform.`,
          409
        );
      }
      await assertSourceExists(next);
      doc.sourceKey = next;
    }
  }

  if (data.name !== undefined) {
    const name = String(data.name).trim();
    if (!name) throw new AppError('Campaign name is required', 400);
    doc.name = name;
  }
  if (data.description !== undefined) doc.description = String(data.description).trim();
  if (data.isActive !== undefined) doc.isActive = !!data.isActive;
  if (data.order !== undefined && Number.isFinite(Number(data.order))) doc.order = Number(data.order);

  await doc.save();
  return doc.toObject();
}

/** How many leads already carry this campaign key. */
async function countAttributed(campaignKey) {
  const Application = require('../models/Application');
  return Application.countDocuments({ 'sourceAttribution.campaign': campaignKey });
}

/**
 * Delete — only for a campaign nothing has been attributed to and no money has
 * been booked against. Anything with history is refused and must be deactivated,
 * so its leads keep their label and stay in the rollups.
 */
async function remove(id) {
  const doc = await AdCampaign.findById(id);
  if (!doc) throw new AppError('Campaign not found', 404);

  const MarketingSpend = require('../models/MarketingSpend');
  const [leads, spend] = await Promise.all([
    countAttributed(doc.key),
    MarketingSpend.countDocuments({ campaignKey: doc.key }),
  ]);
  if (leads > 0 || spend > 0) {
    throw new AppError(
      `"${doc.name}" already has ${leads} lead(s) and ${spend} spend record(s) attributed to it. `
      + 'Deactivate it instead so its history keeps its label.',
      409
    );
  }

  if (doc.image?.fileId) await driveService.deleteFile(doc.image.fileId).catch(() => {});
  await doc.deleteOne();
  return { deleted: true, key: doc.key };
}

/**
 * Attach (or replace) the ad creative.
 *
 * The NEW file is uploaded BEFORE the old one is deleted — the reverse order
 * destroys the existing image whenever the replacement upload fails, which is
 * the same ordering rule the student document "Replace File" path learned the
 * hard way. A failed delete of the superseded file is swallowed: an orphaned
 * Drive object is a tidiness problem, a lost image is a user-visible one.
 */
async function setImage(id, file) {
  const doc = await AdCampaign.findById(id);
  if (!doc) throw new AppError('Campaign not found', 404);
  if (!file) throw new AppError('No image was uploaded', 400);

  if (!IMAGE_MIME_RE.test(file.mimetype || '')) {
    throw new AppError('The campaign creative must be an image (PNG, JPG, GIF, WebP, AVIF or SVG)', 400);
  }
  if (file.size > MAX_IMAGE_BYTES) {
    throw new AppError('The campaign creative must be 10 MB or smaller', 400);
  }

  const uploaded = await driveService.uploadFileFromDisk({
    filePath: file.path,
    fileName: `campaign_${doc.key}_${file.originalname}`,
    mimeType: file.mimetype,
    description: `Ad creative for campaign "${doc.name}" (${doc.sourceKey})`,
  });

  const previous = doc.image?.fileId;
  doc.image = {
    fileId: uploaded.id,
    fileName: file.originalname,
    mimeType: file.mimetype,
    uploadedAt: new Date(),
  };
  await doc.save();

  if (previous && previous !== uploaded.id) {
    await driveService.deleteFile(previous).catch(() => {});
  }
  return doc.toObject();
}

async function clearImage(id) {
  const doc = await AdCampaign.findById(id);
  if (!doc) throw new AppError('Campaign not found', 404);
  const previous = doc.image?.fileId;
  doc.image = { fileId: '', fileName: '', mimeType: '', uploadedAt: undefined };
  await doc.save();
  if (previous) await driveService.deleteFile(previous).catch(() => {});
  return doc.toObject();
}

module.exports = {
  list,
  listPublic,
  keyMap,
  findByIdOrKey,
  resolveAttribution,
  countAttributed,
  create,
  update,
  remove,
  setImage,
  clearImage,
  slugifyKey,
};
