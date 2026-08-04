/**
 * Backfill the `isSalesAgent` flag on existing users.
 *
 * "Agent-ness" is now an explicit per-user flag (isSalesAgent) rather than being
 * inferred from role === 'Agent'. Existing users pre-date the field, so seed it:
 *   - role === 'Agent'  → true  (they were agents by definition)
 *   - everyone else     → false (opt-in; toggle from User Management afterwards)
 *
 * Optionally force-enable specific accounts by email via --enable=a@x.com,b@y.com
 * (useful for higher-role staff who also sell, e.g. a CEO closing deals).
 *
 * Only touches users where the field is currently unset, so it is safe to re-run
 * and will not clobber toggles made in the UI.
 *
 * Usage:
 *   node scripts/backfill-sales-agents.js                        # dry run
 *   node scripts/backfill-sales-agents.js --confirm              # execute
 *   node scripts/backfill-sales-agents.js --confirm --enable=ceo@certifiedaustralia.com.au
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const mongoose = require('mongoose');
const User = require('../src/models/User');

function parseEnableEmails() {
  const arg = process.argv.find((a) => a.startsWith('--enable='));
  if (!arg) return [];
  return arg.slice('--enable='.length).split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);
}

async function run() {
  const confirm = process.argv.includes('--confirm');
  const enableEmails = parseEnableEmails();

  await mongoose.connect(process.env.MONGODB_URI);
  console.log(confirm ? '\n*** LIVE RUN ***\n' : '\n(DRY RUN — pass --confirm to execute)\n');

  // Only seed users that don't already have the flag set (don't clobber UI toggles).
  const unset = await User.find({ isSalesAgent: { $in: [null, undefined] } })
    .select('firstName lastName email role isSalesAgent')
    .lean();

  const willBeAgents = unset.filter((u) => u.role === 'Agent' || enableEmails.includes((u.email || '').toLowerCase()));
  console.log(`── ${unset.length} user(s) missing the flag ──`);
  console.log(`   → ${willBeAgents.length} will be set to isSalesAgent = true:`);
  willBeAgents.forEach((u) => console.log(`      ✓ ${String(u.role).padEnd(20)} ${`${u.firstName} ${u.lastName}`.trim().padEnd(24)} ${u.email}`));
  console.log(`   → ${unset.length - willBeAgents.length} will be set to false.`);

  if (!confirm) {
    console.log('\nRe-run with --confirm to apply.');
    await mongoose.disconnect();
    process.exit(0);
  }

  // Agents (role Agent OR explicitly enabled by email) → true.
  const trueQuery = {
    isSalesAgent: { $in: [null, undefined] },
    $or: [{ role: 'Agent' }, ...(enableEmails.length ? [{ email: { $in: enableEmails } }] : [])],
  };
  const trueRes = await User.updateMany(trueQuery, { $set: { isSalesAgent: true } });

  // Everyone else still unset → false.
  const falseRes = await User.updateMany(
    { isSalesAgent: { $in: [null, undefined] } },
    { $set: { isSalesAgent: false } }
  );

  console.log(`\n── Done: ${trueRes.modifiedCount} set true, ${falseRes.modifiedCount} set false ──`);
  await mongoose.disconnect();
  process.exit(0);
}

run().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
