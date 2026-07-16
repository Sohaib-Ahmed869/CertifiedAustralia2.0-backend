/**
 * Go-live user setup.
 *
 * Deletes ALL existing users, then creates the go-live staff accounts.
 * Passwords follow the standard scheme: CEO → Ceo@1234, Agent → Agent@1234.
 *
 * Safety: dry-run (shows what WOULD happen) unless `--confirm` is passed.
 *
 * Usage:
 *   node scripts/setup-golive-users.js            # dry run
 *   node scripts/setup-golive-users.js --confirm  # execute
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const mongoose = require('mongoose');
const User = require('../src/models/User');

// CEO role in this system is 'CEOReportingManager'.
const NEW_USERS = [
  { firstName: 'Zain',    lastName: 'Sheikh', email: 'zain.sheikh@calcite.live',            role: 'CEOReportingManager', password: 'Ceo@1234' },
  { firstName: 'Mostafa', lastName: '-',      email: 'ceo@certifiedaustralia.com.au',        role: 'CEOReportingManager', password: 'Ceo@1234' },
  { firstName: 'Sidra',   lastName: '-',      email: 'sidra@certifiedaustralia.com.au',      role: 'Agent',               password: 'Agent@1234' },
  { firstName: 'Sohaib',  lastName: 'Sipra',  email: 'sohaib.sipra@calcite.live',            role: 'CEOReportingManager', password: 'Ceo@1234' },
  { firstName: 'Asad',    lastName: '-',      email: 'asad@calcite.live',                    role: 'CEOReportingManager', password: 'Ceo@1234' },
];

function targetInfo() {
  const u = process.env.MONGODB_URI || '';
  try {
    const url = new URL(u.replace('mongodb+srv', 'https').replace('mongodb', 'http'));
    return `${url.host}${url.pathname || ''}`;
  } catch { return '(unparseable MONGODB_URI)'; }
}

async function run() {
  const confirm = process.argv.includes('--confirm');
  await mongoose.connect(process.env.MONGODB_URI);
  console.log(`Connected to: ${targetInfo()}`);
  console.log(confirm ? '\n*** LIVE RUN — deleting all users + creating go-live accounts ***\n' : '\n(DRY RUN — nothing will change; pass --confirm to execute)\n');

  // Snapshot existing users by role.
  const existing = await User.find({}).select('role').lean();
  const byRole = existing.reduce((acc, u) => { acc[u.role] = (acc[u.role] || 0) + 1; return acc; }, {});
  console.log(`── Existing users: ${existing.length} ──`);
  Object.entries(byRole).sort().forEach(([role, n]) => console.log(`  ${String(role).padEnd(22)} ${n}`));
  if (byRole.Student) console.log(`  ⚠ NOTE: ${byRole.Student} Student user(s) will also be deleted (their applications would be orphaned).`);

  console.log('\n── Accounts to create ──');
  NEW_USERS.forEach((u) => console.log(`  ${u.role.padEnd(22)} ${`${u.firstName} ${u.lastName}`.trim().padEnd(16)} ${u.email.padEnd(38)} pw: ${u.password}`));

  if (!confirm) {
    console.log('\nRe-run with --confirm to delete all users and create these accounts.');
    await mongoose.disconnect();
    process.exit(0);
  }

  // Delete all users.
  const { deletedCount } = await User.deleteMany({});
  console.log(`\n── Deleted ${deletedCount} user(s) ──`);

  // Create go-live accounts (password hashed by the User pre-save hook).
  console.log('── Creating accounts ──');
  for (const u of NEW_USERS) {
    await User.create({
      email: u.email,
      password: u.password,
      firstName: u.firstName,
      lastName: u.lastName,
      role: u.role,
      status: 'active',
      emailVerified: true,
      mfaEnabled: false,
    });
    console.log(`  ✓ ${u.role.padEnd(22)} ${u.email}`);
  }

  const finalUsers = await User.find({}).select('firstName lastName email role').lean();
  console.log(`\n── ${finalUsers.length} user(s) now in DB ──`);
  finalUsers.forEach((u) => console.log(`  ${String(u.role).padEnd(22)} ${`${u.firstName} ${u.lastName}`.trim().padEnd(16)} ${u.email}`));

  await mongoose.disconnect();
  console.log('\nDone.');
  process.exit(0);
}

run().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
