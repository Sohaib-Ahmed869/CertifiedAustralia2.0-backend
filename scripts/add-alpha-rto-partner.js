/**
 * Add "Alpha" as an RTO partner on the twelve trade qualifications it delivers.
 *
 * Qualifications are matched by their national CODE, not their name — the client's list
 * uses shortened titles ("Certificate IV in Building and Construction" for what the
 * catalog calls "CPC40120 Certificate IV in Building and Construction (Building)"), and a
 * name match would be ambiguous for at least one of them ("Diploma of Building and
 * Construction" also substring-matches the ADVANCED diploma, CPC60220, which is NOT in
 * the client's list).
 *
 * Idempotent: re-running updates Alpha's cost rather than adding a second Alpha row.
 * Existing partners on these qualifications are left alone — Alpha is added alongside.
 *
 * SAFETY: --apply writes a backup of the original rtoCosts to scripts/data/ first. Roll
 * back with remove-rto-partners.js --restore=<file> --apply.
 *
 *   node scripts/add-alpha-rto-partner.js          # report only
 *   node scripts/add-alpha-rto-partner.js --apply  # back up, then write
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const Qualification = require('../src/models/Qualification');

const APPLY = process.argv.includes('--apply');
const BACKUP_DIR = path.join(__dirname, 'data');

const PARTNER_NAME = 'Alpha';
// No submission email supplied yet — rtoEmail is optional, and an existing one is never
// overwritten, so this can be filled in later from Admin → Industries without re-running.
const PARTNER_EMAIL = '';

const ASSIGNMENTS = [
  { code: 'AHC30921', cost: 1000 },  // Certificate III in Landscape Construction
  { code: 'CPC30220', cost: 650 },   // Certificate III in Carpentry
  { code: 'CPC30620', cost: 650 },   // Certificate III in Painting and Decorating
  { code: 'CPC30820', cost: 2500 },  // Certificate III in Roof Tiling
  { code: 'CPC31020', cost: 850 },   // Certificate III in Solid Plastering
  { code: 'CPC32420', cost: 1000 },  // Certificate III in Plumbing
  { code: 'CPC32620', cost: 900 },   // Certificate III in Roof Plumbing
  { code: 'CPC40120', cost: 850 },   // Certificate IV in Building and Construction (Building)
  { code: 'CPC40920', cost: 10000 }, // Certificate IV in Plumbing and Services
  { code: 'CPC50220', cost: 1000 },  // Diploma of Building and Construction (Building)
  { code: 'MSF30322', cost: 1800 },  // Certificate III in Cabinet Making and Timber Technology
  { code: 'UEE32220', cost: 5500 },  // Certificate III in Air Conditioning and Refrigeration
];

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log(APPLY ? 'Mode: APPLY (writing)\n' : 'Mode: dry run (re-run with --apply to write)\n');

  const changes = [];
  const problems = [];

  for (const { code, cost } of ASSIGNMENTS) {
    const matches = await Qualification.find({ name: new RegExp(`^${code}\\b`, 'i') })
      .select('name caPrice rtoCosts')
      .lean();

    if (matches.length !== 1) {
      problems.push(`${code}: ${matches.length} match(es) — skipped`);
      continue;
    }

    const q = matches[0];
    const existing = q.rtoCosts || [];
    const idx = existing.findIndex((r) => String(r.rtoName || '').trim().toLowerCase() === PARTNER_NAME.toLowerCase());

    let next;
    let action;
    if (idx >= 0) {
      if (existing[idx].rtoCost === cost) { console.log(`= ${q.name} — Alpha already $${cost}`); continue; }
      action = `updated $${existing[idx].rtoCost} -> $${cost}`;
      next = existing.map((r, i) => (i === idx ? { ...r, rtoCost: cost } : r));
    } else {
      action = `added $${cost}`;
      next = [...existing, { rtoName: PARTNER_NAME, rtoEmail: PARTNER_EMAIL, rtoCost: cost }];
    }

    const others = existing.filter((_, i) => i !== idx).map((r) => `${r.rtoName} $${r.rtoCost}`).join(', ') || 'none';
    console.log(`+ ${q.name}`);
    console.log(`      Alpha ${action}   (CA price $${q.caPrice}, other partners: ${others})`);
    // A partner that costs more than the sale price makes every enrolment a loss — worth
    // saying out loud rather than leaving it to show up in the margin column later.
    if (cost > (q.caPrice || 0)) console.log(`      !! Alpha's cost EXCEEDS the CA price by $${cost - q.caPrice}`);

    changes.push({ q, next });
  }

  problems.forEach((p) => console.log(`! ${p}`));

  if (!changes.length) {
    console.log('\nNothing to change.');
    await mongoose.disconnect();
    return;
  }

  if (APPLY) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = path.join(BACKUP_DIR, `rto-partners-backup-${stamp}.json`);
    fs.writeFileSync(backupPath, JSON.stringify({
      createdAt: new Date().toISOString(),
      collection: 'qualifications',
      field: 'rtoCosts',
      note: 'Original rtoCosts before add-alpha-rto-partner.js.',
      items: changes.map(({ q }) => ({ _id: String(q._id), name: q.name, rtoCosts: q.rtoCosts || [] })),
    }, null, 2));
    JSON.parse(fs.readFileSync(backupPath, 'utf8')); // a backup that isn't on disk is not a backup
    console.log(`\nBackup written: ${backupPath}`);

    for (const { q, next } of changes) {
      await Qualification.collection.updateOne({ _id: q._id }, { $set: { rtoCosts: next } });
    }

    console.log(`\nUpdated ${changes.length} qualification(s). To revert:`);
    console.log(`  node scripts/remove-rto-partners.js --restore="${backupPath}" --apply`);
  } else {
    console.log(`\nWould update ${changes.length} qualification(s) — nothing was written.`);
  }

  await mongoose.disconnect();
})().catch(async (err) => {
  console.error('Failed:', err.message);
  try { await mongoose.disconnect(); } catch { /* noop */ }
  process.exit(1);
});
