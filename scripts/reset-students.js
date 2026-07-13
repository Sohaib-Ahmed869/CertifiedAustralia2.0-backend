/**
 * Reset students & their data.
 *
 * Deletes all Student users and every record tied to students/applications,
 * plus student-generated operational data (notifications, tickets, chat, tasks).
 * KEEPS all management/staff users, the catalog, and all platform config.
 *
 * Safety: runs a dry-run (counts only) unless `--confirm` is passed.
 *
 * Usage:
 *   node scripts/reset-students.js            # dry run — shows what WOULD be deleted
 *   node scripts/reset-students.js --confirm  # actually delete
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const mongoose = require('mongoose');

const User = require('../src/models/User');

// Transactional / student-application collections to wipe entirely.
const COLLECTIONS = [
  ['Applications', require('../src/models/Application')],
  ['Payments', require('../src/models/Payment')],
  ['PaymentPlans', require('../src/models/PaymentPlan')],
  ['PaymentBatches', require('../src/models/PaymentBatch')],
  ['Documents', require('../src/models/Document')],
  ['DocumentFeedback', require('../src/models/DocumentFeedback')],
  ['Certificates', require('../src/models/Certificate')],
  ['IntakeForms', require('../src/models/IntakeForm')],
  ['ScreeningForms', require('../src/models/ScreeningForm')],
  ['FormSubmissions', require('../src/models/FormSubmission')],
  ['CallLogs', require('../src/models/CallLog')],
  ['CallEvents', require('../src/models/CallEvent')],
  ['CompetencyBookings', require('../src/models/CompetencyBooking')],
  ['ThirdPartyFormAccess', require('../src/models/ThirdPartyFormAccess')],
  ['RTOInvoices', require('../src/models/RTOInvoice')],
  ['Notifications', require('../src/models/Notification')],
  ['Tickets', require('../src/models/Ticket')],
  ['Conversations', require('../src/models/Conversation')],
  ['Messages', require('../src/models/Message')],
  ['ChatPresence', require('../src/models/ChatPresence')],
  ['Tasks', require('../src/models/Task')],
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
  console.log(confirm ? '\n*** LIVE RUN — deleting ***\n' : '\n(DRY RUN — nothing will be deleted; pass --confirm to execute)\n');

  // Snapshot current counts.
  console.log('── Collections to clear ──');
  let grandTotal = 0;
  for (const [label, Model] of COLLECTIONS) {
    const count = await Model.estimatedDocumentCount();
    grandTotal += count;
    console.log(`  ${label.padEnd(22)} ${count}`);
  }
  const studentCount = await User.countDocuments({ role: 'Student' });
  console.log(`  ${'Student users'.padEnd(22)} ${studentCount}`);
  console.log(`  ${'—'.repeat(28)}\n  TOTAL records: ${grandTotal + studentCount}\n`);

  if (!confirm) {
    const keptUsers = await User.countDocuments({ role: { $ne: 'Student' } });
    console.log(`Would KEEP ${keptUsers} management/staff user(s) + catalog + all config.`);
    console.log('\nRe-run with --confirm to perform the deletion.');
    await mongoose.disconnect();
    process.exit(0);
  }

  // ── Delete ──
  console.log('── Deleting ──');
  for (const [label, Model] of COLLECTIONS) {
    const { deletedCount } = await Model.deleteMany({});
    console.log(`  ${label.padEnd(22)} ${deletedCount} deleted`);
  }
  const { deletedCount: studentsDeleted } = await User.deleteMany({ role: 'Student' });
  console.log(`  ${'Student users'.padEnd(22)} ${studentsDeleted} deleted`);

  // ── Verify kept users ──
  const remaining = await User.find({}).select('firstName lastName email role').lean();
  const byRole = remaining.reduce((acc, u) => { acc[u.role] = (acc[u.role] || 0) + 1; return acc; }, {});
  console.log(`\n── Kept ${remaining.length} user(s) ──`);
  Object.entries(byRole).sort().forEach(([role, n]) => console.log(`  ${String(role).padEnd(22)} ${n}`));
  if (remaining.some((u) => u.role === 'Student')) {
    console.log('\n  ⚠ WARNING: a Student user survived — investigate.');
  }

  await mongoose.disconnect();
  console.log('\nDone.');
  process.exit(0);
}

run().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
