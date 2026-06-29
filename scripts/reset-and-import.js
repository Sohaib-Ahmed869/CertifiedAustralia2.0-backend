/**
 * Reset database and import live industries/qualifications.
 *
 * - Deletes ALL data collections (applications, payments, documents, etc.)
 * - Deletes Student users (keeps Admin, Agent, CEO, RTO, Support users)
 * - Clears and re-imports industries + qualifications from the live export JSON
 *
 * Usage:  node scripts/reset-and-import.js
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
const Mailbox = require('../src/models/Mailbox');
const EmailTemplate = require('../src/models/EmailTemplate');
const CallLog = require('../src/models/CallLog');
const AgentTarget = require('../src/models/AgentTarget');
const CompetencyBooking = require('../src/models/CompetencyBooking');
const DynamicForm = require('../src/models/DynamicForm');
const FormSubmission = require('../src/models/FormSubmission');
const CalendarConnection = require('../src/models/CalendarConnection');
const Expense = require('../src/models/Expense');
const ExpenseLedger = require('../src/models/ExpenseLedger');
const CashflowConfig = require('../src/models/CashflowConfig');
const CashflowWeek = require('../src/models/CashflowWeek');
const MarketingSpend = require('../src/models/MarketingSpend');
const RTOInvoice = require('../src/models/RTOInvoice');
const PaymentBatch = require('../src/models/PaymentBatch');
const XeroConnection = require('../src/models/XeroConnection');
const KnowledgeBase = require('../src/models/KnowledgeBase');
const Checklist = require('../src/models/Checklist');
const ReferenceLetterTemplate = require('../src/models/ReferenceLetterTemplate');
const Industry = require('../src/models/Industry');
const Qualification = require('../src/models/Qualification');

// Import data
const liveData = require(path.join(__dirname, '..', '..', 'industry and qualifications', 'industries_and_qualifications.json'));

async function run() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Connected to MongoDB\n');

  // ── Step 1: Delete all data collections ──
  const dataModels = [
    ['Applications', Application],
    ['Payments', Payment],
    ['PaymentPlans', PaymentPlan],
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
    ['Mailboxes', Mailbox],
    ['EmailTemplates', EmailTemplate],
    ['CallLogs', CallLog],
    ['AgentTargets', AgentTarget],
    ['CompetencyBookings', CompetencyBooking],
    ['DynamicForms', DynamicForm],
    ['FormSubmissions', FormSubmission],
    ['CalendarConnections', CalendarConnection],
    ['Expenses', Expense],
    ['ExpenseLedger', ExpenseLedger],
    ['CashflowConfig', CashflowConfig],
    ['CashflowWeeks', CashflowWeek],
    ['MarketingSpend', MarketingSpend],
    ['RTOInvoices', RTOInvoice],
    ['PaymentBatches', PaymentBatch],
    ['XeroConnections', XeroConnection],
    ['KnowledgeBase', KnowledgeBase],
    ['Checklists', Checklist],
    ['ReferenceLetterTemplates', ReferenceLetterTemplate],
  ];

  console.log('── Clearing data collections ──');
  for (const [label, Model] of dataModels) {
    const { deletedCount } = await Model.deleteMany({});
    if (deletedCount > 0) console.log(`  ${label}: ${deletedCount} deleted`);
  }

  // ── Step 2: Delete Student users ──
  const { deletedCount: studentCount } = await User.deleteMany({ role: 'Student' });
  console.log(`\n── Deleted ${studentCount} Student user(s) ──`);

  // Show remaining users
  const remaining = await User.find({}).select('name email role').lean();
  console.log(`── ${remaining.length} user(s) kept ──`);
  remaining.forEach((u) => console.log(`  ${(u.role || '').padEnd(22)} ${(u.name || u.firstName || '').padEnd(20)} ${u.email}`));

  // ── Step 3: Clear and re-import industries + qualifications ──
  await Qualification.deleteMany({});
  await Industry.deleteMany({});
  console.log('\n── Importing live industries & qualifications ──');

  let totalQuals = 0;

  for (const ind of liveData.industries) {
    const industry = await Industry.create({
      name: ind.name,
      description: ind.description || '',
      status: 'active',
    });

    for (const q of ind.qualifications) {
      // Parse RTO costs — handle pipe-separated names and slash-separated costs
      const rtoCosts = [];
      if (q.rto && q.rtoCost) {
        const names = q.rto.split('|').map((n) => n.trim()).filter(Boolean);
        const costs = String(q.rtoCost).split('/').map((c) => parseInt(c.replace(/,/g, '').trim()) || 0);
        names.forEach((name, i) => {
          if (costs[i] || costs[0]) {
            rtoCosts.push({ rtoName: name, rtoCost: costs[i] || costs[0] });
          }
        });
      }

      // Use parsedPrice if available, otherwise parse the price string
      const caPrice = q.parsedPrice
        ? parseInt(String(q.parsedPrice).replace(/,/g, ''))
        : parseInt(String(q.price).replace(/,/g, '')) || 0;

      await Qualification.create({
        name: q.qualification,
        industryId: industry._id,
        caPrice,
        rtoCosts,
        status: 'active',
      });
      totalQuals++;
    }

    console.log(`  ${ind.name}: ${ind.qualifications.length} qualification(s)`);
  }

  // Handle orphaned qualifications (no industry match)
  if (liveData.orphaned?.length) {
    console.log(`\n  ⚠ ${liveData.orphaned.length} orphaned qualification(s) skipped (no industry match)`);
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
