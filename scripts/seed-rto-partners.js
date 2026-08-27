/**
 * Seed the RTOPartner collection from the list that used to be hardcoded in the frontend.
 *
 * Until Aug 2026 the send-to-RTO picker read a `HARDCODED_RTOS` array baked into the
 * bundle, so adding a partner — or fixing a wrong address — needed a developer and a
 * deploy. The list now lives in Mongo and is edited from the RTO Submission card. This
 * moves the existing entries across; run it once per environment.
 *
 * Idempotent: matches on email and updates the name rather than inserting a duplicate,
 * so it is safe to re-run after adding a partner through the UI.
 *
 *   node scripts/seed-rto-partners.js          # report only
 *   node scripts/seed-rto-partners.js --apply  # write
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const mongoose = require('mongoose');
const RTOPartner = require('../src/models/RTOPartner');
const Qualification = require('../src/models/Qualification');

const APPLY = process.argv.includes('--apply');

// Frontier and Oceania are deliberately absent — retired Aug 2026.
const PARTNERS = [
  { name: 'All Skills RTO', email: 'admin@allskillscollege.com.au' },
  { name: 'Cosmetica RTO', email: 'admin@colourcosmetica.com' },
  { name: 'Lumiere Solutions', email: 'info@lumieresolutions.com.au' },
  { name: 'Delacroy', email: 'admin@delacroytraining.com.au' },
  { name: 'Test RTO', email: 'asadawan16900@gmail.com' },
  { name: 'RPL Test RTO', email: 'rpl@certifiedaustralia.com.au' },
];

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log(APPLY ? 'Mode: APPLY (writing)\n' : 'Mode: dry run (re-run with --apply to write)\n');

  for (const p of PARTNERS) {
    const existing = await RTOPartner.findOne({ email: p.email }).lean();
    if (existing) {
      if (existing.name === p.name) { console.log(`= ${p.name} <${p.email}>`); continue; }
      console.log(`~ ${p.email}: "${existing.name}" -> "${p.name}"`);
      if (APPLY) await RTOPartner.updateOne({ _id: existing._id }, { $set: { name: p.name } });
    } else {
      console.log(`+ ${p.name} <${p.email}>`);
      if (APPLY) await RTOPartner.create(p);
    }
  }

  // Partners that appear on a qualification but aren't in the picker yet — Alpha is the
  // live case: it was added to twelve qualifications before it had an address.
  const onQuals = await Qualification.aggregate([
    { $unwind: '$rtoCosts' },
    { $group: { _id: '$rtoCosts.rtoName', email: { $first: '$rtoCosts.rtoEmail' }, n: { $sum: 1 } } },
  ]);
  const known = new Set(PARTNERS.map((p) => p.name.toLowerCase()));
  const orphans = onQuals.filter((r) => r._id && !known.has(String(r._id).toLowerCase()));

  if (orphans.length) {
    console.log('\nOn qualifications but not in the picker:');
    for (const o of orphans) {
      if (!o.email) {
        console.log(`  ! ${o._id} (${o.n} qualification(s)) — NO EMAIL, add it from the RTO Submission card`);
        continue;
      }
      const dupe = await RTOPartner.findOne({ email: o.email }).lean();
      if (dupe) { console.log(`  = ${o._id} <${o.email}> already present`); continue; }
      console.log(`  + ${o._id} <${o.email}>`);
      if (APPLY) await RTOPartner.create({ name: o._id, email: o.email });
    }
  }

  const total = await RTOPartner.countDocuments();
  console.log(APPLY ? `\nDone. ${total} partner(s) in the picker.` : '\nDry run — nothing was written.');
  await mongoose.disconnect();
})().catch(async (err) => {
  console.error('Failed:', err.message);
  try { await mongoose.disconnect(); } catch { /* noop */ }
  process.exit(1);
});
