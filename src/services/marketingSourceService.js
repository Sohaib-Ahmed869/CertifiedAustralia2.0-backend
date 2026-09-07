/**
 * Marketing source registry service.
 *
 * Owns the list that used to be ten hardcoded declarations across nine files
 * (`SOURCE_PLATFORMS` + `SPEND_KEY_TO_SOURCE` in ceoDashboardService, the
 * `MarketingSpend.platform` enum, and seven frontend copies). Everything that
 * labels, colours, charts or rolls up a `?source=` key now reads from here.
 */
const MarketingSource = require('../models/MarketingSource');
const { HEAR_ABOUT_OPTIONS } = require('../models/ScreeningForm');
const AppError = require('../utils/AppError');

/**
 * The rows the portal shipped with, seeded on first read so a fresh database (or an
 * existing one upgrading) never comes up with an empty registry. Labels/colours are
 * lifted verbatim from the declarations these replaced so nothing re-renders differently.
 *
 * `aliases` carry the legacy ad-spend keys the old SPEND_KEY_TO_SOURCE mapped by hand.
 *
 * `hearAbout` is the screening answer the link implies — set where the link PROVES the
 * channel, empty where it genuinely doesn't (a bio hub, a printed QR, a phone line, an
 * email blast can each be reached from anywhere, so those still ask). These are only
 * DEFAULTS: staff retune any of them from Marketing Links → Edit.
 */
