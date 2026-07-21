/**
 * One-off: create two test students (Adil, Sohaib) each with one application,
 * carrying the dev's real phone numbers, for Call Burst testing. Run once.
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
  { firstName: 'Adil', lastName: 'Test', email: 'adil.test@certifiedtest.dev', phone: '+923105725515' },
  { firstName: 'Sohaib', lastName: 'Test', email: 'sohaib.test@certifiedtest.dev', phone: '+923335626720' },
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
      // Already created on a previous run — just make sure the phone is set.
      await User.findByIdAndUpdate(exists._id, { phone: s.phone });
      const app = await Application.findOne({ studentId: exists._id }).lean();
      console.log(`• ${s.firstName} already existed  ${app?.applicationId || ''}  →  ${s.phone}`);
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
    const app = await Application.findOne({ studentId: (await User.findOne({ email: s.email }))._id }).lean();
    console.log(`✓ Created ${s.firstName} ${s.lastName}  ${app?.applicationId || ''}  →  ${s.phone}`);
  }

  console.log('\nDone. Select these + Asad Awan (APP26211) in Admin → Call Burst.');
  await mongoose.disconnect();
  process.exit(0);
})().catch((err) => {
  console.error('Failed:', err.message);
  process.exit(1);
});
