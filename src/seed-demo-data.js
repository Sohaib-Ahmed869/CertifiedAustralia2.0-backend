/**
 * seed-demo-data.js
 * ------------------
 * Seeds the database with realistic demo data spanning the full application lifecycle.
 * Creates students, applications at every stage, screening/intake forms, payments,
 * payment plans, tasks, tickets, and notifications.
 *
 * Usage:
 *   node src/seed-demo-data.js
 *
 * Safe to re-run — skips students that already exist, clears and re-creates
 * applications and related data for demo students only.
 */

require('dotenv').config();
const mongoose = require('mongoose');
const User = require('./models/User');
const Student = require('./models/Student');
const Application = require('./models/Application');
const ScreeningForm = require('./models/ScreeningForm');
const IntakeForm = require('./models/IntakeForm');
const Payment = require('./models/Payment');
const PaymentPlan = require('./models/PaymentPlan');
const Task = require('./models/Task');
const Ticket = require('./models/Ticket');
const Notification = require('./models/Notification');
const Industry = require('./models/Industry');
const Qualification = require('./models/Qualification');

// ---------------------------------------------------------------------------
// Demo students — realistic Australian names
// ---------------------------------------------------------------------------
const DEMO_STUDENTS = [
  { email: 'liam.nguyen@yopmail.com',     firstName: 'Liam',     lastName: 'Nguyen',     phone: '+61412000001', usi: '4K8J9P2QR5', state: 'NSW', suburb: 'Parramatta',    postcode: '2150', street: '42 Church St' },
  { email: 'olivia.smith@yopmail.com',     firstName: 'Olivia',   lastName: 'Smith',      phone: '+61412000002', usi: '7M3N5T8WX2', state: 'VIC', suburb: 'Carlton',       postcode: '3053', street: '15 Lygon St' },
  { email: 'noah.patel@yopmail.com',       firstName: 'Noah',     lastName: 'Patel',      phone: '+61412000003', usi: '2R6S4V9YZ1', state: 'QLD', suburb: 'Southport',     postcode: '4215', street: '88 Nerang St' },
  { email: 'charlotte.jones@yopmail.com',  firstName: 'Charlotte',lastName: 'Jones',      phone: '+61412000004', usi: '9A1B3D6FG8', state: 'SA',  suburb: 'Adelaide',      postcode: '5000', street: '7 Rundle Mall' },
  { email: 'jack.williams@yopmail.com',    firstName: 'Jack',     lastName: 'Williams',   phone: '+61412000005', usi: '5H2J7K4LM0', state: 'WA',  suburb: 'Fremantle',     postcode: '6160', street: '23 High St' },
  { email: 'amelia.brown@yopmail.com',     firstName: 'Amelia',   lastName: 'Brown',      phone: '+61412000006', usi: '8N3P6Q9RS1', state: 'NSW', suburb: 'Bondi',         postcode: '2026', street: '5 Campbell Pde' },
  { email: 'oliver.garcia@yopmail.com',    firstName: 'Oliver',   lastName: 'Garcia',     phone: '+61412000007', usi: '1T4U7V2WX5', state: 'VIC', suburb: 'Richmond',      postcode: '3121', street: '112 Bridge Rd' },
  { email: 'mia.taylor@yopmail.com',       firstName: 'Mia',      lastName: 'Taylor',     phone: '+61412000008', usi: '6Y9Z3A5BC8', state: 'QLD', suburb: 'Toowoomba',     postcode: '4350', street: '31 Russell St' },
  { email: 'william.lee@yopmail.com',      firstName: 'William',  lastName: 'Lee',        phone: '+61412000009', usi: '0D2E4F7GH3', state: 'NSW', suburb: 'Chatswood',     postcode: '2067', street: '9 Victor St' },
  { email: 'isla.martin@yopmail.com',      firstName: 'Isla',     lastName: 'Martin',     phone: '+61412000010', usi: '3I6J8K1LM4', state: 'VIC', suburb: 'St Kilda',      postcode: '3182', street: '67 Fitzroy St' },
  { email: 'james.chen@yopmail.com',       firstName: 'James',    lastName: 'Chen',       phone: '+61412000011', usi: '7N0P2Q5RS9', state: 'ACT', suburb: 'Braddon',       postcode: '2612', street: '14 Lonsdale St' },
  { email: 'sophie.kumar@yopmail.com',     firstName: 'Sophie',   lastName: 'Kumar',      phone: '+61412000012', usi: '4T6U9V1WX7', state: 'NT',  suburb: 'Darwin City',   postcode: '0800', street: '3 Mitchell St' },
  { email: 'ethan.wilson@yopmail.com',     firstName: 'Ethan',    lastName: 'Wilson',     phone: '+61412000013', usi: '2Y5Z8A0BC6', state: 'TAS', suburb: 'Hobart',        postcode: '7000', street: '55 Elizabeth St' },
  { email: 'grace.anderson@yopmail.com',   firstName: 'Grace',    lastName: 'Anderson',   phone: '+61412000014', usi: '8D1E3F6GH0', state: 'SA',  suburb: 'Glenelg',       postcode: '5045', street: '22 Jetty Rd' },
  { email: 'lucas.thompson@yopmail.com',   firstName: 'Lucas',    lastName: 'Thompson',   phone: '+61412000015', usi: '5I7J0K3LM9', state: 'WA',  suburb: 'Subiaco',       postcode: '6008', street: '41 Rokeby Rd' },
];

