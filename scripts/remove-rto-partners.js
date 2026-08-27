/**
 * Remove retired RTO partners from every qualification's `rtoCosts[]`.
 *
 * The partner list is stored per qualification (`rtoCosts[].rtoName`, which holds either
 * a contact email for legacy-imported rows or a plain name for anything added since), so
 * retiring a partner means editing every qualification that carries it. The Industries
 * screen can now do this one qualification at a time; this script does the whole catalog.
 *
 * Matching is a case-insensitive SUBSTRING on rtoName, which is what makes one term cover
 * both forms — "oceania" matches both `info@oceaniaservices.com` and `Oceania Services`.
 *
 * SAFETY: --apply ALWAYS writes a backup of every touched qualification's ORIGINAL
 * rtoCosts to scripts/data/ before changing anything, and refuses to run if that backup
 * can't be written. --restore puts them back exactly.
 *
 *   node scripts/remove-rto-partners.js                          # report only (default terms)
 *   node scripts/remove-rto-partners.js --apply                  # back up, then write
 *   node scripts/remove-rto-partners.js --terms=oceania,frontier # override the term list
 *   node scripts/remove-rto-partners.js --restore=<file>         # preview a rollback
 *   node scripts/remove-rto-partners.js --restore=<file> --apply # roll back
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const Qualification = require('../src/models/Qualification');

const APPLY = process.argv.includes('--apply');

const argValue = (flag) => {
  const arg = process.argv.find((a) => a.startsWith(`${flag}=`));
  return arg ? arg.slice(flag.length + 1) : null;
};

const RESTORE_FILE = argValue('--restore');

const DEFAULT_TERMS = ['oceania', 'frontier', 'educube'];
const TERMS = (argValue('--terms') ? argValue('--terms').split(',') : DEFAULT_TERMS)
  .map((t) => t.trim().toLowerCase())
  .filter(Boolean);

const isRetired = (rtoName) => {
  const name = String(rtoName || '').toLowerCase();
  return TERMS.some((t) => name.includes(t));
};

const BACKUP_DIR = path.join(__dirname, 'data');

/* ── Rollback: put the saved rtoCosts back verbatim ── */
async function restore() {
  const raw = fs.readFileSync(RESTORE_FILE, 'utf8');
  const backup = JSON.parse(raw);
  const items = backup.items || [];

  console.log(`Restoring from ${RESTORE_FILE}`);
  console.log(`Backup taken ${backup.createdAt} — ${items.length} qualification(s)`);
  console.log(APPLY ? 'Mode: APPLY (writing)\n' : 'Mode: dry run (re-run with --apply to write)\n');

  let restored = 0;
  for (const item of items) {
    const current = await Qualification.findById(item._id).select('name rtoCosts').lean();
    if (!current) { console.log(`  ! ${item.name} — no longer exists, skipped`); continue; }

    const now = (current.rtoCosts || []).map((r) => r.rtoName).join(', ') || '(none)';
    const was = (item.rtoCosts || []).map((r) => r.rtoName).join(', ') || '(none)';
    if (now === was) continue;

    console.log(`${item.name}`);
    console.log(`    now: ${now}`);
    console.log(`    ->  ${was}`);
    restored += 1;

    if (APPLY) {
      await Qualification.collection.updateOne({ _id: current._id }, { $set: { rtoCosts: item.rtoCosts } });
    }
  }

  console.log('');
  if (!restored) console.log('Everything already matches the backup — nothing to do.');
  else console.log(APPLY ? `Restored ${restored} qualification(s).` : `Would restore ${restored} qualification(s) — nothing was written.`);
}

/* ── Removal ── */
async function remove() {
  console.log(`Matching partners containing: ${TERMS.join(', ')}`);
  console.log(APPLY ? 'Mode: APPLY (writing)\n' : 'Mode: dry run (re-run with --apply to write)\n');

  const quals = await Qualification.find({ 'rtoCosts.rtoName': { $exists: true } })
    .select('name rtoCosts')
    .lean();

  // Work out the whole change set BEFORE touching anything, so the backup is complete
  // even if a write fails partway through.
  const changes = [];
  for (const q of quals) {
    const drop = (q.rtoCosts || []).filter((r) => isRetired(r.rtoName));
    if (!drop.length) continue;
    changes.push({ q, drop, keep: (q.rtoCosts || []).filter((r) => !isRetired(r.rtoName)) });
  }

  if (!changes.length) {
    console.log('No qualifications carry those partners — nothing to do.');
    return;
  }

  const byPartner = {};
  let orphaned = 0;
  for (const { q, drop, keep } of changes) {
    drop.forEach((r) => { byPartner[r.rtoName] = (byPartner[r.rtoName] || 0) + 1; });
    console.log(`${q.name}`);
    drop.forEach((r) => console.log(`    - ${r.rtoName} ($${r.rtoCost ?? 0})`));
    if (keep.length === 0) { orphaned += 1; console.log('    ! leaves this qualification with no RTO partner'); }
  }

  let backupPath = null;
  if (APPLY) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    backupPath = path.join(BACKUP_DIR, `rto-partners-backup-${stamp}.json`);
    fs.writeFileSync(backupPath, JSON.stringify({
      createdAt: new Date().toISOString(),
      terms: TERMS,
      collection: 'qualifications',
      field: 'rtoCosts',
      note: 'Original rtoCosts for every qualification touched by remove-rto-partners.js.',
      items: changes.map(({ q }) => ({ _id: String(q._id), name: q.name, rtoCosts: q.rtoCosts || [] })),
    }, null, 2));
    // Read it back — a backup that isn't on disk is not a backup.
    JSON.parse(fs.readFileSync(backupPath, 'utf8'));
    console.log(`\nBackup written: ${backupPath}`);

    for (const { q, keep } of changes) {
      // Write the filtered array straight through the driver: `rtoCost` is `required` on
      // the subdocument, so a legacy row missing it would fail validation on a save() and
      // strand the rest of the cleanup.
      await Qualification.collection.updateOne({ _id: q._id }, { $set: { rtoCosts: keep } });
    }
  }

  const removed = changes.reduce((n, c) => n + c.drop.length, 0);
  console.log('');
  console.log(`${removed} partner row(s) across ${changes.length} qualification(s):`);
  Object.entries(byPartner)
    .sort((a, b) => b[1] - a[1])
    .forEach(([name, n]) => console.log(`  ${name} — ${n}`));
  if (orphaned) console.log(`${orphaned} qualification(s) left with no RTO partner.`);

  if (APPLY) {
    console.log('\nDone. To revert:');
    console.log(`  node scripts/remove-rto-partners.js --restore="${backupPath}" --apply`);
  } else {
    console.log('\nDry run — nothing was written.');
  }
}

(async () => {
  if (!RESTORE_FILE && !TERMS.length) throw new Error('No terms given.');
  if (RESTORE_FILE && !fs.existsSync(RESTORE_FILE)) throw new Error(`Backup file not found: ${RESTORE_FILE}`);

  await mongoose.connect(process.env.MONGODB_URI);
  if (RESTORE_FILE) await restore();
  else await remove();
  await mongoose.disconnect();
})().catch(async (err) => {
  console.error('Failed:', err.message);
  try { await mongoose.disconnect(); } catch { /* noop */ }
  process.exit(1);
});
