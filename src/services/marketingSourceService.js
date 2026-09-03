/**
 * Marketing source registry service.
 *
 * Owns the list that used to be ten hardcoded declarations across nine files
 * (`SOURCE_PLATFORMS` + `SPEND_KEY_TO_SOURCE` in ceoDashboardService, the
 * `MarketingSpend.platform` enum, and seven frontend copies). Everything that
 * labels, colours, charts or rolls up a `?source=` key now reads from here.
 */
const MarketingSource = require('../models/MarketingSource');
const AppError = require('../utils/AppError');

/**
 * The rows the portal shipped with, seeded on first read so a fresh database (or an
 * existing one upgrading) never comes up with an empty registry. Labels/colours are
 * lifted verbatim from the declarations these replaced so nothing re-renders differently.
 *
 * `aliases` carry the legacy ad-spend keys the old SPEND_KEY_TO_SOURCE mapped by hand.
 */
const BUILT_IN = [
  { key: 'referral', label: 'Refer a Friend', color: '#0a9d42', icon: 'gift', order: 10,
    description: 'Share with current students to refer friends — every referral is auto-tagged for attribution' },
  { key: 'tiktok', label: 'TikTok', color: '#000000', icon: 'tiktok', order: 20,
    description: 'Use this link in TikTok ad campaigns and bio links' },
  { key: 'facebook', label: 'Facebook', color: '#1877F2', icon: 'facebook', order: 30, aliases: ['meta', 'meta_paid'],
    description: 'Use this link for organic Facebook traffic (posts, bio, groups)' },
  { key: 'facebook_ads', label: 'Facebook Ads', color: '#1877F2', icon: 'facebook', order: 40, aliases: ['meta_ads'],
    description: 'Use this link in paid Facebook ad campaigns for attribution' },
  { key: 'instagram', label: 'Instagram', color: '#E4405F', icon: 'instagram', order: 50,
    description: 'Use this link for organic Instagram traffic (bio, stories, reels)' },
  { key: 'instagram_ads', label: 'Instagram Ads', color: '#C13584', icon: 'instagram', order: 60,
    description: 'Use this link in paid Instagram ad campaigns for attribution' },
  { key: 'linkedin', label: 'LinkedIn', color: '#0A66C2', icon: 'linkedin', order: 70,
    description: 'Use this link in LinkedIn ad campaigns and posts' },
  { key: 'google', label: 'Google', color: '#EA4335', icon: 'google', order: 80,
    description: 'Use this link in Google Ads search & display campaigns' },
  { key: 'linktree', label: 'Linktree', color: '#254F1A', icon: 'linktree', order: 90,
    description: 'Use this link in the Linktree bio hub shared across all social profiles' },
  { key: 'seo', label: 'SEO / Organic Search', color: '#0EA5E9', icon: 'search', order: 100,
    description: 'Use this link for organic search traffic — blog posts, landing pages & directories' },
  { key: 'print', label: 'QR Code / Print', color: '#7C3AED', icon: 'qr', order: 110, aliases: ['print_qr'],
    description: 'For flyers, brochures & business cards — generate the QR code' },
  { key: 'mainline', label: 'Incoming Calls (Mainline)', color: '#10B981', icon: 'phone-call', order: 120,
    description: 'Share with leads from incoming calls on the main phone line' },
  { key: 'vip', label: 'VIP Line', color: '#F59E0B', icon: 'star', order: 130, aliases: ['vip_line'],
    description: 'Exclusive link for leads from the VIP / personal number' },
  { key: 'gabby', label: "Gabby's Line", color: '#EC4899', icon: 'phone', order: 140, aliases: ['gabby_line'],
    description: "Tracking link for leads from Gabby's phone number" },
  { key: 'rsg', label: 'Rehman Sheriff Group', color: '#6366F1', icon: 'building', order: 150,
    description: 'Tracking link for leads from Rehman Sheriff Group' },
  { key: 'edm_campaign_floor_pricing', label: 'EDM Campaign — Floor Pricing', color: '#0D9488', icon: 'mail', order: 160,
    description: 'Use this link in the floor-pricing EDM email campaign — every signup is attributed to this campaign' },
  { key: 'certified_now_pay_later', label: 'Certified Now. Pay Later', color: '#EA580C', icon: 'credit-card', order: 170,
    description: 'Use this link for the "Certified Now. Pay Later" payment-plan promotion — every signup from the offer is attributed here' },
];

