/**
 * Clear all application-related data from the database.
 * Keeps: users, catalog (industries, qualifications, checklists, reference letters, email templates),
 *        dynamic forms, calendar connections, mailboxes, cashflow configs.
 * Clears: applications, intake forms, screening forms, payments, payment plans,
 *         documents, document feedback, certificates, tickets, notifications,
 *         tasks, form submissions, cashflow weeks, expense ledgers, agent targets,
 *         campaigns, marketing spends.
 * Also resets Student applicationIds arrays.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const mongoose = require('mongoose');

const MONGODB_URI = process.env.MONGODB_URI;

async function clearAppData() {
  console.log('Connecting to MongoDB...');
  await mongoose.connect(MONGODB_URI);
  console.log('Connected.\n');

  const db = mongoose.connection.db;

  // Collections to drop (application-related data)
  const toDrop = [
    'applications',
    'intakeforms',
    'screeningforms',
    'payments',
    'paymentplans',
    'documents',
    'documentfeedbacks',
    'certificates',
    'tickets',
    'notifications',
    'tasks',
    'formsubmissions',
    'cashflowweeks',
    'expenseledgers',
    'agenttargets',
    'campaigns',
    'marketingspends',
  ];

  for (const name of toDrop) {
    try {
      const exists = await db.listCollections({ name }).hasNext();
      if (exists) {
        const { deletedCount } = await db.collection(name).deleteMany({});
        console.log(`  ✓ ${name}: ${deletedCount} documents deleted`);
      } else {
        console.log(`  - ${name}: collection does not exist (skipped)`);
      }
    } catch (err) {
      console.error(`  ✗ ${name}: ${err.message}`);
    }
  }

  // Reset Student applicationIds
  console.log('\nResetting Student applicationIds...');
  const result = await db.collection('users').updateMany(
    { userType: 'Student' },
    { $set: { applicationIds: [] } }
  );
  console.log(`  ✓ ${result.modifiedCount} student(s) reset`);

  console.log('\nDone. Users and catalog data preserved.');
  await mongoose.disconnect();
}

clearAppData().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
