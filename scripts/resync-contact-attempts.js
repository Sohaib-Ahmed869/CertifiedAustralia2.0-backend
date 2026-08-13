/**
 * resync-contact-attempts.js
 *
 * One-off (and safely re-runnable) backfill that rebuilds every application's
 * Contact Tracking counters from the Call Scorecard (CallEvent):
 *
 *   contactAttempts = outbound CallEvents for the application
 *   incomingCalls   = incoming CallEvents for the application
 *   lastContactedAt = most recent CallEvent
 *
 * Needed once because the counters used to be typed in by hand on the student
 * detail page, so historical values are a mix of manual clicks and logged
 * calls. After this runs, the numbers match the Call Log exactly.
 *
 * Applications with no CallEvents but a non-zero counter are reset to 0 — pass
 * --keep-orphans to leave those legacy hand-entered values alone instead.
 *
 * Usage (from certfied-australia-v2-be/):
 *   node scripts/resync-contact-attempts.js
 *   node scripts/resync-contact-attempts.js --keep-orphans
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const mongoose = require('mongoose');
const contactTracking = require('../src/services/contactTrackingService');

async function main() {
  const keepOrphans = process.argv.includes('--keep-orphans');

  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('MONGODB_URI is not set — check certfied-australia-v2-be/.env');
    process.exit(1);
  }

  await mongoose.connect(uri);
  console.log('Connected. Rebuilding contact counters from the Call Scorecard…');

  const { synced, reset } = await contactTracking.syncAll({ resetOrphans: !keepOrphans });

  console.log(`✔ ${synced} application(s) resynced from their call events`);
  console.log(
    keepOrphans
      ? '· orphaned manual counters left untouched (--keep-orphans)'
      : `✔ ${reset} application(s) with no logged calls reset to 0`
  );

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error('Resync failed:', err);
  try { await mongoose.disconnect(); } catch { /* already down */ }
  process.exit(1);
});
