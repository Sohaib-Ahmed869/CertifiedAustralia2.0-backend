/**
 * One-off: put the dev's real test phone numbers onto two student applications
 * so the Call Burst feature can be tested end-to-end. Run once, then delete.
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const mongoose = require('mongoose');
const connectDB = require('../src/config/db');
const Application = require('../src/models/Application');
const User = require('../src/models/User');
require('../src/models/Qualification');

const TEST_PHONES = ['+923365767950', '+923312104777'];

(async () => {
  await connectDB();

  // Pick two recent applications whose student ref actually resolves (skip orphans),
  // and ensure the two are distinct students.
  const candidates = await Application.find({ studentId: { $ne: null } })
    .sort('-createdAt')
    .limit(40)
    .populate('studentId', 'firstName lastName phone')
    .populate('qualificationId', 'name');

  const apps = [];
  const usedStudents = new Set();
  for (const app of candidates) {
    if (!app.studentId?._id) continue;
    if (usedStudents.has(String(app.studentId._id))) continue;
    usedStudents.add(String(app.studentId._id));
    apps.push(app);
    if (apps.length === TEST_PHONES.length) break;
  }

  if (apps.length < TEST_PHONES.length) {
    console.log(`Only found ${apps.length} usable application(s) — need ${TEST_PHONES.length}.`);
    await mongoose.disconnect();
    process.exit(0);
  }

  for (let i = 0; i < apps.length; i++) {
    const app = apps[i];
    const phone = TEST_PHONES[i];
    await User.findByIdAndUpdate(app.studentId._id, { phone });
    console.log(
      `✓ ${app.applicationId}  ${app.studentId.firstName || ''} ${app.studentId.lastName || ''}`.trim() +
        `  →  ${phone}   (${app.qualificationId?.name || 'no qual'})`
    );
  }

  console.log('\nSelect the two applications above in Admin → Call Burst to test.');
  await mongoose.disconnect();
  process.exit(0);
})().catch((err) => {
  console.error('Failed:', err.message);
  process.exit(1);
});
