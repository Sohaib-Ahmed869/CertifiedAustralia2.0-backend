/**
 * Seed the MarketingSource collection from the lists that used to be hardcoded.
 *
 * Until Sep 2026 the marketing source registry was TEN declarations across nine files
 * (SOURCE_PLATFORMS + SPEND_KEY_TO_SOURCE in ceoDashboardService, the MarketingSpend
 * platform enum, and seven frontend copies), so adding one tracking link needed a
 * developer and a deploy. The list now lives in Mongo and is edited from the Marketing
 * Links page.
 *
 * Every previously-hardcoded key is carried over VERBATIM — same key, same label, same
 * colour, plus the legacy ad-spend aliases (meta/meta_paid/meta_ads/print_qr/vip_line/
 * gabby_line) that SPEND_KEY_TO_SOURCE used to map by hand. Existing attribution keeps
 * working because nothing about the stored `?source=` values changes; only where their
 * labels come from does.
 *
 * The server ALSO seeds these lazily on the first registry read, so a deploy is
 * self-healing and this script is really for running it deliberately against a live
 * database and seeing the report. Idempotent either way: matches on `key`, never
 * inserts a duplicate, and never overwrites a label an admin has since edited.
 *
 *   node scripts/seed-marketing-sources.js          # report only
 *   node scripts/seed-marketing-sources.js --apply  # write
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const mongoose = require('mongoose');
const MarketingSource = require('../src/models/MarketingSource');
const Application = require('../src/models/Application');
const MarketingSpend = require('../src/models/MarketingSpend');
const { BUILT_IN } = require('../src/services/marketingSourceService');

const APPLY = process.argv.includes('--apply');

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log(APPLY ? 'Mode: APPLY (writing)\n' : 'Mode: dry run (re-run with --apply to write)\n');

  let added = 0;
  let kept = 0;

  for (const s of BUILT_IN) {
    const existing = await MarketingSource.findOne({ key: s.key }).lean();
    if (existing) {
      // Present already — leave it alone. An admin may have renamed or recoloured it,
      // and re-seeding must not undo that.
      console.log(`= ${s.key.padEnd(28)} "${existing.label}"`);
      kept += 1;
      continue;
    }
    console.log(`+ ${s.key.padEnd(28)} "${s.label}"`);
    added += 1;
    if (APPLY) await MarketingSource.create({ ...s, isBuiltIn: true, isActive: true });
  }

  /* Keys that leads or ad spend are ALREADY attributed to but which no registry row
     covers. These are the silent failure the registry exists to end: they were captured
     fine (the field has never had an enum) but rendered as a raw key and were skipped by
     every dashboard rollup. Reported, never auto-created — a typo'd key from a mis-built
     ad URL should not become a permanent source. */
  const [appKeys, spendKeys] = await Promise.all([
    Application.distinct('sourceAttribution.source'),
    MarketingSpend.distinct('platform'),
  ]);

  const known = new Set();
  BUILT_IN.forEach((s) => {
    known.add(s.key);
    (s.aliases || []).forEach((a) => known.add(a));
  });
  (await MarketingSource.find().select('key aliases').lean()).forEach((s) => {
    known.add(s.key);
    (s.aliases || []).forEach((a) => known.add(a));
  });

  const orphans = [...new Set([...appKeys, ...spendKeys])]
    .filter((k) => k && k !== 'direct' && !known.has(k));

  if (orphans.length) {
    console.log('\nAttributed in the data but NOT in the registry (add from Marketing Links if real):');
    for (const k of orphans) {
      const n = await Application.countDocuments({ 'sourceAttribution.source': k });
      const spend = await MarketingSpend.countDocuments({ platform: k });
      console.log(`  ! ${k.padEnd(28)} ${n} lead(s), ${spend} spend record(s)`);
    }
  }

  const total = await MarketingSource.countDocuments();
  console.log(APPLY
    ? `\nDone. ${added} added, ${kept} already present — ${total} source(s) in the registry.`
    : `\nDry run — nothing was written. ${added} would be added, ${kept} already present.`);
  await mongoose.disconnect();
})().catch(async (err) => {
  console.error('Failed:', err.message);
  try { await mongoose.disconnect(); } catch { /* noop */ }
  process.exit(1);
});
