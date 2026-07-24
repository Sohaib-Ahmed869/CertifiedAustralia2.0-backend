/**
 * Seed an initial leadStatusHistory entry for existing Applications that have a
 * `color` (lead status) set but no history trail yet. This lets the CEO Lead
 * Status Tracking tab reflect current lead states as their starting point.
 *
 * The seed entry is stamped at the application's `updatedAt` (best available
 * proxy for when the color was last set), with previousColor '' (unknown origin).
 *
 * Run once after deploying the leadStatusHistory field:
 *   node scripts/backfill-lead-status-history.js
 */
require('dotenv').config();
const mongoose = require('mongoose');
const Application = require('../src/models/Application');

async function run() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Connected to MongoDB');

  // Apps with a non-empty color but empty/missing history
  const apps = await Application.find({
    color: { $exists: true, $nin: ['', null] },
    $or: [
      { leadStatusHistory: { $exists: false } },
      { leadStatusHistory: { $size: 0 } },
    ],
  })
    .select('_id color updatedAt createdAt')
    .lean();

  console.log(`Found ${apps.length} applications with a color but no history`);

  let updated = 0;
  for (const app of apps) {
    const changedAt = app.updatedAt || app.createdAt || new Date();
    await Application.updateOne(
      { _id: app._id },
      {
        $push: {
          leadStatusHistory: {
            color: app.color,
            previousColor: '',
            changedAt,
            changedByName: 'System (backfill)',
          },
        },
      }
    );
    updated += 1;
  }

  console.log(`\nDone. Seeded history for ${updated} applications.`);
  await mongoose.disconnect();
}

run().catch((err) => {
  console.error('Backfill failed:', err);
  process.exit(1);
});
