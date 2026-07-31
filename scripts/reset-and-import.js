/**
 * Reset student/transactional data and import live industries + qualifications.
 *
 * WHAT IT DELETES (transactional data):
 *   Applications, payments, payment plans, documents, certificates, intake and
 *   screening forms, tasks, tickets, notifications, chat, call logs, competency
 *   bookings, form submissions, finance records — and all Student users.
 *
 * WHAT IT KEEPS:
 *   Admin / Agent / CEO / RTO / Support users, and (unless --wipe-config is passed)
 *   configuration: email templates, mailboxes, knowledge base, checklists,
 *   reference letter templates, dynamic forms, Xero/calendar connections,
 *   agent targets, cashflow config.
 *
 * Industries and qualifications are always cleared and re-imported from
 * scripts/data/industries_and_qualifications.json (exported from the legacy
 * Firebase portal).
 *
 * Usage:
 *   node scripts/reset-and-import.js                 # dry run — reports, deletes nothing
 *   node scripts/reset-and-import.js --confirm       # actually performs the reset
 *   node scripts/reset-and-import.js --confirm --wipe-config
 *                                                    # also clears configuration collections
 *
 * This is destructive and irreversible. Take a mongodump before running with --confirm.
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const path = require('path');
const mongoose = require('mongoose');

// Models
const User = require('../src/models/User');
const Application = require('../src/models/Application');
const Payment = require('../src/models/Payment');
const PaymentPlan = require('../src/models/PaymentPlan');
const Document = require('../src/models/Document');
const DocumentFeedback = require('../src/models/DocumentFeedback');
const Certificate = require('../src/models/Certificate');
const IntakeForm = require('../src/models/IntakeForm');
const ScreeningForm = require('../src/models/ScreeningForm');
const Task = require('../src/models/Task');
const Ticket = require('../src/models/Ticket');
const Notification = require('../src/models/Notification');
const Conversation = require('../src/models/Conversation');
const Message = require('../src/models/Message');
const ChatPresence = require('../src/models/ChatPresence');
const Campaign = require('../src/models/Campaign');
const CampaignRecipient = require('../src/models/CampaignRecipient');
const Sequence = require('../src/models/Sequence');
const SequenceEnrollment = require('../src/models/SequenceEnrollment');
const SequenceRecipient = require('../src/models/SequenceRecipient');
const CallLog = require('../src/models/CallLog');
const CallEvent = require('../src/models/CallEvent');
const CallBurst = require('../src/models/CallBurst');
const CompetencyBooking = require('../src/models/CompetencyBooking');
const FormSubmission = require('../src/models/FormSubmission');
const ThirdPartyFormAccess = require('../src/models/ThirdPartyFormAccess');
const DirectDebitAuthority = require('../src/models/DirectDebitAuthority');
const OtpVerification = require('../src/models/OtpVerification');
const Expense = require('../src/models/Expense');
const ExpenseLedger = require('../src/models/ExpenseLedger');
const CashflowWeek = require('../src/models/CashflowWeek');
const MarketingSpend = require('../src/models/MarketingSpend');
const RTOInvoice = require('../src/models/RTOInvoice');
const PaymentBatch = require('../src/models/PaymentBatch');

// Configuration models — preserved unless --wipe-config
const Mailbox = require('../src/models/Mailbox');
const EmailTemplate = require('../src/models/EmailTemplate');
const KnowledgeBase = require('../src/models/KnowledgeBase');
const Checklist = require('../src/models/Checklist');
const ReferenceLetterTemplate = require('../src/models/ReferenceLetterTemplate');
const DynamicForm = require('../src/models/DynamicForm');
const CalendarConnection = require('../src/models/CalendarConnection');
const XeroConnection = require('../src/models/XeroConnection');
const AgentTarget = require('../src/models/AgentTarget');
const CashflowConfig = require('../src/models/CashflowConfig');

const Industry = require('../src/models/Industry');
const Qualification = require('../src/models/Qualification');

const DATA_FILE = path.join(__dirname, 'data', 'industries_and_qualifications.json');
const liveData = require(DATA_FILE);

const CONFIRM = process.argv.includes('--confirm');
const WIPE_CONFIG = process.argv.includes('--wipe-config');

// Transactional collections — always cleared.
const TRANSACTIONAL = [
  ['Applications', Application],
  ['Payments', Payment],
  ['PaymentPlans', PaymentPlan],
  ['PaymentBatches', PaymentBatch],
  ['Documents', Document],
  ['DocumentFeedback', DocumentFeedback],
  ['Certificates', Certificate],
  ['IntakeForms', IntakeForm],
  ['ScreeningForms', ScreeningForm],
  ['Tasks', Task],
  ['Tickets', Ticket],
  ['Notifications', Notification],
  ['Conversations', Conversation],
  ['Messages', Message],
  ['ChatPresence', ChatPresence],
  ['Campaigns', Campaign],
  ['CampaignRecipients', CampaignRecipient],
  ['Sequences', Sequence],
  ['SequenceEnrollments', SequenceEnrollment],
  ['SequenceRecipients', SequenceRecipient],
  ['CallLogs', CallLog],
  ['CallEvents', CallEvent],
  ['CallBursts', CallBurst],
  ['CompetencyBookings', CompetencyBooking],
  ['FormSubmissions', FormSubmission],
  ['ThirdPartyFormAccess', ThirdPartyFormAccess],
  ['DirectDebitAuthorities', DirectDebitAuthority],
  ['OtpVerifications', OtpVerification],
  ['Expenses', Expense],
  ['ExpenseLedger', ExpenseLedger],
  ['CashflowWeeks', CashflowWeek],
  ['MarketingSpend', MarketingSpend],
  ['RTOInvoices', RTOInvoice],
];

// Configuration collections — cleared only with --wipe-config.
const CONFIG = [
  ['Mailboxes', Mailbox],
  ['EmailTemplates', EmailTemplate],
  ['KnowledgeBase', KnowledgeBase],
  ['Checklists', Checklist],
  ['ReferenceLetterTemplates', ReferenceLetterTemplate],
  ['DynamicForms', DynamicForm],
  ['CalendarConnections', CalendarConnection],
  ['XeroConnections', XeroConnection],
  ['AgentTargets', AgentTarget],
  ['CashflowConfig', CashflowConfig],
];

// The legacy portal renders `price` (see PriceBook/page.jsx and changeQualification.jsx).
// `parsedPrice` is a separate bulk-updated field that differs on most records
// (e.g. price 4499 vs parsedPrice 4500), so `price` is the authoritative figure.
const parseMoney = (value) => {
  const n = parseInt(String(value ?? '').replace(/[^0-9.]/g, ''), 10);
  return Number.isNaN(n) ? 0 : n;
};

const parseRtoCosts = (q) => {
  const rtoCosts = [];
  if (!q.rto || !q.rtoCost) return rtoCosts;

  const names = String(q.rto).split('|').map((n) => n.trim()).filter(Boolean);
  const costs = String(q.rtoCost).split('/').map((c) => parseMoney(c));

  names.forEach((rtoName, i) => {
    const rtoCost = costs[i] ?? costs[0];
    if (rtoCost) rtoCosts.push({ rtoName, rtoCost });
  });

  return rtoCosts;
};

async function run() {
  if (!process.env.MONGODB_URI) {
    console.error('MONGODB_URI is not set. Add it to .env before running.');
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGODB_URI);
  const { host, name } = mongoose.connection;
  console.log(`Connected to MongoDB — db "${name}" on ${host}\n`);

  if (!CONFIRM) {
    console.log('DRY RUN — nothing will be deleted. Re-run with --confirm to apply.\n');
  }

  // ── Step 1: transactional collections ──
  console.log('── Transactional data ──');
  for (const [label, Model] of TRANSACTIONAL) {
    const count = await Model.countDocuments({});
    if (count === 0) continue;
    if (CONFIRM) {
      const { deletedCount } = await Model.deleteMany({});
      console.log(`  ${label.padEnd(26)} ${deletedCount} deleted`);
    } else {
      console.log(`  ${label.padEnd(26)} ${count} would be deleted`);
    }
  }

  // ── Step 2: configuration collections ──
  console.log(`\n── Configuration ${WIPE_CONFIG ? '(clearing — --wipe-config)' : '(preserved)'} ──`);
  for (const [label, Model] of CONFIG) {
    const count = await Model.countDocuments({});
    if (count === 0) continue;
    if (WIPE_CONFIG && CONFIRM) {
      const { deletedCount } = await Model.deleteMany({});
      console.log(`  ${label.padEnd(26)} ${deletedCount} deleted`);
    } else if (WIPE_CONFIG) {
      console.log(`  ${label.padEnd(26)} ${count} would be deleted`);
    } else {
      console.log(`  ${label.padEnd(26)} ${count} kept`);
    }
  }

  // ── Step 3: Student users ──
  const studentQuery = { role: 'Student' };
  const studentCount = await User.countDocuments(studentQuery);
  if (CONFIRM) {
    const { deletedCount } = await User.deleteMany(studentQuery);
    console.log(`\n── Deleted ${deletedCount} Student user(s) ──`);
  } else {
    console.log(`\n── ${studentCount} Student user(s) would be deleted ──`);
  }

  const remaining = await User.find(CONFIRM ? {} : { role: { $ne: 'Student' } })
    .select('firstName lastName email role')
    .lean();
  console.log(`── ${remaining.length} user(s) kept ──`);
  remaining.forEach((u) =>
    console.log(`  ${(u.role || '').padEnd(10)} ${`${u.firstName || ''} ${u.lastName || ''}`.trim().padEnd(24)} ${u.email}`)
  );

  // ── Step 4: industries + qualifications ──
  console.log(`\n── Industries & qualifications (source: ${path.basename(DATA_FILE)}, exported ${liveData.exportedAt}) ──`);

  if (!CONFIRM) {
    const existingInd = await Industry.countDocuments({});
    const existingQual = await Qualification.countDocuments({});
    let wouldImport = 0;
    for (const ind of liveData.industries) {
      wouldImport += ind.qualifications.length;
      console.log(`  ${(ind.name || '').padEnd(42)} ${ind.qualifications.length} qual(s)`);
    }
    console.log(`\n  Currently in DB : ${existingInd} industries, ${existingQual} qualifications`);
    console.log(`  Would replace with: ${liveData.industries.length} industries, ${wouldImport} qualifications`);
    if (liveData.orphaned?.length) {
      console.log(`  ${liveData.orphaned.length} orphaned qualification(s) would be skipped (no industry):`);
      liveData.orphaned.forEach((q) => console.log(`    - ${q.qualification}`));
    }
    await mongoose.disconnect();
    console.log('\nDry run complete. No changes made.');
    process.exit(0);
  }

  await Qualification.deleteMany({});
  await Industry.deleteMany({});

  let totalQuals = 0;
  for (const ind of liveData.industries) {
    const industry = await Industry.create({
      name: ind.name,
      description: ind.description || '',
      status: 'active',
    });

    for (const q of ind.qualifications) {
      await Qualification.create({
        name: q.qualification,
        industryId: industry._id,
        caPrice: parseMoney(q.price),
        rtoCosts: parseRtoCosts(q),
        status: 'active',
      });
      totalQuals++;
    }

    console.log(`  ${(ind.name || '').padEnd(42)} ${ind.qualifications.length} qual(s)`);
  }

  if (liveData.orphaned?.length) {
    console.log(`\n  ${liveData.orphaned.length} orphaned qualification(s) skipped (no matching industry):`);
    liveData.orphaned.forEach((q) => console.log(`    - ${q.qualification}`));
  }

  console.log(`\n── Done: ${liveData.industries.length} industries, ${totalQuals} qualifications imported ──`);

  await mongoose.disconnect();
  process.exit(0);
}

run().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
