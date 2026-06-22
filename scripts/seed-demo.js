/**
 * Seed comprehensive demo data based on SYSTEM_FLOWS.md
 * Run: node scripts/seed-demo.js
 *
 * Creates:
 * - 6 staff users (admin, ceo, 2 agents, rto, support)
 * - 1 marketing user
 * - 8 student users with applications at various lifecycle stages
 * - Payments, discounts, call logs, tasks, tickets, notifications
 * - Marketing spend data
 * - Agent targets
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const mongoose = require('mongoose');

// Models
const User = require('../src/models/User');
const Student = require('../src/models/Student');
const Application = require('../src/models/Application');
const Payment = require('../src/models/Payment');
const PaymentPlan = require('../src/models/PaymentPlan');
const ScreeningForm = require('../src/models/ScreeningForm');
const IntakeForm = require('../src/models/IntakeForm');
const Industry = require('../src/models/Industry');
const Qualification = require('../src/models/Qualification');
const Task = require('../src/models/Task');
const Ticket = require('../src/models/Ticket');
const Notification = require('../src/models/Notification');
const CallLog = require('../src/models/CallLog');
const MarketingSpend = require('../src/models/MarketingSpend');
const AgentTarget = require('../src/models/AgentTarget');
const Certificate = require('../src/models/Certificate');
const KnowledgeBase = require('../src/models/KnowledgeBase');

// Helpers
const daysAgo = (n) => new Date(Date.now() - n * 24 * 60 * 60 * 1000);
const daysFromNow = (n) => new Date(Date.now() + n * 24 * 60 * 60 * 1000);
let appCounter = 10000;
const nextAppId = () => `APP${++appCounter}`;
let ticketCounter = 10000;
const nextTicketId = () => `TKT${++ticketCounter}`;

async function seed() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Connected to MongoDB\n');

  // ── Clean demo data (preserve catalog) ──
  console.log('Cleaning existing demo data...');
  await Promise.all([
    User.deleteMany({}),
    Student.deleteMany({}),
    Application.deleteMany({}),
    Payment.deleteMany({}),
    PaymentPlan.deleteMany({}),
    ScreeningForm.deleteMany({}),
    IntakeForm.deleteMany({}),
    Task.deleteMany({}),
    Ticket.deleteMany({}),
    Notification.deleteMany({}),
    CallLog.deleteMany({}),
    MarketingSpend.deleteMany({}),
    AgentTarget.deleteMany({}),
    Certificate.deleteMany({}),
    KnowledgeBase.deleteMany({}),
  ]);
  console.log('  Done\n');

  // ── Get catalog data ──
  const industries = await Industry.find().lean();
  const qualifications = await Qualification.find().lean();
  if (industries.length === 0 || qualifications.length === 0) {
    console.error('ERROR: No industries/qualifications found. Run `node scripts/seed.js` first.');
    process.exit(1);
  }
  console.log(`Found ${industries.length} industries, ${qualifications.length} qualifications\n`);

  // Pick some qualifications for demo
  const quals = qualifications.slice(0, 8);
  const getQual = (i) => quals[i % quals.length];

  // ═══════════════════════════════════════════
  // 1. STAFF USERS
  // ═══════════════════════════════════════════
  console.log('Creating staff users...');
  const admin = await User.create({
    email: 'admin@yopmail.com', password: 'Admin@1234',
    firstName: 'Sarah', lastName: 'Mitchell', phone: '+61400000001',
    role: 'Admin', status: 'active', emailVerified: true,
  });

  const ceo = await User.create({
    email: 'ceo@yopmail.com', password: 'Ceo@1234',
    firstName: 'Mostafa', lastName: 'Khan', phone: '+61400000002',
    role: 'CEOReportingManager', status: 'active', emailVerified: true,
  });

  const agent1 = await User.create({
    email: 'agent@yopmail.com', password: 'Agent@1234',
    firstName: 'Michael', lastName: 'Chen', phone: '+61400000003',
    role: 'Agent', status: 'active', emailVerified: true,
  });

  const agent2 = await User.create({
    email: 'agent2@yopmail.com', password: 'Agent@1234',
    firstName: 'Jessica', lastName: 'Park', phone: '+61400000006',
    role: 'Agent', status: 'active', emailVerified: true,
  });

  const rto = await User.create({
    email: 'rto@yopmail.com', password: 'Rto@1234',
    firstName: 'Emily', lastName: 'Davis', phone: '+61400000004',
    role: 'InternalRTO', status: 'active', emailVerified: true,
  });

  const support = await User.create({
    email: 'support@yopmail.com', password: 'Support@1234',
    firstName: 'David', lastName: 'Wilson', phone: '+61400000005',
    role: 'Support', status: 'active', emailVerified: true,
  });

  const marketing = await User.create({
    email: 'marketing@yopmail.com', password: 'Marketing@1234',
    firstName: 'Shahbaz', lastName: 'Ahmed', phone: '+61400000007',
    role: 'Marketing', status: 'active', emailVerified: true,
  });

  console.log('  Created: admin, ceo (Mostafa), agent1, agent2, rto, support, marketing\n');

  // ═══════════════════════════════════════════
  // 2. STUDENTS + APPLICATIONS (various stages)
  // ═══════════════════════════════════════════
  console.log('Creating students and applications...');

  const studentData = [
    { first: 'Asad', last: 'Rahman', email: 'asad@yopmail.com', source: 'meta', status: 'StudentIntakeForm', color: 'yellow', agent: agent1, daysOld: 3 },
    { first: 'Liam', last: 'O\'Brien', email: 'liam@yopmail.com', source: 'tiktok', status: 'UploadDocuments', color: 'orange', agent: agent1, daysOld: 7 },
    { first: 'Priya', last: 'Sharma', email: 'priya@yopmail.com', source: 'google', status: 'StudentCompleted', color: 'green', agent: agent2, daysOld: 14, rtoAssigned: true, timerDays: 10 },
    { first: 'Tom', last: 'Wilson', email: 'tom@yopmail.com', source: 'linkedin', status: 'SentToRTO', color: 'lightblue', agent: agent2, daysOld: 18, rtoAssigned: true, timerDays: 15 },
    { first: 'Sophie', last: 'Nguyen', email: 'sophie@yopmail.com', source: 'meta', status: 'RTOInvoiceUploaded', color: 'green', agent: agent1, daysOld: 30, rtoAssigned: true, timerStopped: true, timerDays: 19 },
    { first: 'Jake', last: 'Martin', email: 'jake@yopmail.com', source: 'referral', status: 'CertificateIssued', color: 'green', agent: agent2, daysOld: 45, rtoAssigned: true, timerStopped: true, timerDays: 18, hasCert: true },
    { first: 'Emma', last: 'Brown', email: 'emma@yopmail.com', source: 'tiktok', status: 'New', color: 'red', agent: null, daysOld: 1 },
    { first: 'Noah', last: 'Taylor', email: 'noah@yopmail.com', source: 'facebook', status: 'WaitingForVerification', color: 'lightblue', agent: agent1, daysOld: 22, rtoAssigned: true, timerDays: 20 },
  ];

  const students = [];
  const applications = [];

  for (let i = 0; i < studentData.length; i++) {
    const sd = studentData[i];
    const qual = getQual(i);

    const student = await Student.create({
      email: sd.email, password: 'Student@1234',
      firstName: sd.first, lastName: sd.last,
      phone: `+6140000${String(10 + i).padStart(4, '0')}`,
      role: 'Student', status: 'active', emailVerified: true,
      portalAccess: ['student'],
      sourceAttribution: { source: sd.source, timestamp: daysAgo(sd.daysOld) },
      signupDiscountApplied: true,
      consents: { termsOfServiceAccepted: true, acceptedAt: daysAgo(sd.daysOld) },
    });

    const appId = nextAppId();
    const appData = {
      applicationId: appId,
      studentId: student._id,
      industryId: qual.industryId,
      qualificationId: qual._id,
      status: sd.status,
      leadStatus: sd.status === 'New' ? 'new' : 'qualified',
      color: sd.color,
      assignedAgentId: sd.agent?._id,
      contactAttempts: Math.floor(Math.random() * 8) + 1,
      incomingCalls: Math.floor(Math.random() * 3),
      contactStatus: sd.agent ? 'Contacted' : '',
      lastContactedAt: sd.agent ? daysAgo(sd.daysOld - 1) : undefined,
      createdAt: daysAgo(sd.daysOld),
      // Discounts
      discounts: [{ amount: 500, note: 'Signup discount', createdAt: daysAgo(sd.daysOld) }],
    };

    // Timer fields
    if (sd.rtoAssigned) {
      appData.assignedRTOId = rto._id;
      appData.rtoAssignmentDate = daysAgo(sd.daysOld - 2);
    }
    if (sd.timerDays !== undefined) {
      appData.timerStartedAt = daysAgo(sd.timerDays);
      appData.studentCompletionDate = daysAgo(sd.timerDays);
    }
    if (sd.timerStopped) {
      appData.timerStoppedAt = daysAgo(sd.daysOld - sd.timerDays);
      appData.timerDaysElapsed = sd.timerDays;
    }

    const app = await Application.create(appData);

    // Screening form
    await ScreeningForm.create({
      applicationId: app._id,
      industryId: qual.industryId,
      qualificationId: qual._id,
      yearsOfExperience: ['1-2 years', '3-4 years', '5-9 years', '10+ years'][i % 4],
      experienceLocation: ['Australia', 'Overseas', 'Both'][i % 3],
      state: ['NSW', 'VIC', 'QLD', 'WA', 'SA', 'TAS'][i % 6],
      hasFormalQualifications: i % 2 === 0,
      status: 'submitted',
      submittedAt: daysAgo(sd.daysOld),
    });

    student.applicationIds = [app._id];
    await student.save({ validateBeforeSave: false });

    students.push(student);
    applications.push(app);
    console.log(`  ${sd.first} ${sd.last} — ${appId} — ${sd.status}`);
  }

  // ═══════════════════════════════════════════
  // 3. PAYMENTS
  // ═══════════════════════════════════════════
  console.log('\nCreating payments...');
  const paidStatuses = ['StudentIntakeForm', 'UploadDocuments', 'DocumentsUploaded', 'StudentCompleted', 'SentToRTO', 'WaitingForVerification', 'RTOInvoiceUploaded', 'CertificateGenerated', 'CertificateIssued'];

  for (let i = 0; i < applications.length; i++) {
    const app = applications[i];
    const qual = getQual(i);
    const sd = studentData[i];

    if (paidStatuses.includes(sd.status)) {
      const payment = await Payment.create({
        applicationId: app._id,
        studentId: students[i]._id,
        amount: qual.caPrice,
        type: 'upfront',
        paymentMethod: 'square',
        status: 'completed',
        notes: 'Upfront payment',
        createdAt: daysAgo(sd.daysOld - 1),
      });
      app.paymentIds = [payment._id];
      await app.save();
      console.log(`  ${sd.first}: $${qual.caPrice} upfront`);
    }

    // RTO payable for completed assessments
    if (sd.timerStopped) {
      const rtoCost = qual.rtoCosts?.[0]?.rtoCost || 1200;
      await Payment.create({
        applicationId: app._id,
        studentId: students[i]._id,
        amount: rtoCost,
        type: 'rtoPayable',
        paymentMethod: 'manual',
        status: 'pending',
        notes: `RTO payable for ${app.applicationId}`,
        createdAt: daysAgo(sd.daysOld - sd.timerDays),
      });
      console.log(`  ${sd.first}: $${rtoCost} RTO payable (pending)`);
    }
  }

  // Manual revenue entry from CEO
  await Payment.create({
    amount: 2500,
    type: 'manualMarkPaid',
    paymentMethod: 'manual',
    status: 'completed',
    manualPaymentReference: 'BT-REF-20260615',
    notes: 'Late bank transfer received',
    createdAt: daysAgo(5),
  });
  console.log('  CEO manual revenue: $2,500');

  // ═══════════════════════════════════════════
  // 4. CALL LOGS
  // ═══════════════════════════════════════════
  console.log('\nCreating call logs...');
  const outcomes = ['answered', 'not_answered', 'converted', 'follow_up_required', 'progressed', 'no_action'];

  for (let i = 0; i < applications.length; i++) {
    if (!studentData[i].agent) continue;
    const numCalls = Math.floor(Math.random() * 5) + 1;
    for (let c = 0; c < numCalls; c++) {
      await CallLog.create({
        applicationId: applications[i]._id,
        agentId: studentData[i].agent._id,
        direction: c === 0 ? 'outbound' : Math.random() > 0.7 ? 'inbound' : 'outbound',
        outcome: outcomes[Math.floor(Math.random() * outcomes.length)],
        notes: c === 0 ? 'Initial contact call' : '',
        createdAt: daysAgo(studentData[i].daysOld - c),
      });
    }
  }
  const totalCalls = await CallLog.countDocuments();
  console.log(`  Created ${totalCalls} call logs`);

  // ═══════════════════════════════════════════
  // 5. TASKS
  // ═══════════════════════════════════════════
  console.log('\nCreating tasks...');
  const tasks = [
    { title: 'Follow up with Asad on intake form', status: 'todo', priority: 'high', assignedTo: agent1._id, applicationId: applications[0]._id, dueDate: daysFromNow(2) },
    { title: 'Review Liam\'s uploaded documents', status: 'in_progress', priority: 'medium', assignedTo: agent1._id, applicationId: applications[1]._id, dueDate: daysFromNow(1) },
    { title: 'Send Priya\'s application to RTO', status: 'todo', priority: 'high', assignedTo: admin._id, applicationId: applications[2]._id, dueDate: daysFromNow(3) },
    { title: 'Check Tom\'s RTO assessment progress', status: 'in_progress', priority: 'medium', assignedTo: agent2._id, applicationId: applications[3]._id, dueDate: daysFromNow(5) },
    { title: 'Upload Sophie\'s certificate', status: 'todo', priority: 'high', assignedTo: admin._id, applicationId: applications[4]._id, dueDate: daysFromNow(1) },
    { title: 'Post Jake\'s hard copy certificate', status: 'done', priority: 'low', assignedTo: admin._id, applicationId: applications[5]._id, dueDate: daysAgo(2) },
    { title: 'Contact Emma — new lead', status: 'todo', priority: 'high', assignedTo: agent1._id, applicationId: applications[6]._id, dueDate: daysFromNow(1) },
    { title: 'Weekly agent performance review', status: 'todo', priority: 'medium', assignedTo: ceo._id, dueDate: daysFromNow(4) },
    { title: 'Reconcile Xero payments', status: 'todo', priority: 'low', assignedTo: admin._id, dueDate: daysFromNow(7) },
    { title: 'Update marketing CPA for TikTok', status: 'done', priority: 'low', assignedTo: marketing._id, dueDate: daysAgo(1) },
  ];

  for (const t of tasks) {
    await Task.create({ ...t, createdBy: admin._id, createdAt: daysAgo(3) });
  }
  console.log(`  Created ${tasks.length} tasks`);

  // ═══════════════════════════════════════════
  // 6. TICKETS
  // ═══════════════════════════════════════════
  console.log('\nCreating tickets...');
  const tickets = [
    { title: 'Can\'t upload my documents', desc: 'I get an error when trying to upload my passport photo.', student: students[0], status: 'open', priority: 'high', type: 'issue' },
    { title: 'Payment plan question', desc: 'Can I split my payment into 3 installments?', student: students[1], status: 'in_progress', priority: 'medium', type: 'query' },
    { title: 'Reference letter template', desc: 'Where can I find the reference letter template?', student: students[2], status: 'resolved', priority: 'low', type: 'query' },
    { title: 'Certificate not showing', desc: 'My certificate was issued but I can\'t see it in the portal.', student: students[5], status: 'open', priority: 'urgent', type: 'issue' },
  ];

  for (const t of tickets) {
    await Ticket.create({
      ticketId: nextTicketId(),
      title: t.title,
      description: t.desc,
      type: t.type,
      category: 'general',
      priority: t.priority,
      status: t.status,
      source: 'student',
      requesterId: t.student._id,
      messages: [{
        content: t.desc,
        senderId: t.student._id,
        senderRole: 'requester',
        createdAt: daysAgo(2),
      }],
      createdAt: daysAgo(2),
    });
  }
  console.log(`  Created ${tickets.length} tickets`);

  // ═══════════════════════════════════════════
  // 7. NOTIFICATIONS
  // ═══════════════════════════════════════════
  console.log('\nCreating notifications...');
  const notifs = [
    { userId: agent1._id, type: 'application_assigned', title: 'Application Assigned', message: `You've been assigned to review APP10001 for Asad Rahman.`, link: '/admin/applications' },
    { userId: agent1._id, type: 'task_assigned', title: 'New Task: Follow up with Asad', message: 'Sarah Mitchell assigned you a task (Asad Rahman — intake form)', link: '/admin/tasks' },
    { userId: admin._id, type: 'status_changed', title: 'Status: Student Completed', message: 'Priya Sharma has completed all student obligations.', link: '/admin/applications' },
    { userId: rto._id, type: 'application_assigned', title: 'Application Assigned for Review', message: `You've been assigned APP10004 for Tom Wilson.`, link: '/rto/applications' },
    { userId: students[0]._id, type: 'status_changed', title: 'Application Update', message: 'Your application status has been updated to Student Intake Form.', link: '/student/application' },
    { userId: students[5]._id, type: 'certificate_issued', title: 'Certificate Issued', message: 'Your certificate has been issued and is ready for download!', link: '/student/certificates' },
    { userId: support._id, type: 'ticket_update', title: 'New Ticket', message: 'Asad Rahman raised a new support ticket: Can\'t upload my documents', link: '/support/tickets' },
    { userId: agent2._id, type: 'task_assigned', title: 'New Task: Check Tom\'s progress', message: 'Sarah Mitchell assigned you a task (Tom Wilson — RTO assessment)', link: '/admin/tasks' },
  ];

  for (const n of notifs) {
    await Notification.create({ ...n, createdAt: daysAgo(1) });
  }
  // Some read, some unread
  const allNotifs = await Notification.find();
  for (let i = 0; i < allNotifs.length; i++) {
    if (i % 3 === 0) {
      allNotifs[i].read = true;
      await allNotifs[i].save();
    }
  }
  console.log(`  Created ${notifs.length} notifications`);

  // ═══════════════════════════════════════════
  // 8. CERTIFICATE (for Jake)
  // ═══════════════════════════════════════════
  console.log('\nCreating certificate...');
  const cert = await Certificate.create({
    applicationId: applications[5]._id,
    studentId: students[5]._id,
    issuedBy: admin._id,
    certificateLink: 'https://drive.google.com/file/d/demo-cert-link',
    trackingNumber: 'AP123456789AU',
    trackingLink: 'https://auspost.com.au/mypost/track/#/details/AP123456789AU',
    status: 'in_delivery',
    softCopyUploadedAt: daysAgo(5),
    softCopyEmailSentAt: daysAgo(5),
    hardCopyDispatchedAt: daysAgo(2),
    hardCopyEmailSentAt: daysAgo(2),
    hardCopySentKPI: true,
    issuedAt: daysAgo(5),
    dispatchedAt: daysAgo(2),
  });
  applications[5].certificateId = cert._id;
  await applications[5].save();
  console.log(`  Jake Martin — cert issued, tracking: AP123456789AU`);

  // ═══════════════════════════════════════════
  // 9. MARKETING SPEND
  // ═══════════════════════════════════════════
  console.log('\nCreating marketing spend...');
  const platforms = ['tiktok', 'meta', 'facebook', 'instagram', 'google', 'linkedin'];
  const weeks = [daysAgo(28), daysAgo(21), daysAgo(14), daysAgo(7), new Date()];

  for (const weekOf of weeks) {
    for (const platform of platforms) {
      await MarketingSpend.create({
        platform,
        amount: Math.floor(Math.random() * 2000) + 500,
        weekOf,
        createdBy: marketing._id,
      });
    }
  }
  console.log(`  Created ${platforms.length * weeks.length} marketing spend entries`);

  // ═══════════════════════════════════════════
  // 10. AGENT TARGETS
  // ═══════════════════════════════════════════
  console.log('\nCreating agent targets...');
  const weekStart = new Date();
  weekStart.setDate(weekStart.getDate() - weekStart.getDay() + 1);
  weekStart.setHours(0, 0, 0, 0);

  for (const agent of [agent1, agent2]) {
    await AgentTarget.create({
      agentId: agent._id,
      period: 'weekly',
      periodStart: weekStart,
      revenueTarget: 20000,
      paidAppsTarget: 5,
      callsTarget: 30,
      conversionTarget: 25,
      setBy: ceo._id,
    });
  }
  console.log('  Created weekly targets for agent1 + agent2');

  // ═══════════════════════════════════════════
  // 11. KNOWLEDGE BASE (chatbot)
  // ═══════════════════════════════════════════
  console.log('\nSeeding knowledge base...');
  const kbEntries = [
    { category: 'general', question: 'What is RPL?', answer: 'RPL (Recognised Prior Learning) is a process that assesses your existing skills and knowledge against the requirements of a nationally recognised qualification.', tags: ['rpl', 'qualification'], priority: 10 },
    { category: 'general', question: 'How long does the process take?', answer: 'The RPL process typically takes 4-8 weeks. The 21-day assessment window begins once your application is complete and assigned to an RTO.', tags: ['timeline', 'duration'], priority: 10 },
    { category: 'documents', question: 'What documents do I need?', answer: 'You need: 1) Identity documents (100+ points of ID), 2) Educational documents (USI transcript), 3) Employment documents (resume, references, payslips), 4) Visual evidence for trade qualifications.', tags: ['documents', 'upload'], priority: 10 },
    { category: 'payments', question: 'How do I pay?', answer: 'Go to the Payments section. You can pay upfront via card, or ask the admin to set up a payment plan. A $500 signup discount is automatically applied.', tags: ['payment', 'pay'], priority: 10 },
    { category: 'certificates', question: 'When will I get my certificate?', answer: 'After RTO assessment, you\'ll receive a digital copy via email first. A hard copy will be posted via Australia Post with tracking.', tags: ['certificate', 'delivery'], priority: 10 },
    { category: 'support', question: 'How do I get help?', answer: 'Use the Support page to raise a ticket, or chat with me here. If I can\'t answer, I\'ll create a ticket for you.', tags: ['support', 'help'], priority: 10 },
  ];
  await KnowledgeBase.insertMany(kbEntries);
  console.log(`  Created ${kbEntries.length} knowledge base entries`);

  // ═══════════════════════════════════════════
  // SUMMARY
  // ═══════════════════════════════════════════
  console.log('\n════════════════════════════════════════');
  console.log('  DEMO SEED COMPLETE');
  console.log('════════════════════════════════════════');
  console.log(`  Staff: admin, ceo (Mostafa), agent1, agent2, rto, support, marketing`);
  console.log(`  Students: ${students.length} (various lifecycle stages)`);
  console.log(`  Applications: ${applications.length}`);
  console.log(`  Payments: ${await Payment.countDocuments()}`);
  console.log(`  Call Logs: ${totalCalls}`);
  console.log(`  Tasks: ${tasks.length}`);
  console.log(`  Tickets: ${tickets.length}`);
  console.log(`  Notifications: ${notifs.length}`);
  console.log(`  Marketing Spend: ${platforms.length * weeks.length}`);
  console.log('');
  console.log('  Login credentials (all @yopmail.com):');
  console.log('  ├── admin / Admin@1234');
  console.log('  ├── ceo / Ceo@1234');
  console.log('  ├── agent / Agent@1234');
  console.log('  ├── agent2 / Agent@1234');
  console.log('  ├── rto / Rto@1234');
  console.log('  ├── support / Support@1234');
  console.log('  ├── marketing / Marketing@1234');
  console.log('  └── asad/liam/priya/tom/sophie/jake/emma/noah / Student@1234');
  console.log('════════════════════════════════════════\n');

  await mongoose.disconnect();
}

seed().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