const BUILT_IN = [
  { key: 'referral', label: 'Refer a Friend', color: '#0a9d42', icon: 'gift', order: 10,
    hearAbout: 'A friend or colleague',
    description: 'Share with current students to refer friends — every referral is auto-tagged for attribution' },
  { key: 'tiktok', label: 'TikTok', color: '#000000', icon: 'tiktok', order: 20,
    hearAbout: 'TikTok',
    description: 'Use this link in TikTok ad campaigns and bio links' },
  { key: 'facebook', label: 'Facebook', color: '#1877F2', icon: 'facebook', order: 30, aliases: ['meta', 'meta_paid'],
    hearAbout: 'Facebook',
    description: 'Use this link for organic Facebook traffic (posts, bio, groups)' },
  { key: 'facebook_ads', label: 'Facebook Ads', color: '#1877F2', icon: 'facebook', order: 40, aliases: ['meta_ads'],
    hearAbout: 'Facebook',
    description: 'Use this link in paid Facebook ad campaigns for attribution' },
  { key: 'instagram', label: 'Instagram', color: '#E4405F', icon: 'instagram', order: 50,
    hearAbout: 'Instagram',
    description: 'Use this link for organic Instagram traffic (bio, stories, reels)' },
  { key: 'instagram_ads', label: 'Instagram Ads', color: '#C13584', icon: 'instagram', order: 60,
    hearAbout: 'Instagram',
    description: 'Use this link in paid Instagram ad campaigns for attribution' },
  { key: 'linkedin', label: 'LinkedIn', color: '#0A66C2', icon: 'linkedin', order: 70,
    hearAbout: 'LinkedIn',
    description: 'Use this link in LinkedIn ad campaigns and posts' },
  { key: 'google', label: 'Google', color: '#EA4335', icon: 'google', order: 80,
    hearAbout: 'Google',
    description: 'Use this link in Google Ads search & display campaigns' },
  // A Linktree hub is shared from every social profile at once — the click proves
  // nothing about which one they came from, so this one still asks.
  { key: 'linktree', label: 'Linktree', color: '#254F1A', icon: 'linktree', order: 90,
    hearAbout: '',
    description: 'Use this link in the Linktree bio hub shared across all social profiles' },
  { key: 'seo', label: 'SEO / Organic Search', color: '#0EA5E9', icon: 'search', order: 100,
    hearAbout: 'Google',
    description: 'Use this link for organic search traffic — blog posts, landing pages & directories' },
  // A flyer is not a "Newspaper or magazine" and the enum has no closer answer, so ask.
  { key: 'print', label: 'QR Code / Print', color: '#7C3AED', icon: 'qr', order: 110, aliases: ['print_qr'],
    hearAbout: '',
    description: 'For flyers, brochures & business cards — generate the QR code' },
  // They phoned us; how they found the number is the very thing we don't know.
  { key: 'mainline', label: 'Incoming Calls (Mainline)', color: '#10B981', icon: 'phone-call', order: 120,
    hearAbout: '',
    description: 'Share with leads from incoming calls on the main phone line' },
  { key: 'vip', label: 'VIP Line', color: '#F59E0B', icon: 'star', order: 130, aliases: ['vip_line'],
    hearAbout: 'A friend or colleague',
    description: 'Exclusive link for leads from the VIP / personal number' },
  { key: 'gabby', label: "Gabby's Line", color: '#EC4899', icon: 'phone', order: 140, aliases: ['gabby_line'],
    hearAbout: 'A friend or colleague',
    description: "Tracking link for leads from Gabby's phone number" },
  { key: 'rsg', label: 'Rehman Sheriff Group', color: '#6366F1', icon: 'building', order: 150,
    hearAbout: '',
    description: 'Tracking link for leads from Rehman Sheriff Group' },
  { key: 'edm_campaign_floor_pricing', label: 'EDM Campaign — Floor Pricing', color: '#0D9488', icon: 'mail', order: 160,
    hearAbout: '',
    description: 'Use this link in the floor-pricing EDM email campaign — every signup is attributed to this campaign' },
  { key: 'certified_now_pay_later', label: 'Certified Now. Pay Later', color: '#EA580C', icon: 'credit-card', order: 170,
    hearAbout: '',
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

/**
 * Stamp the shipped `hearAbout` defaults onto rows that predate the field.
 *
 * Filtered on `$exists: false`, never on a falsy value: an empty string is a real,
 * deliberate choice ("ask the student"), and re-asserting the default over it would
 * undo a staff edit on every boot.
 */
async function backfillHearAbout() {
  const stale = await MarketingSource.find({ hearAbout: { $exists: false } }).select('key').lean();
  if (!stale.length) return;

  const defaults = Object.fromEntries(BUILT_IN.map((s) => [s.key, s.hearAbout || '']));
  await Promise.all(stale.map((row) => MarketingSource.updateOne(
    { _id: row._id },
    { $set: { hearAbout: defaults[row.key] || '' } }
  )));
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
      await backfillHearAbout();
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

/**
 * The projection the PUBLIC register page reads — `/api/marketing-sources/public`.
 *
 * Trimmed to the three fields that page needs so an unauthenticated caller can't
 * enumerate ad-spend aliases, ordering or who created a link. INACTIVE sources are
 * included deliberately: a retired link is still live in someone's inbox or on a
 * printed flyer, and a lead arriving on it must get the same treatment as before.
 */
async function listPublic() {
  const all = await loadAll();
  return all.map((s) => ({ key: s.key, label: s.label, hearAbout: s.hearAbout || '' }));
}

/**
 * The screening answer a `?source=` key implies, or `''` when the link doesn't
 * determine one and the student should still be asked. Legacy ad-spend aliases
 * resolve too, so a stale link in the wild behaves like its canonical source.
 */
async function resolveHearAbout(sourceKey) {
  if (!sourceKey) return '';
  const all = await loadAll();
  const row = all.find((s) => s.key === sourceKey)
    || all.find((s) => (s.aliases || []).includes(String(sourceKey).toLowerCase()));
  return row?.hearAbout || '';
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

/**
 * A `hearAbout` outside the ScreeningForm enum would be dropped on save and the link
 * would quietly go back to asking, so it is refused at the edge instead.
 */
function normalizeHearAbout(value) {
  const v = String(value ?? '').trim();
  if (!v) return '';
  if (!HEAR_ABOUT_OPTIONS.includes(v)) {
    throw new AppError(`"${v}" is not a valid "How did you hear about us?" answer`, 400);
  }
  return v;
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
    // Defaults to "ask the student" — a brand-new link's channel is only knowable
    // by whoever created it, so silence here is the safe answer, not a guess.
    hearAbout: normalizeHearAbout(data.hearAbout),
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
  if (data.hearAbout !== undefined) doc.hearAbout = normalizeHearAbout(data.hearAbout);
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
  HEAR_ABOUT_OPTIONS,
  listAll,
  listActive,
  listPublic,
  listPlatforms,
  listSpendPlatforms,
  resolveHearAbout,
  getSpendKeyMap,
  assertValidSpendPlatform,
  slugifyKey,
  create,
  update,
  remove,
  invalidate,
};