// `direct` is the ABSENCE of attribution and is computed alongside the platforms, so it
// must never become a row (it would double-count itself in every marketing rollup).
const RESERVED_KEYS = new Set(['direct', 'none', 'unknown', '']);

const KEY_RE = /^[a-z0-9][a-z0-9_]*$/;

/* ── In-process cache ──────────────────────────────────────────────────────────
   Every dashboard aggregation reads the registry, often several times per request.
   It changes maybe monthly, so it is cached and invalidated on write. Crons run
   in-process alongside the request handlers, so one cache covers both. */
let cache = null;
let cachePromise = null;

function invalidate() {
  cache = null;
  cachePromise = null;
}

async function loadAll() {
  if (cache) return cache;
  if (cachePromise) return cachePromise;

  cachePromise = (async () => {
    const count = await MarketingSource.estimatedDocumentCount();
    if (count === 0) {
      // First read on a database that predates the registry — seed it rather than
      // making a developer run a script for the portal to render its own links.
      await MarketingSource.insertMany(
        BUILT_IN.map((s) => ({ ...s, isBuiltIn: true, isActive: true })),
        { ordered: false }
      ).catch((e) => { if (e.code !== 11000) throw e; });
    } else {
      // Existing database: add any built-in shipped since it was seeded (this is how
      // a new source added in code reaches a live environment without a migration).
      const existing = await MarketingSource.find().select('key').lean();
      const have = new Set(existing.map((s) => s.key));
      const missing = BUILT_IN.filter((s) => !have.has(s.key));
      if (missing.length) {
        await MarketingSource.insertMany(
          missing.map((s) => ({ ...s, isBuiltIn: true, isActive: true })),
          { ordered: false }
        ).catch((e) => { if (e.code !== 11000) throw e; });
      }
    }

    cache = await MarketingSource.find().sort({ order: 1, label: 1 }).lean();
    return cache;
  })();

  try {
    return await cachePromise;
  } catch (err) {
    cachePromise = null;
    throw err;
  }
}

/* ── Reads ─────────────────────────────────────────────────────────────────── */

/** Every source, active or not. */
async function listAll() {
  return loadAll();
}

/** Only sources offered for NEW use — the link cards, pickers and spend editor. */
async function listActive() {
  const all = await loadAll();
  return all.filter((s) => s.isActive !== false);
}

/**
 * Platform list for the CEO dashboard, in the `{ key, name }` shape the rollups and
 * the frontend's platformCards already expect.
 *
 * Deliberately includes INACTIVE sources: their historical leads, spend and revenue
 * must keep appearing after a source is retired, or a quarter's numbers change
 * retroactively the moment someone tidies the link list.
 */
async function listPlatforms() {
  const all = await loadAll();
  return all.map((s) => ({ key: s.key, name: s.label, color: s.color, icon: s.icon, isActive: s.isActive !== false }));
}

/**
 * Ad-spend key → canonical source key. Identity for every registry key, plus every
 * alias a row declares. Replaces the hand-maintained SPEND_KEY_TO_SOURCE.
 */
async function getSpendKeyMap() {
  const all = await loadAll();
  const map = {};
  all.forEach((s) => {
    map[s.key] = s.key;
    (s.aliases || []).forEach((a) => { if (a) map[a] = s.key; });
  });
  return map;
}

/** Keys accepted by the ad-spend editor (canonical keys of active sources). */
async function listSpendPlatforms() {
  const active = await listActive();
  return active.map((s) => s.key);
}

/**
 * Gate for ad-spend writes. The `MarketingSpend.platform` enum used to do this; it
 * had to go (a registry row added at runtime can't be in a compiled enum), so the
 * check moved here — losing it entirely would let a typo'd key hold money that no
 * platform card ever reads.
 */
async function assertValidSpendPlatform(platform) {
  const map = await getSpendKeyMap();
  if (!map[platform]) {
    throw new AppError(`"${platform}" is not a known marketing source`, 400);
  }
  return map[platform];
}

/* ── Writes ────────────────────────────────────────────────────────────────── */

