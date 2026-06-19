/**
 * Seed sample applications spread across all pipeline statuses.
 * Creates student users (if needed) and applications with realistic data.
 * Run after seed-users.js and seed.js.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const User = require('../src/models/User');
const Student = require('../src/models/Student');
const Application = require('../src/models/Application');
const ScreeningForm = require('../src/models/ScreeningForm');
const IntakeForm = require('../src/models/IntakeForm');
const Payment = require('../src/models/Payment');
const PaymentPlan = require('../src/models/PaymentPlan');
const Industry = require('../src/models/Industry');
const Qualification = require('../src/models/Qualification');

// ── Sample students to create ──────────────────────────────────────────────
const STUDENTS = [
  { email: 'student1@yopmail.com', firstName: 'Liam',    lastName: 'Parker',    phone: '+61412000001', state: 'NSW' },
  { email: 'student2@yopmail.com', firstName: 'Olivia',  lastName: 'Nguyen',    phone: '+61412000002', state: 'VIC' },
  { email: 'student3@yopmail.com', firstName: 'Noah',    lastName: 'Williams',  phone: '+61412000003', state: 'QLD' },
  { email: 'student4@yopmail.com', firstName: 'Emma',    lastName: 'Singh',     phone: '+61412000004', state: 'SA' },
  { email: 'student5@yopmail.com', firstName: 'Jack',    lastName: 'Brown',     phone: '+61412000005', state: 'WA' },
  { email: 'student6@yopmail.com', firstName: 'Sophia',  lastName: 'Kelly',     phone: '+61412000006', state: 'NSW' },
  { email: 'student7@yopmail.com', firstName: 'Oliver',  lastName: 'Taylor',    phone: '+61412000007', state: 'VIC' },
  { email: 'student8@yopmail.com', firstName: 'Ava',     lastName: 'Martinez',  phone: '+61412000008', state: 'QLD' },
  { email: 'student9@yopmail.com', firstName: 'Ethan',   lastName: 'Anderson',  phone: '+61412000009', state: 'NSW' },
  { email: 'student10@yopmail.com', firstName: 'Mia',    lastName: 'Thomas',    phone: '+61412000010', state: 'VIC' },
  { email: 'student11@yopmail.com', firstName: 'Lucas',  lastName: 'White',     phone: '+61412000011', state: 'SA' },
  { email: 'student12@yopmail.com', firstName: 'Chloe',  lastName: 'Harris',    phone: '+61412000012', state: 'WA' },
  { email: 'student13@yopmail.com', firstName: 'Henry',  lastName: 'Clark',     phone: '+61412000013', state: 'QLD' },
  { email: 'student14@yopmail.com', firstName: 'Amelia', lastName: 'Lewis',     phone: '+61412000014', state: 'NSW' },
  { email: 'student15@yopmail.com', firstName: 'James',  lastName: 'Walker',    phone: '+61412000015', state: 'VIC' },
  { email: 'student16@yopmail.com', firstName: 'Grace',  lastName: 'Hall',      phone: '+61412000016', state: 'ACT' },
  { email: 'student17@yopmail.com', firstName: 'Ben',    lastName: 'Allen',     phone: '+61412000017', state: 'NSW' },
  { email: 'student18@yopmail.com', firstName: 'Zara',   lastName: 'Young',     phone: '+61412000018', state: 'VIC' },
  { email: 'student19@yopmail.com', firstName: 'Ryan',   lastName: 'King',      phone: '+61412000019', state: 'QLD' },
  { email: 'student20@yopmail.com', firstName: 'Isla',   lastName: 'Scott',     phone: '+61412000020', state: 'SA' },
];

// ── Application templates — status + what data each status implies ──────────
const APP_TEMPLATES = [
  // 3 New — just created, nothing done
  { status: 'New', color: '', leadStatus: 'new' },
  { status: 'New', color: 'red', leadStatus: 'new' },
  { status: 'New', color: 'orange', leadStatus: 'new' },

  // 2 WaitingForPayment — agent contacted, waiting on payment
  { status: 'WaitingForPayment', color: 'yellow', leadStatus: 'contacted', needsAgent: true, contactAttempts: 2 },
  { status: 'WaitingForPayment', color: 'yellow', leadStatus: 'contacted', needsAgent: true, contactAttempts: 1 },

  // 2 StudentIntakeForm — paid, needs intake
  { status: 'StudentIntakeForm', color: 'green', leadStatus: 'qualified', needsAgent: true, needsPayment: true },
  { status: 'StudentIntakeForm', color: 'green', leadStatus: 'qualified', needsAgent: true, needsPlan: true },

  // 2 UploadDocuments — intake done, needs docs
  { status: 'UploadDocuments', color: 'green', leadStatus: 'qualified', needsAgent: true, needsPayment: true, needsIntake: true },
  { status: 'UploadDocuments', color: 'green', leadStatus: 'qualified', needsAgent: true, needsPayment: true, needsIntake: true },

  // 2 DocumentsUploaded — docs uploaded, under review
  { status: 'DocumentsUploaded', color: 'green', leadStatus: 'converted', needsAgent: true, needsPayment: true, needsIntake: true },
  { status: 'DocumentsUploaded', color: 'green', leadStatus: 'converted', needsAgent: true, needsPayment: true, needsIntake: true },

  // 2 StudentCompleted — all prereqs met, 21-day timer started
  { status: 'StudentCompleted', color: 'green', leadStatus: 'converted', needsAgent: true, needsPayment: true, needsIntake: true, needsTimer: true },
  { status: 'StudentCompleted', color: 'green', leadStatus: 'converted', needsAgent: true, needsPayment: true, needsIntake: true, needsTimer: true },

  // 2 SentToRTO — sent to RTO for assessment
  { status: 'SentToRTO', color: 'green', leadStatus: 'converted', needsAgent: true, needsRTO: true, needsPayment: true, needsIntake: true, needsTimer: true },
  { status: 'SentToRTO', color: 'green', leadStatus: 'converted', needsAgent: true, needsRTO: true, needsPayment: true, needsIntake: true, needsTimer: true },

  // 1 WaitingForVerification
  { status: 'WaitingForVerification', color: 'green', leadStatus: 'converted', needsAgent: true, needsRTO: true, needsPayment: true, needsIntake: true, needsTimer: true },

  // 1 ReadyForRTOPayment
  { status: 'ReadyForRTOPayment', color: 'green', leadStatus: 'converted', needsAgent: true, needsRTO: true, needsPayment: true, needsIntake: true, needsTimer: true },

  // 1 RTOInvoiceUploaded
  { status: 'RTOInvoiceUploaded', color: 'green', leadStatus: 'converted', needsAgent: true, needsRTO: true, needsPayment: true, needsIntake: true, needsTimer: true },

  // 1 CertificateGenerated
  { status: 'CertificateGenerated', color: 'green', leadStatus: 'converted', needsAgent: true, needsRTO: true, needsPayment: true, needsIntake: true, needsTimer: true },

  // 1 CertificateIssued
  { status: 'CertificateIssued', color: 'green', leadStatus: 'converted', needsAgent: true, needsRTO: true, needsPayment: true, needsIntake: true, needsTimer: true },
];

// ── Helpers ──────────────────────────────────────────────────────────────────

let appCounter = 10000;
const nextAppId = () => `APP${appCounter++}`;

const daysAgo = (n) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
};

async function seedApplications() {
  console.log('Connecting to MongoDB...');
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Connected.\n');

  // Fetch agent and RTO users
  const agent = await User.findOne({ email: 'agent@yopmail.com' }).lean();
  const rto = await User.findOne({ email: 'rto@yopmail.com' }).lean();
  if (!agent) throw new Error('Agent user not found — run seed-users.js first');
  if (!rto) throw new Error('RTO user not found — run seed-users.js first');

  // Fetch some qualifications (with their industries)
  const qualifications = await Qualification.find({ status: 'active' }).populate('industryId').limit(20).lean();
  if (qualifications.length < 5) throw new Error('Not enough qualifications — run seed.js first');

  const hashedPassword = await bcrypt.hash('Student@1234', 12);

  let created = 0;

  for (let i = 0; i < APP_TEMPLATES.length; i++) {
    const template = APP_TEMPLATES[i];
    const studentData = STUDENTS[i];
    const qual = qualifications[i % qualifications.length];

    // 1. Create or find student
    let student = await User.findOne({ email: studentData.email });
    if (!student) {
      student = await Student.create({
        email: studentData.email,
        password: hashedPassword,
        firstName: studentData.firstName,
        lastName: studentData.lastName,
        phone: studentData.phone,
        role: 'Student',
        status: 'active',
        emailVerified: true,
        applicationIds: [],
        consents: {
          termsOfServiceAccepted: true,
          privacyPolicyAccepted: true,
          eSignatureProvided: true,
          acceptedAt: daysAgo(30 + i),
        },
      });
      console.log(`  Created student: ${studentData.firstName} ${studentData.lastName}`);
    }

    // 2. Create screening form
    const screeningForm = await ScreeningForm.create({
      applicationId: new mongoose.Types.ObjectId(), // placeholder, will update
      industryId: qual.industryId._id,
      qualificationId: qual._id,
      yearsOfExperience: ['1-2 years', '3-4 years', '5-9 years', '10+ years'][i % 4],
      experienceLocation: ['Australia', 'Overseas', 'Both'][i % 3],
      state: studentData.state,
      hasFormalQualifications: i % 2 === 0,
      status: 'submitted',
      submittedAt: daysAgo(28 + i),
    });

    // 3. Build application data
    const appData = {
      applicationId: nextAppId(),
      studentId: student._id,
      industryId: qual.industryId._id,
      qualificationId: qual._id,
      status: template.status,
      leadStatus: template.leadStatus || 'new',
      color: template.color || '',
      contactAttempts: template.contactAttempts || 0,
      screeningFormId: screeningForm._id,
      createdAt: daysAgo(30 - i),
      updatedAt: daysAgo(Math.max(0, 15 - i)),
    };

    // Assign agent
    if (template.needsAgent) {
      appData.assignedAgentId = agent._id;
      appData.lastContactedAt = daysAgo(10 - Math.min(i, 9));
      appData.contactAttempts = template.contactAttempts || (i % 5) + 1;
    }

    // Assign RTO
    if (template.needsRTO) {
      appData.assignedRTOId = rto._id;
      appData.rtoAssignmentDate = daysAgo(12);
      appData.sentToRTOPortal = true;
      appData.sentToRTOPortalAt = daysAgo(11);
      appData.portalRtoEmail = 'rto@yopmail.com';
      appData.portalRtoName = 'Emily Davis';
    }

    // Create application
    const application = await Application.create(appData);

    // Update screening form with correct applicationId
    await ScreeningForm.findByIdAndUpdate(screeningForm._id, { applicationId: application._id });

    // 4. Create payment if needed
    if (template.needsPayment) {
      const price = qual.caPrice || 2500;
      const payment = await Payment.create({
        applicationId: application._id,
        studentId: student._id,
        amount: price,
        type: 'upfront',
        paymentMethod: 'manual',
        status: 'completed',
        notes: 'Seeded upfront payment',
        createdAt: daysAgo(25 - i),
      });
      application.paymentIds = [payment._id];
      await application.save();
    }

    if (template.needsPlan) {
      const price = qual.caPrice || 2500;
      const installmentAmount = Math.round(price / 4);
      const plan = await PaymentPlan.create({
        applicationId: application._id,
        studentId: student._id,
        totalAmount: price,
        totalPaidAmount: price,
        status: 'completed',
        installments: [0, 1, 2, 3].map((idx) => ({
          index: idx,
          amount: installmentAmount,
          paidAmount: installmentAmount,
          dueDate: daysAgo(24 - idx * 7),
          paymentDate: daysAgo(24 - idx * 7),
          status: 'paid',
        })),
      });
      application.paymentPlanId = plan._id;
      await application.save();
    }

    // 5. Create intake form if needed
    if (template.needsIntake) {
      const intakeForm = await IntakeForm.create({
        applicationId: application._id,
        firstName: studentData.firstName,
        surname: studentData.lastName,
        email: studentData.email,
        phoneNumber: studentData.phone,
        dateOfBirth: new Date('1990-01-15'),
        gender: i % 2 === 0 ? 'Male' : 'Female',
        streetAddress: `${100 + i} Test Street`,
        suburb: 'Sydney',
        state: studentData.state,
        postcode: '2000',
        countryOfBirth: 'Australia',
        englishLevel: 'Native',
        isAustralianCitizen: true,
        isAboriginalOrTorresStrait: false,
        hasDisability: false,
        employmentStatus: 'Employed',
        businessName: 'Test Employer Pty Ltd',
        position: 'Senior Worker',
        previousQualifications: 'Certificate III',
        status: 'submitted',
        submittedAt: daysAgo(20 - i),
      });
      application.intakeFormId = intakeForm._id;
      await application.save();
    }

    // 6. Set 21-day timer if needed
    if (template.needsTimer) {
      application.studentCompletionDate = daysAgo(18);
      application.rtoCompletionDeadline = new Date(daysAgo(18).getTime() + 21 * 24 * 60 * 60 * 1000);
      await application.save();
    }

    // 7. Update student's applicationIds
    await Student.findByIdAndUpdate(student._id, {
      $addToSet: { applicationIds: application._id },
    });

    created++;
    console.log(`  ${template.status.padEnd(25)} — ${appData.applicationId} — ${studentData.firstName} ${studentData.lastName} (${qual.name})`);
  }

  console.log(`\nSeeded ${created} applications across all statuses.`);
  await mongoose.disconnect();
}

seedApplications().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
