/**
 * Split `rtoCosts[].rtoName` into a display name + a submission email.
 *
 * Until Aug 2026 the per-qualification RTO partner was ONE field, and it held whichever
 * form the row was created with — an email for the legacy catalog import, a plain name for
 * anything typed in later. That made the same partner look like two ("admin@allskillscollege.com.au"
 * and "Allskills"), and meant a submission address had to be guessed from a display name.
 * `rtoName` is now the name and `rtoEmail` the contact; this backfills the split.
 *
 * PARTNERS below is the canonical mapping and is deliberately frozen in this script — it
 * mirrors the frontend's `src/lib/rtoPartners.js` at the time of the migration. Rows that
 * match nothing keep whatever they have: an email-looking value moves to rtoEmail with a
 * name derived from its domain, anything else stays as the name with no email.
 *
 * SAFETY: --apply always writes a backup of the original rtoCosts to scripts/data/ first.
 * Roll back with remove-rto-partners.js --restore=<file> --apply (same field, same shape).
 *
 *   node scripts/split-rto-partner-contacts.js          # report only
 *   node scripts/split-rto-partner-contacts.js --apply  # back up, then write
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const Qualification = require('../src/models/Qualification');

const APPLY = process.argv.includes('--apply');
const BACKUP_DIR = path.join(__dirname, 'data');

const PARTNERS = [
  { name: 'All Skills RTO', email: 'admin@allskillscollege.com.au', aliases: ['allskills', 'all skills'] },
  { name: 'Cosmetica RTO', email: 'admin@colourcosmetica.com', aliases: ['cosmetica', 'colour cosmetica'] },
  { name: 'Lumiere Solutions', email: 'info@lumieresolutions.com.au', aliases: ['lumiere'] },
  { name: 'Delacroy', email: 'admin@delacroytraining.com.au', aliases: ['delacroy'] },
  { name: 'Test RTO', email: 'asadawan16900@gmail.com', aliases: [] },
  { name: 'RPL Test RTO', email: 'rpl@certifiedaustralia.com.au', aliases: [] },
];

const norm = (v) => String(v || '').trim().toLowerCase();
const isEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v || '').trim());

const matchPartner = (value) => {
  const v = norm(value);
  if (!v) return null;
  return PARTNERS.find((p) =>
    norm(p.email) === v || norm(p.name) === v || p.aliases.some((a) => v === a || v.includes(a))
  ) || null;
};

/** Best-effort name for an unknown email: "info@fooTraining.com.au" -> "Footraining". */
const nameFromEmail = (email) => {
  const domain = String(email).split('@')[1] || '';
  const label = domain.split('.')[0] || domain;
  return label ? label.charAt(0).toUpperCase() + label.slice(1) : email;
};

const splitRow = (row) => {
  const known = matchPartner(row.rtoName) || (row.rtoEmail ? matchPartner(row.rtoEmail) : null);
  if (known) return { ...row, rtoName: known.name, rtoEmail: known.email };
  if (isEmail(row.rtoName)) return { ...row, rtoName: nameFromEmail(row.rtoName), rtoEmail: norm(row.rtoName) };
  return { ...row, rtoEmail: norm(row.rtoEmail) || '' };
};

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log(APPLY ? 'Mode: APPLY (writing)\n' : 'Mode: dry run (re-run with --apply to write)\n');

  const quals = await Qualification.find({ 'rtoCosts.0': { $exists: true } })
    .select('name rtoCosts')
    .lean();

  const changes = [];
  const summary = {};
  for (const q of quals) {
    const next = (q.rtoCosts || []).map(splitRow);
    const differs = next.some((r, i) => {
      const before = q.rtoCosts[i];
      return r.rtoName !== before.rtoName || (r.rtoEmail || '') !== (before.rtoEmail || '');
    });
    if (!differs) continue;

    changes.push({ q, next });
    q.rtoCosts.forEach((before, i) => {
      const after = next[i];
      if (before.rtoName === after.rtoName && (before.rtoEmail || '') === (after.rtoEmail || '')) return;
      const key = `${before.rtoName}  ->  ${after.rtoName} <${after.rtoEmail || 'no email'}>`;
      summary[key] = (summary[key] || 0) + 1;
    });
  }

  if (!changes.length) {
    console.log('Every partner row already has a separate name and email — nothing to do.');
    await mongoose.disconnect();
    return;
  }

  console.log('Mapping:');
  Object.entries(summary)
    .sort((a, b) => b[1] - a[1])
    .forEach(([line, n]) => console.log(`  ${String(n).padStart(3)}  ${line}`));

  const noEmail = changes.flatMap(({ next }) => next).filter((r) => !r.rtoEmail).length;
  if (noEmail) console.log(`\n${noEmail} row(s) end up with no submission email — set one in Admin → Industries.`);

  if (APPLY) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = path.join(BACKUP_DIR, `rto-partners-backup-${stamp}.json`);
    fs.writeFileSync(backupPath, JSON.stringify({
      createdAt: new Date().toISOString(),
      collection: 'qualifications',
      field: 'rtoCosts',
      note: 'Original rtoCosts before split-rto-partner-contacts.js.',
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
