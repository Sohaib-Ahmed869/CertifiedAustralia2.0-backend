/**
 * Seed the chatbot knowledge base with common Q&A entries.
 * Run: node scripts/seed-knowledge.js
 */
require('dotenv').config();
const mongoose = require('mongoose');
const KnowledgeBase = require('../src/models/KnowledgeBase');

const ENTRIES = [
  // General
  { category: 'general', question: 'What is RPL?', answer: 'RPL (Recognised Prior Learning) is a process that assesses your existing skills and knowledge against the requirements of a nationally recognised qualification. It means you can get qualified based on what you already know and can do, without repeating training.', tags: ['rpl', 'recognised prior learning', 'qualification'], priority: 10 },
  { category: 'general', question: 'How long does the RPL process take?', answer: 'The RPL process typically takes 4-8 weeks from start to finish, depending on how quickly you submit your documents and the RTO assessment turnaround. The 21-day assessment window begins once your application is complete and assigned to an RTO.', tags: ['timeline', 'how long', 'duration', 'process'], priority: 10 },
  { category: 'general', question: 'What qualifications are available?', answer: 'We offer RPL assessments across trades (carpentry, plumbing, electrical, etc.), fitness, and other industries. Browse the full catalogue on our website or contact us for details on specific qualifications.', tags: ['qualifications', 'courses', 'available', 'trades'], priority: 8 },

  // Application
  { category: 'application', question: 'How do I check my application status?', answer: 'You can check your application status from your student portal dashboard. Click on "Application" in the sidebar to see your current stage, from initial submission through to certificate delivery.', tags: ['status', 'check', 'progress', 'application'], applicationStage: null, priority: 10 },
  { category: 'application', question: 'What happens after I submit my application?', answer: 'After submission, our admin team will review your documents. If everything is in order, your application will be sent to an RTO (Registered Training Organisation) for assessment. You\'ll be notified at each stage via the portal and email.', tags: ['after submit', 'next steps', 'what happens'], priority: 9 },

  // Documents
  { category: 'documents', question: 'What documents do I need to upload?', answer: 'You\'ll need to upload: 1) Identity documents (passport, driver\'s licence, etc. — at least 100 points of ID), 2) Educational documents (USI VET transcript, previous qualifications), 3) Employment documents (resume, employment letters, references, payslips), and 4) Visual evidence for trade qualifications (photos/videos of your work).', tags: ['documents', 'upload', 'required', 'what do i need'], applicationStage: 'UploadDocuments', priority: 10 },
  { category: 'documents', question: 'What is a White Card?', answer: 'A White Card (also called General Construction Induction Card) is required for all trade qualifications. It proves you\'ve completed safety induction training for construction work. You can upload your White Card in the Educational Documents section.', tags: ['white card', 'construction', 'trade'], priority: 8 },
  { category: 'documents', question: 'How do I get a reference letter template?', answer: 'You can request a reference letter template by clicking the info icon near the document upload area on your Documents page. The admin team will send you the appropriate template by email. If you need further help, contact us through the support page.', tags: ['reference letter', 'template', 'referee'], priority: 10 },
  { category: 'documents', question: 'What file types can I upload?', answer: 'You can upload images (JPG, PNG), PDFs, Word documents, and videos. Images have a 40MB limit and videos have a 5GB limit. Make sure your files are clear and readable.', tags: ['file types', 'format', 'upload', 'size limit'], priority: 7 },

  // Payments
  { category: 'payments', question: 'How do I make a payment?', answer: 'Go to the Payments section in your student portal. You can pay the full amount upfront via card, or ask the admin team to set up a payment plan with installments. Contact us if you need help with payment options.', tags: ['payment', 'pay', 'how to pay', 'card'], applicationStage: 'WaitingForPayment', priority: 10 },
  { category: 'payments', question: 'Do you offer payment plans?', answer: 'Yes! We offer flexible payment plans that split your total into manageable installments. Contact our team to set up a payment plan that works for you. A $500 signup discount is automatically applied to your first application.', tags: ['payment plan', 'installments', 'split', 'discount'], priority: 9 },
  { category: 'payments', question: 'What is the $500 signup discount?', answer: 'Every new student receives an automatic $500 discount on their first application. This is applied at signup and you\'ll see it reflected in your payment total on the Payments page.', tags: ['discount', 'signup', '$500'], priority: 8 },

  // Certificates
  { category: 'certificates', question: 'When will I receive my certificate?', answer: 'After your RTO assessment is complete, you\'ll first receive a digital (soft copy) certificate via email and in your portal. A hard copy will then be posted to you via Australia Post — you\'ll receive a tracking number by email once it\'s dispatched.', tags: ['certificate', 'when', 'receive', 'delivery'], applicationStage: 'CertificateIssued', priority: 10 },
  { category: 'certificates', question: 'How do I track my certificate delivery?', answer: 'Once your hard-copy certificate is posted, you\'ll receive an email with an Australia Post tracking number and link. You can also check the tracking status in the Certificates section of your student portal.', tags: ['track', 'delivery', 'auspost', 'tracking'], priority: 9 },

  // Support
  { category: 'support', question: 'How do I contact support?', answer: 'You can raise a support ticket from the Support page in your student portal, or chat with me here! If I can\'t answer your question, I\'ll create a ticket for you and our team will get back to you.', tags: ['contact', 'support', 'help', 'ticket'], priority: 10 },
  { category: 'support', question: 'How long does support take to respond?', answer: 'Our support team aims to respond within 24 hours during business days. Urgent issues are prioritised. You can check the status of your tickets in the Support section of your portal.', tags: ['response time', 'how long', 'support', 'wait'], priority: 7 },
];

(async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('Connected to MongoDB');

    // Clear existing entries
    const existing = await KnowledgeBase.countDocuments();
    if (existing > 0) {
      console.log(`Found ${existing} existing entries — clearing...`);
      await KnowledgeBase.deleteMany({});
    }

    // Insert new entries
    await KnowledgeBase.insertMany(ENTRIES);
    console.log(`Seeded ${ENTRIES.length} knowledge base entries`);

    // Verify text index
    const indexes = await KnowledgeBase.collection.indexes();
    const hasTextIndex = indexes.some((idx) => Object.values(idx.key || {}).includes('text'));
    console.log('Text index exists:', hasTextIndex);
    if (!hasTextIndex) {
      console.log('Creating text index...');
      await KnowledgeBase.collection.createIndex({ question: 'text', answer: 'text', tags: 'text' });
      console.log('Text index created');
    }

    console.log('\nDone! Knowledge base is ready.');
  } catch (err) {
    console.error('Error:', err.message);
  } finally {
    await mongoose.disconnect();
  }
})();
