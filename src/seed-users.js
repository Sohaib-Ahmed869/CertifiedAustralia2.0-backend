require('dotenv').config();
const mongoose = require('mongoose');
const speakeasy = require('speakeasy');
const User = require('./models/User');

const users = [
  {
    email: 'admin@yopmail.com',
    password: 'Admin@1234',
    firstName: 'Sarah',
    lastName: 'Mitchell',
    phone: '+61400000001',
    role: 'Admin',
    status: 'active',
    emailVerified: true,
  },
  {
    email: 'ceo@yopmail.com',
    password: 'Ceo@1234',
    firstName: 'James',
    lastName: 'Thompson',
    phone: '+61400000002',
    role: 'CEOReportingManager',
    status: 'active',
    emailVerified: true,
  },
  {
    email: 'agent@yopmail.com',
    password: 'Agent@1234',
    firstName: 'Michael',
    lastName: 'Chen',
    phone: '+61400000003',
    role: 'Agent',
    status: 'active',
    emailVerified: true,
  },
  {
    email: 'rto@yopmail.com',
    password: 'Rto@1234',
    firstName: 'Emily',
    lastName: 'Davis',
    phone: '+61400000004',
    role: 'InternalRTO',
    status: 'active',
    emailVerified: true,
  },
  {
    email: 'support@yopmail.com',
    password: 'Support@1234',
    firstName: 'David',
    lastName: 'Wilson',
    phone: '+61400000005',
    role: 'Support',
    status: 'active',
    emailVerified: true,
  },
];

async function seedUsers() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Connected to MongoDB');

  for (const userData of users) {
    const existing = await User.findOne({ email: userData.email });
    if (existing) {
      console.log(`  Skipped ${userData.role} (${userData.email}) — already exists`);
      continue;
    }

    // Generate MFA secret for non-student users
    const secret = speakeasy.generateSecret({
      name: `CertifiedAustralia (${userData.email})`,
      issuer: 'CertifiedAustralia',
    });

    const user = await User.create({
      ...userData,
      mfaEnabled: true,
      mfaSecret: secret.base32,
    });
    console.log(`  Created ${userData.role}: ${userData.email} (MFA enabled)`);
  }

  console.log('\nUser seeding complete.');
  await mongoose.disconnect();
}

seedUsers().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