/** Derive a key from a label: "Certified Now. Pay Later" → "certified_now_pay_later". */
function slugifyKey(label) {
  return String(label || '')
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60);
}

async function assertKeyUsable(key) {
  if (!key) throw new AppError('Source key is required', 400);
  if (RESERVED_KEYS.has(key)) throw new AppError(`"${key}" is a reserved key`, 400);
  if (!KEY_RE.test(key)) {
    throw new AppError('Source key may only contain lowercase letters, numbers and underscores', 400);
  }
  const all = await loadAll();
  if (all.some((s) => s.key === key)) throw new AppError(`Source "${key}" already exists`, 409);
  if (all.some((s) => (s.aliases || []).includes(key))) {
    throw new AppError(`"${key}" is already used as an alias of another source`, 409);
  }
}

async function create(data, userId) {
  const label = String(data.label || '').trim();
  if (!label) throw new AppError('Label is required', 400);

  const key = String(data.key || '').trim().toLowerCase() || slugifyKey(label);
  await assertKeyUsable(key);

  const all = await loadAll();
  const doc = await MarketingSource.create({
    key,
    label,
    description: String(data.description || '').trim(),
    color: String(data.color || '#0a9d42').trim(),
    icon: String(data.icon || 'link').trim(),
    aliases: [],
    isBuiltIn: false,
    isActive: data.isActive === undefined ? true : !!data.isActive,
    // New links land at the end of the list rather than jumping the shipped ones.
    order: Number.isFinite(Number(data.order))
      ? Number(data.order)
      : Math.max(0, ...all.map((s) => s.order || 0)) + 10,
    createdBy: userId,
  });

  invalidate();
  return doc.toObject();
}

async function update(id, data) {
  const doc = await MarketingSource.findById(id);
  if (!doc) throw new AppError('Marketing source not found', 404);

  // The key is the attribution itself — changing it would strand every application
  // already signed up under it. The label is what people actually see; rename that.
  if (data.key !== undefined && String(data.key).trim().toLowerCase() !== doc.key) {
    throw new AppError(
      'A source key cannot be changed — leads are already attributed to it. Edit the label instead.',
      400
    );
  }

  if (data.label !== undefined) {
    const label = String(data.label).trim();
    if (!label) throw new AppError('Label is required', 400);
    doc.label = label;
  }
  if (data.description !== undefined) doc.description = String(data.description).trim();
  if (data.color !== undefined) doc.color = String(data.color).trim();
  if (data.icon !== undefined) doc.icon = String(data.icon).trim();
  if (data.isActive !== undefined) doc.isActive = !!data.isActive;
  if (data.order !== undefined && Number.isFinite(Number(data.order))) doc.order = Number(data.order);

  await doc.save();
  invalidate();
  return doc.toObject();
}

/**
 * Delete — only ever for a custom source that nothing has been attributed to yet.
 * Anything with history is refused and must be deactivated instead, so its leads keep
 * their label and stay in the rollups.
 */
async function remove(id) {
  const doc = await MarketingSource.findById(id);
  if (!doc) throw new AppError('Marketing source not found', 404);
  if (doc.isBuiltIn) {
    throw new AppError('Built-in sources cannot be deleted — deactivate it instead', 400);
  }

  // Required lazily: these models pull in hooks that reference services, and a
  // top-level require here would close a cycle at boot.
  const Application = require('../models/Application');
  const MarketingSpend = require('../models/MarketingSpend');

  const [apps, spend] = await Promise.all([
    Application.countDocuments({ 'sourceAttribution.source': doc.key }),
    MarketingSpend.countDocuments({ platform: doc.key }),
  ]);
  if (apps > 0 || spend > 0) {
    throw new AppError(
      `"${doc.label}" already has ${apps} lead(s) and ${spend} spend record(s) attributed to it. `
      + 'Deactivate it instead so its history keeps its label.',
      409
    );
  }

  await doc.deleteOne();
  invalidate();
  return { deleted: true, key: doc.key };
}

module.exports = {
  BUILT_IN,
  listAll,
  listActive,
  listPlatforms,
  listSpendPlatforms,
  getSpendKeyMap,
  assertValidSpendPlatform,
  slugifyKey,
  create,
  update,
  remove,
  invalidate,
};
