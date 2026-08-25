/**
 * Drop the legacy UNIQUE index on emailtemplates.name.
 *
 * The model no longer declares it, but Mongo keeps an index that already exists —
 * so until this runs, saving a second template with a name that collides with an
 * existing one still fails with E11000. Safe to run more than once.
 *
 *   node scripts/drop-email-template-name-index.js          # report only
 *   node scripts/drop-email-template-name-index.js --apply  # drop it
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const mongoose = require('mongoose');

const APPLY = process.argv.includes('--apply');

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  const col = mongoose.connection.collection('emailtemplates');
  const indexes = await col.indexes();
  const unique = indexes.filter((i) => i.unique && i.key && i.key.name === 1);

  if (!unique.length) {
    console.log('No unique index on `name` — nothing to do.');
  } else {
    for (const idx of unique) {
      if (APPLY) {
        await col.dropIndex(idx.name);
        console.log(`Dropped unique index "${idx.name}".`);
      } else {
        console.log(`Would drop unique index "${idx.name}" (re-run with --apply).`);
      }
    }
    if (APPLY) {
      await col.createIndex({ name: 1 });
      console.log('Recreated a plain (non-unique) index on `name`.');
    }
  }

  await mongoose.disconnect();
})().catch(async (err) => {
  console.error('Failed:', err.message);
  try { await mongoose.disconnect(); } catch { /* noop */ }
  process.exit(1);
});
