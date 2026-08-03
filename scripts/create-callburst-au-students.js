/**
 * One-off: create two test students carrying the dev's real AU mobile numbers,
 * so Call Burst can dial them end-to-end. Idempotent — re-running just re-syncs
 * the phone number onto the existing students. Run once from certfied-australia-v2-be/:
 *   node scripts/create-callburst-au-students.js
 */
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const mongoose = require('mongoose');
const connectDB = require('../src/config/db');
const Application = require('../src/models/Application');
const User = require('../src/models/User');
require('../src/models/Qualification');
require('../src/models/Industry');
const authService = require('../src/services/authService');

const NEW = [
  { firstName: 'CallBurst', lastName: 'AU One', email: 'callburst.au1@certifiedtest.dev', phone: '+61415171890' },
  { firstName: 'CallBurst', lastName: 'AU Two', email: 'callburst.au2@certifiedtest.dev', phone: '+61402943393' },
];

(async () => {
  await connectDB();

  // Reuse a valid industry + qualification pair from an existing application.
  const sample = await Application.findOne({ industryId: { $ne: null }, qualificationId: { $ne: null } })
    .sort('-createdAt')
    .lean();
  if (!sample) {
    console.log('No existing application to source an industry/qualification from.');
    await mongoose.disconnect();
    process.exit(1);
  }

  for (const s of NEW) {
    const exists = await User.findOne({ email: s.email });
    if (exists) {
      await User.findByIdAndUpdate(exists._id, { phone: s.phone });
      const app = await Application.findOne({ studentId: exists._id }).lean();
      console.log(`• ${s.firstName} ${s.lastName} already existed  ${app?.applicationId || ''}  →  ${s.phone}`);
      continue;
    }
    await authService.register({
      firstName: s.firstName,
      lastName: s.lastName,
      email: s.email,
      phone: s.phone,
      password: 'Test1234!',
      termsAccepted: true,
      industryId: sample.industryId,
      qualificationId: sample.qualificationId,
      yearsOfExperience: '5-9 years',
      experienceLocation: 'Australia',
      state: 'NSW',
      source: 'call-burst-test',
    });
    const created = await User.findOne({ email: s.email });
    const app = await Application.findOne({ studentId: created._id }).lean();
    console.log(`✓ Created ${s.firstName} ${s.lastName}  ${app?.applicationId || ''}  →  ${s.phone}`);
  }

  console.log('\nDone. In Admin → Call Burst, select these two students and start the burst.');
  await mongoose.disconnect();
  process.exit(0);
})().catch((err) => {
  console.error('Failed:', err.message);
  process.exit(1);
});