// Which application status each student should have (spread across lifecycle)
// Stages that can be seeded without actual document uploads.
// DocumentsSubmitted and beyond require real files — excluded to avoid inconsistency.
const APPLICATION_STAGES = [
  'LeadCaptured',
  'ApplicationCreated',
  'AgentAssigned',
  'InContact',
  'Paid',
  'OnPlan',
  'IntakeComplete',
];

const EXPERIENCE_LEVELS = ['1-2 years', '3-4 years', '5-9 years', '10+ years'];
const EXPERIENCE_LOCATIONS = ['Australia', 'Overseas', 'Both'];
const GENDERS = ['Male', 'Female', 'Non-binary', 'Prefer not to say'];
const EMPLOYMENT_STATUSES = ['Full-time', 'Part-time', 'Casual', 'Self-employed', 'Unemployed'];
const COUNTRIES = ['Australia', 'India', 'China', 'Philippines', 'United Kingdom', 'New Zealand', 'Vietnam', 'Sri Lanka'];
const ENGLISH_LEVELS = ['Native', 'Advanced', 'Intermediate', 'Basic'];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
}

function daysFromNow(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function seedDemoData() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Connected to MongoDB\n');

  // ---- Fetch existing staff users ----
  const adminUser = await User.findOne({ role: 'Admin' });
  const agentUser = await User.findOne({ role: 'Agent' });
  const rtoUser = await User.findOne({ role: 'InternalRTO' });
  const supportUser = await User.findOne({ role: 'Support' });

  if (!adminUser || !agentUser || !rtoUser || !supportUser) {
    console.error('ERROR: Staff users not found. Run seed-users.js first.');
    process.exit(1);
  }

  console.log('  Staff users found:');
  console.log(`    Admin:   ${adminUser.email}`);
  console.log(`    Agent:   ${agentUser.email}`);
  console.log(`    RTO:     ${rtoUser.email}`);
  console.log(`    Support: ${supportUser.email}\n`);

  // ---- Fetch industries & qualifications ----
  const industries = await Industry.find({ status: 'active' });
  if (industries.length === 0) {
    console.error('ERROR: No industries found. Run seed.js first.');
    process.exit(1);
  }

  const qualifications = await Qualification.find({ status: 'active' });
  console.log(`  Found ${industries.length} industries, ${qualifications.length} qualifications\n`);

  // Build a lookup: industryId → [qualifications]
  const qualsByIndustry = {};
  for (const q of qualifications) {
    const key = q.industryId.toString();
    if (!qualsByIndustry[key]) qualsByIndustry[key] = [];
    qualsByIndustry[key].push(q);
  }

  // ---- Create demo students ----
  console.log('  Creating demo students...');
  const studentRecords = [];

  for (const s of DEMO_STUDENTS) {
    let student = await User.findOne({ email: s.email });
    if (student) {
      console.log(`    Skipped ${s.email} — already exists`);
      studentRecords.push({ student, ...s });
      continue;
    }

    student = await Student.create({
      email: s.email,
      password: 'Student@1234',
      firstName: s.firstName,
      lastName: s.lastName,
      phone: s.phone,
      role: 'Student',
      status: 'active',
      emailVerified: true,
      mfaEnabled: false,
      usi: s.usi,
      consents: {
        termsOfServiceAccepted: true,
        eSignatureProvided: true,
        privacyPolicyAccepted: true,
        acceptedAt: daysAgo(30),
      },
      signupDiscountApplied: true,
    });
    console.log(`    Created: ${s.firstName} ${s.lastName} (${s.email})`);
    studentRecords.push({ student, ...s });
  }

  // ---- Clean existing demo data (applications and related) for demo students ----
  const demoStudentIds = studentRecords.map((r) => r.student._id);
  const existingApps = await Application.find({ studentId: { $in: demoStudentIds } });
  const existingAppIds = existingApps.map((a) => a._id);

  if (existingAppIds.length > 0) {
    console.log(`\n  Cleaning ${existingAppIds.length} existing demo applications...`);
    await ScreeningForm.deleteMany({ applicationId: { $in: existingAppIds } });
    await IntakeForm.deleteMany({ applicationId: { $in: existingAppIds } });
    await Payment.deleteMany({ applicationId: { $in: existingAppIds } });
    await PaymentPlan.deleteMany({ applicationId: { $in: existingAppIds } });
    await Task.deleteMany({ applicationId: { $in: existingAppIds } });
    await Ticket.deleteMany({ applicationId: { $in: existingAppIds } });
    await Notification.deleteMany({ userId: { $in: demoStudentIds } });
    await Application.deleteMany({ _id: { $in: existingAppIds } });
  }

  // ---- Create applications at various lifecycle stages ----
  console.log('\n  Creating applications across lifecycle stages...\n');

  let appCounter = 10100; // Start after any existing APP10000-range IDs

  for (let i = 0; i < studentRecords.length; i++) {
    const { student, state, suburb, postcode, street, usi } = studentRecords[i];
    const status = APPLICATION_STAGES[i % APPLICATION_STAGES.length];
    const statusIndex = APPLICATION_STAGES.indexOf(status);

    // Pick a random industry and qualification
    const industry = industries[i % industries.length];
    const industryQuals = qualsByIndustry[industry._id.toString()] || [];
    const qualification = industryQuals.length > 0
      ? industryQuals[i % industryQuals.length]
      : qualifications[i % qualifications.length];

    const createdAt = daysAgo(60 - i * 3); // Stagger creation dates
    const applicationId = `APP${appCounter++}`;

    // ---- Screening Form ----
    const screeningForm = await ScreeningForm.create({
      applicationId: new mongoose.Types.ObjectId(), // placeholder, will update
      industryId: industry._id,
      qualificationId: qualification._id,
      yearsOfExperience: pick(EXPERIENCE_LEVELS),
      experienceLocation: pick(EXPERIENCE_LOCATIONS),
      state: state,
      hasFormalQualifications: Math.random() > 0.4,
      formalQualifications: Math.random() > 0.4 ? ['Certificate III', 'Diploma'] : [],
      status: 'submitted',
      submittedAt: createdAt,
      createdAt,
    });

    // ---- Application ----
    const appData = {
      applicationId,
      studentId: student._id,
      industryId: industry._id,
      qualificationId: qualification._id,
      status,
      screeningFormId: screeningForm._id,
      leadStatus: statusIndex >= 3 ? 'converted' : statusIndex >= 1 ? 'qualified' : 'new',
      color: statusIndex >= 4 ? 'yellow' : statusIndex >= 3 ? 'orange' : statusIndex >= 1 ? 'red' : 'gray',
      createdAt,
      updatedAt: daysAgo(Math.max(0, 60 - i * 3 - statusIndex * 2)),
    };

    // Assign agent for stages >= AgentAssigned (index 2)
    if (statusIndex >= 2) {
      appData.assignedAgentId = agentUser._id;
      appData.contactAttempts = Math.floor(Math.random() * 5) + 1;
      appData.lastContactedAt = daysAgo(Math.max(1, 30 - statusIndex * 2));
    }

    // Add follow-up calls for contacted stages
    if (statusIndex >= 3) {
      appData.followUpCalls = [
        {
          scheduledFor: daysAgo(40 - i * 2),
          completedAt: daysAgo(39 - i * 2),
          outcome: 'Reached — interested, sending documents',
          notes: `Spoke with ${student.firstName}, confirmed qualification interest.`,
          loggedBy: agentUser._id,
        },
      ];
      if (statusIndex >= 5) {
        appData.followUpCalls.push({
          scheduledFor: daysAgo(20 - i),
          completedAt: daysAgo(19 - i > 0 ? 19 - i : 1),
          outcome: 'Payment confirmed, moving to intake',
          notes: 'Student confirmed payment. Proceeding with intake form.',
          loggedBy: agentUser._id,
        });
      }
    }

    // Add notes for various stages
    appData.notes = [];
    if (statusIndex >= 1) {
      appData.notes.push({
        content: `Application created for ${student.firstName} ${student.lastName}. Industry: ${industry.name}.`,
        addedBy: adminUser._id,
        addedAt: createdAt,
        visibility: 'admin',
      });
    }
    if (statusIndex >= 3) {
      appData.notes.push({
        content: `Initial contact made. Student is experienced in the field and confident about RPL pathway.`,
        addedBy: agentUser._id,
        addedAt: daysAgo(35 - i * 2),
        visibility: 'admin',
      });
    }

    const application = await Application.create(appData);

    // Update screening form with correct applicationId
    await ScreeningForm.findByIdAndUpdate(screeningForm._id, {
      applicationId: application._id,
    });

    // ---- Intake Form (for stages >= IntakeComplete, index 6) ----
    let intakeForm = null;
    if (statusIndex >= 6) {
      intakeForm = await IntakeForm.create({
        applicationId: application._id,
        firstName: student.firstName,
        middleName: i % 3 === 0 ? 'James' : i % 3 === 1 ? 'Marie' : '',
        surname: student.lastName,
        usi: usi,
        gender: pick(GENDERS),
        dateOfBirth: new Date(1985 + (i % 15), i % 12, (i * 3 % 28) + 1),
        streetAddress: street,
        suburb: suburb,
        postcode: postcode,
        state: state,
        phoneNumber: student.phone,
        email: student.email,
        countryOfBirth: pick(COUNTRIES),
        englishLevel: pick(ENGLISH_LEVELS),
        isAustralianCitizen: Math.random() > 0.3,
        isAboriginalOrTorresStrait: Math.random() > 0.9,
        hasDisability: Math.random() > 0.85,
        previousQualifications: i % 2 === 0 ? 'Certificate III in a related field' : '',
        employmentStatus: pick(EMPLOYMENT_STATUSES),
        businessName: i % 3 === 0 ? 'Acme Services Pty Ltd' : i % 3 === 1 ? 'Southern Cross Solutions' : '',
        position: i % 2 === 0 ? 'Senior Technician' : 'Team Leader',
        employerLegalName: i % 3 === 0 ? 'Acme Services Pty Ltd' : '',
        employerPhone: i % 3 === 0 ? '+61398765432' : '',
        employerAddress: i % 3 === 0 ? '100 Collins St, Melbourne VIC 3000' : '',
        hasCreditToTransfer: Math.random() > 0.7,
        creditQualificationName: Math.random() > 0.7 ? 'Certificate II in related field' : '',
        creditYearCompleted: Math.random() > 0.7 ? 2020 : undefined,
        status: 'submitted',
        submittedAt: daysAgo(30 - i),
      });

      await Application.findByIdAndUpdate(application._id, {
        intakeFormId: intakeForm._id,
      });
    }

    // ---- Payments (for stages >= Paid, index 4) ----
    if (statusIndex >= 4) {
      const caPrice = qualification.caPrice || 3500;
      const discountAmount = 500; // signup discount

      // Discount payment
      const discountPayment = await Payment.create({
        applicationId: application._id,
        studentId: student._id,
        amount: discountAmount,
        type: 'discount',
        paymentMethod: 'manual',
        status: 'completed',
        discountAmount,
        discountReason: 'Signup discount — $500 automatic',
        authorizedBy: adminUser._id,
        createdAt: daysAgo(45 - i * 2),
      });

      if (status === 'Paid' || statusIndex >= 4 && i % 3 !== 1) {
        // Upfront full payment
        const upfrontPayment = await Payment.create({
          applicationId: application._id,
          studentId: student._id,
          amount: caPrice - discountAmount,
          type: 'upfront',
          paymentMethod: i % 2 === 0 ? 'square' : 'manual',
          status: 'completed',
          squareTransactionId: i % 2 === 0 ? `sq_txn_demo_${appCounter}_${Date.now()}` : undefined,
          manualPaymentReference: i % 2 !== 0 ? `BANK-REF-${appCounter}` : undefined,
          manualPaymentReason: i % 2 !== 0 ? 'Bank transfer received' : undefined,
          xeroSyncStatus: 'synced',
          authorizedBy: adminUser._id,
          createdAt: daysAgo(44 - i * 2),
        });

        await Application.findByIdAndUpdate(application._id, {
          $push: { paymentIds: { $each: [discountPayment._id, upfrontPayment._id] } },
        });
      } else {
        // Payment plan (for OnPlan status or every 3rd student)
        const netAmount = caPrice - discountAmount;
        const numInstallments = 4;
        const installmentAmount = Math.round(netAmount / numInstallments);

        const installments = [];
        const planPaymentIds = [discountPayment._id];

        for (let inst = 0; inst < numInstallments; inst++) {
          const dueDate = daysFromNow(-30 + inst * 14); // biweekly
          const isPaid = inst < 2; // first 2 paid

          const installment = {
            index: inst,
            amount: inst === numInstallments - 1
              ? netAmount - installmentAmount * (numInstallments - 1) // remainder
              : installmentAmount,
            dueDate,
            status: isPaid ? 'paid' : 'pending',
            paidAmount: isPaid ? installmentAmount : 0,
            paymentDate: isPaid ? daysAgo(30 - inst * 14) : undefined,
            paymentIds: [],
          };

          if (isPaid) {
            const planPayment = await Payment.create({
              applicationId: application._id,
              studentId: student._id,
              amount: installmentAmount,
              type: 'plan',
              paymentMethod: 'square',
              status: 'completed',
              installmentIndex: inst,
              squareTransactionId: `sq_plan_demo_${appCounter}_${inst}_${Date.now()}`,
              xeroSyncStatus: 'synced',
              createdAt: daysAgo(30 - inst * 14),
            });
            installment.paymentIds.push(planPayment._id);
            planPaymentIds.push(planPayment._id);
          }

          installments.push(installment);
        }

        const paymentPlan = await PaymentPlan.create({
          applicationId: application._id,
          studentId: student._id,
          totalAmount: netAmount,
          totalPaidAmount: installmentAmount * 2,
          installments,
          discountApplied: discountAmount,
          status: 'active',
          createdBy: adminUser._id,
          createdAt: daysAgo(44 - i * 2),
        });

        await Application.findByIdAndUpdate(application._id, {
          paymentPlanId: paymentPlan._id,
          $push: { paymentIds: { $each: planPaymentIds } },
        });
      }
    }

    // ---- Tasks ----
    if (statusIndex >= 2) {
      const tasks = [
        {
          title: `Follow up with ${student.firstName} ${student.lastName}`,
          description: `Contact student regarding RPL application for ${qualification.name}.`,
          scopeType: 'application',
          applicationId: application._id,
          studentId: student._id,
          status: statusIndex >= 4 ? 'done' : 'in_progress',
          priority: 'high',
          assignedTo: agentUser._id,
          createdBy: adminUser._id,
          dueDate: daysFromNow(statusIndex >= 4 ? -10 : 5),
          completedAt: statusIndex >= 4 ? daysAgo(10) : undefined,
          createdAt: daysAgo(50 - i * 2),
        },
      ];

      if (statusIndex >= 6) {
        tasks.push({
          title: `Review intake form — ${student.firstName} ${student.lastName}`,
          description: `Intake form submitted. Review for completeness before sending to admin.`,
          scopeType: 'application',
          applicationId: application._id,
          studentId: student._id,
          status: 'todo',
          priority: 'medium',
          assignedTo: adminUser._id,
          createdBy: agentUser._id,
          dueDate: daysFromNow(7),
          createdAt: daysAgo(30 - i),
        });
      }

      for (const t of tasks) {
        const task = await Task.create(t);
        await Application.findByIdAndUpdate(application._id, {
          $push: { tasks: task._id },
        });
      }
    }

    // ---- Update student applicationIds ----
    await Student.findByIdAndUpdate(student._id, {
      $addToSet: { applicationIds: application._id },
    });

    const stageLabel = `${status}`.padEnd(24);
    console.log(`    ${applicationId}  ${stageLabel}  ${student.firstName} ${student.lastName} — ${industry.name} / ${qualification.name.substring(0, 40)}`);
  }

  // ---- Tickets (create a few support tickets) ----
  console.log('\n  Creating support tickets...');

  const ticketData = [
    {
      ticketId: 'TKT10100',
      title: 'Cannot upload reference letter — file too large',
      description: 'I keep getting an error when trying to upload my reference letter. The file is a 15MB PDF scan.',
      type: 'issue',
      category: 'documents',
      priority: 'high',
      status: 'in_progress',
      source: 'student',
      requesterId: studentRecords[0].student._id,
      assignedTo: supportUser._id,
      applicationId: null, // will set after
      messages: [
        {
          content: 'I keep getting an error when trying to upload my reference letter. The file is a 15MB PDF scan.',
          senderId: studentRecords[0].student._id,
          senderRole: 'Student',
          createdAt: daysAgo(5),
        },
        {
          content: 'Hi Liam, the maximum file size is 10MB. Could you try compressing the PDF or scanning at a lower resolution?',
          senderId: supportUser._id,
          senderRole: 'Support',
          createdAt: daysAgo(4),
        },
        {
          content: 'Internal note: This is a common issue. We should consider increasing the file size limit.',
          senderId: supportUser._id,
          senderRole: 'Support',
          isInternal: true,
          createdAt: daysAgo(4),
        },
      ],
      firstResponseAt: daysAgo(4),
    },
    {
      ticketId: 'TKT10101',
      title: 'Payment not reflecting in my account',
      description: 'I made a bank transfer 3 days ago but my application still shows as unpaid.',
      type: 'issue',
      category: 'payments',
      priority: 'medium',
      status: 'waiting_on_customer',
      source: 'student',
      requesterId: studentRecords[2].student._id,
      assignedTo: supportUser._id,
      messages: [
        {
          content: 'I made a bank transfer 3 days ago but my application still shows as unpaid.',
          senderId: studentRecords[2].student._id,
          senderRole: 'Student',
          createdAt: daysAgo(3),
        },
        {
          content: 'Hi Noah, could you please provide the bank transfer reference number so we can locate your payment?',
          senderId: supportUser._id,
          senderRole: 'Support',
          createdAt: daysAgo(2),
        },
      ],
      firstResponseAt: daysAgo(2),
    },
    {
      ticketId: 'TKT10102',
      title: 'How long does RTO assessment take?',
      description: 'My documents were sent to the RTO 2 weeks ago. When can I expect a result?',
      type: 'query',
      category: 'rto_support',
      priority: 'low',
      status: 'resolved',
      source: 'student',
      requesterId: studentRecords[5].student._id,
      assignedTo: supportUser._id,
      messages: [
        {
          content: 'My documents were sent to the RTO 2 weeks ago. When can I expect a result?',
          senderId: studentRecords[5].student._id,
          senderRole: 'Student',
          createdAt: daysAgo(7),
        },
        {
          content: 'Hi Amelia, the RTO assessment typically takes up to 21 business days. Your application is currently under review and progressing well. We\'ll notify you as soon as there\'s an update.',
          senderId: supportUser._id,
          senderRole: 'Support',
          createdAt: daysAgo(6),
        },
      ],
      firstResponseAt: daysAgo(6),
      resolvedAt: daysAgo(6),
    },
    {
      ticketId: 'TKT10103',
      title: 'Request to change qualification',
      description: 'I initially signed up for Certificate III but I want to change to Diploma level. Is this possible?',
      type: 'query',
      category: 'general',
      priority: 'medium',
      status: 'open',
      source: 'student',
      requesterId: studentRecords[8].student._id,
      messages: [
        {
          content: 'I initially signed up for Certificate III but I want to change to Diploma level. Is this possible?',
          senderId: studentRecords[8].student._id,
          senderRole: 'Student',
          createdAt: daysAgo(1),
        },
      ],
    },
    {
      ticketId: 'TKT10104',
      title: 'Portal login issues after password change',
      description: 'Changed my password yesterday and now I cannot log in.',
      type: 'issue',
      category: 'technical',
      priority: 'urgent',
      status: 'closed',
      source: 'portal',
      requesterId: studentRecords[10].student._id,
      assignedTo: supportUser._id,
      messages: [
        {
          content: 'Changed my password yesterday and now I cannot log in.',
          senderId: studentRecords[10].student._id,
          senderRole: 'Student',
          createdAt: daysAgo(10),
        },
        {
          content: 'Hi James, I\'ve reset your account. Please try logging in again with the temporary password sent to your email.',
          senderId: supportUser._id,
          senderRole: 'Support',
          createdAt: daysAgo(10),
        },
        {
          content: 'That worked, thank you!',
          senderId: studentRecords[10].student._id,
          senderRole: 'Student',
          createdAt: daysAgo(9),
        },
      ],
      firstResponseAt: daysAgo(10),
      resolvedAt: daysAgo(9),
      closedAt: daysAgo(9),
    },
  ];

  for (const td of ticketData) {
    await Ticket.create(td);
    console.log(`    ${td.ticketId}  [${td.status.padEnd(20)}]  ${td.title}`);
  }

  // ---- Notifications ----
  console.log('\n  Creating notifications...');

  const notifications = [];

  // Notifications for agent
  notifications.push(
    { userId: agentUser._id, type: 'application_assigned', title: 'New Application Assigned', message: `Application APP10102 has been assigned to you. Student: ${studentRecords[2].firstName} ${studentRecords[2].lastName}.`, link: '/agent/applications', createdAt: daysAgo(20) },
    { userId: agentUser._id, type: 'application_assigned', title: 'New Application Assigned', message: `Application APP10103 has been assigned to you. Student: ${studentRecords[3].firstName} ${studentRecords[3].lastName}.`, link: '/agent/applications', createdAt: daysAgo(18) },
    { userId: agentUser._id, type: 'status_changed', title: 'Application Status Updated', message: `APP10104 status changed to Paid. Payment confirmed.`, link: '/agent/applications', read: true, createdAt: daysAgo(15) },
  );

  // Notifications for admin
  notifications.push(
    { userId: adminUser._id, type: 'payment_received', title: 'Payment Received', message: `Upfront payment of $3,000 received for APP10104.`, link: '/admin/payments', createdAt: daysAgo(14) },
    { userId: adminUser._id, type: 'payment_received', title: 'Payment Received', message: `Installment 1 of $750 received for APP10105 payment plan.`, link: '/admin/payments', createdAt: daysAgo(10) },
    { userId: adminUser._id, type: 'status_changed', title: 'Intake Form Submitted', message: `${studentRecords[6].firstName} ${studentRecords[6].lastName} submitted their intake form for APP10106.`, link: '/admin/applications', createdAt: daysAgo(8) },
  );

  // Notifications for support
  notifications.push(
    { userId: supportUser._id, type: 'ticket_update', title: 'New Ticket Created', message: `Ticket TKT10100: Cannot upload reference letter — file too large.`, link: '/support/tickets', createdAt: daysAgo(5) },
    { userId: supportUser._id, type: 'ticket_update', title: 'New Ticket Created', message: `Ticket TKT10101: Payment not reflecting in my account.`, link: '/support/tickets', createdAt: daysAgo(3) },
    { userId: supportUser._id, type: 'ticket_update', title: 'New Ticket Created', message: `Ticket TKT10103: Request to change qualification.`, link: '/support/tickets', createdAt: daysAgo(1) },
  );

  // Notifications for students
  for (let i = 0; i < Math.min(10, studentRecords.length); i++) {
    const sr = studentRecords[i];
    const statusIdx = APPLICATION_STAGES.indexOf(APPLICATION_STAGES[i % APPLICATION_STAGES.length]);
    notifications.push({
      userId: sr.student._id,
      type: 'status_changed',
      title: 'Application Status Updated',
      message: `Your application APP${10100 + i} status has been updated to ${APPLICATION_STAGES[i % APPLICATION_STAGES.length]}.`,
      link: '/student/applications',
      read: statusIdx < 5,
      createdAt: daysAgo(30 - i * 2),
    });
  }

  await Notification.insertMany(notifications);
  console.log(`    Created ${notifications.length} notifications\n`);

  // ---- Summary ----
  const totalApps = await Application.countDocuments();
  const totalStudents = await User.countDocuments({ role: 'Student' });
  const totalPayments = await Payment.countDocuments();
  const totalPlans = await PaymentPlan.countDocuments();
  const totalScreening = await ScreeningForm.countDocuments();
  const totalIntake = await IntakeForm.countDocuments();
  const totalTasks = await Task.countDocuments();
  const totalTickets = await Ticket.countDocuments();
  const totalNotifs = await Notification.countDocuments();

  console.log('  ======= SEED SUMMARY =======');
  console.log(`    Students:         ${totalStudents}`);
  console.log(`    Applications:     ${totalApps}`);
  console.log(`    Screening Forms:  ${totalScreening}`);
  console.log(`    Intake Forms:     ${totalIntake}`);
  console.log(`    Payments:         ${totalPayments}`);
  console.log(`    Payment Plans:    ${totalPlans}`);
  console.log(`    Tasks:            ${totalTasks}`);
  console.log(`    Tickets:          ${totalTickets}`);
  console.log(`    Notifications:    ${totalNotifs}`);
  console.log('  ============================\n');

  console.log('  Demo data seeding complete!');
  await mongoose.disconnect();
}

seedDemoData().catch((err) => {
  console.error('\n  FATAL:', err);
  process.exit(1);
});
