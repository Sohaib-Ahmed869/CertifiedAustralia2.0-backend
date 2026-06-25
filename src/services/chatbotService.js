/**
 * Chatbot Service — Progress-aware student support bot
 *
 * Architecture (inspired by old project v1):
 *   1. LLM intent classification (gpt-4o-mini, fast + cheap)
 *   2. Deterministic handlers for known intents (no LLM cost)
 *   3. LLM fallback with KB context injection for general questions
 *   4. Escalation to support ticket when unresolved
 */

const KnowledgeBase = require('../models/KnowledgeBase');
const Application = require('../models/Application');
const Payment = require('../models/Payment');
const ticketService = require('./ticketService');
const buildCrud = require('./commonCrud');

const knowledgeCrud = buildCrud(KnowledgeBase, {});

// ---------------------------------------------------------------------------
// Intent classification
// ---------------------------------------------------------------------------

const INTENTS = [
  'NEXT_STEP', 'APP_STATUS', 'DOCS_NEEDED', 'DOCS_PENDING',
  'CERTIFICATE', 'PAYMENT', 'HUMAN_SUPPORT', 'REFERENCE_LETTER',
  'GENERAL',
];

/**
 * Classify the student's intent using a fast LLM call.
 * Falls back to regex-based detection if OpenAI is unavailable.
 */
const classifyIntent = async (message) => {
  const lower = message.toLowerCase();

  // Regex fallback patterns
  if (/\b(next step|what.*(do|should).*(next|now)|what.*(need|remaining))\b/i.test(message)) return 'NEXT_STEP';
  if (/\b(status|where.*(is|are)|progress|stage|application.*(status|stage))\b/i.test(message)) return 'APP_STATUS';
  if (/\b(what.*document|which.*document|document.*need|what.*upload|required.*document)\b/i.test(message)) return 'DOCS_NEEDED';
  if (/\b(pending.*document|missing.*document|outstanding|incomplete|remaining.*upload)\b/i.test(message)) return 'DOCS_PENDING';
  if (/\b(certificate|cert.*download|cert.*track|cert.*delivery|auspost)\b/i.test(message)) return 'CERTIFICATE';
  if (/\b(pay|payment|plan|instalment|installment|invoice|receipt|refund|how.*much|cost|price|fee)\b/i.test(message)) return 'PAYMENT';
  if (/\b(speak.*human|talk.*agent|real.*person|support.*ticket|contact.*support|help.*agent)\b/i.test(message)) return 'HUMAN_SUPPORT';
  if (/\b(reference.*letter|referee|reference.*template|supporting.*template)\b/i.test(message)) return 'REFERENCE_LETTER';

  // Try LLM classification if available
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return 'GENERAL';

  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        max_tokens: 5,
        temperature: 0,
        messages: [
          {
            role: 'system',
            content: `Classify the student's message into exactly one intent. Reply with ONLY the intent name.
Intents: ${INTENTS.join(', ')}`,
          },
          { role: 'user', content: message },
        ],
      }),
    });
    if (!res.ok) return 'GENERAL';
    const data = await res.json();
    const intent = (data.choices?.[0]?.message?.content || '').trim().toUpperCase();
    return INTENTS.includes(intent) ? intent : 'GENERAL';
  } catch {
    return 'GENERAL';
  }
};

// ---------------------------------------------------------------------------
// Application context
// ---------------------------------------------------------------------------

/**
 * Get the student's current application context for chatbot responses.
 */
const getApplicationContext = async (studentId, applicationId) => {
  const query = applicationId
    ? { _id: applicationId, studentId }
    : { studentId };

  const app = await Application.findOne(query)
    .sort('-createdAt')
    .populate('qualificationId', 'name code')
    .lean();

  if (!app) return null;

  // Get payment info
  const payments = await Payment.find({ applicationId: app._id, status: 'completed' })
    .select('amount type createdAt')
    .lean();

  const totalPaid = payments
    .filter((p) => ['upfront', 'plan', 'manualMarkPaid'].includes(p.type))
    .reduce((sum, p) => sum + (p.amount || 0), 0);

  return {
    applicationId: app.applicationId,
    status: app.status,
    qualificationName: app.qualificationId?.name || 'Unknown',
    qualificationCode: app.qualificationId?.code || '',
    totalPaid,
    intakeFormSubmitted: !!app.intakeFormId,
    documentsUploaded: (app.documentIds || []).length,
    hasCertificate: !!app.certificateId,
    hasAdditionalDocRequests: (app.additionalDocRequests || []).some((r) => r.status === 'open'),
    rtoAssigned: !!app.assignedRTOId,
    feedbackRequested: (app.resubmissionRequests || []).some((r) => r.status === 'pending'),
  };
};

/**
 * List all applications for a student (for multi-app disambiguation).
 */
const listStudentApps = async (studentId) => {
  const apps = await Application.find({ studentId })
    .select('applicationId status qualificationId')
    .populate('qualificationId', 'name')
    .sort('-createdAt')
    .lean();

  return apps.map((a) => ({
    _id: a._id,
    applicationId: a.applicationId,
    status: a.status,
    qualificationName: a.qualificationId?.name || 'Unknown',
  }));
};

// ---------------------------------------------------------------------------
// Deterministic intent handlers
// ---------------------------------------------------------------------------

const STATUS_DESCRIPTIONS = {
  LeadCaptured: 'Your application has been created. An agent will be assigned to you shortly.',
  ScreeningCompleted: 'Your screening form has been submitted. Please proceed with payment.',
  AgentAssigned: 'A sales agent has been assigned to your application. They will contact you soon.',
  PaymentPending: 'Your application is waiting for payment. Please complete your payment to proceed.',
  PaymentCompleted: 'Payment received! Please fill in your intake form next.',
  IntakeFormCompleted: 'Intake form submitted. Please upload your required documents.',
  DocumentsUploaded: 'Documents uploaded. The admin team will review your submission.',
  SubmissionReview: 'Your submission is under admin review. You may be asked to resubmit specific documents.',
  ResubmissionRequired: 'Some documents need to be resubmitted. Check your notifications for details.',
  SentToRTO: 'Your application has been sent to the RTO (Registered Training Organisation) for assessment.',
  RTOReview: 'The RTO is currently reviewing your application and evidence.',
  RTOFeedback: 'The RTO has provided feedback on your application. Check with admin for details.',
  RTOCompleted: 'The RTO has completed their assessment. Your certificate will be processed soon.',
  CertificateIssued: 'Your certificate has been issued! Check the Certificates section to download it.',
  InDelivery: 'Your hard-copy certificate has been dispatched. Check your email for tracking details.',
  Delivered: 'Your certificate has been delivered. Congratulations!',
  Archived: 'This application has been archived.',
};

const handleAppStatus = (ctx) => {
  const desc = STATUS_DESCRIPTIONS[ctx.status] || `Your application status is: ${ctx.status}`;
  return `**${ctx.qualificationName}** (${ctx.applicationId})\n\nStatus: **${ctx.status}**\n\n${desc}`;
};

const handleNextStep = (ctx) => {
  if (ctx.hasCertificate) {
    return `Great news! Your certificate for **${ctx.qualificationName}** has been issued. You can download it from the Certificates section of your portal.`;
  }

  const steps = [];

  if (['LeadCaptured', 'ScreeningCompleted', 'AgentAssigned'].includes(ctx.status)) {
    if (ctx.totalPaid === 0) steps.push('Complete your **payment** — go to the Payments section');
  }

  if (['PaymentPending'].includes(ctx.status)) {
    steps.push('Complete your **payment** to proceed');
  }

  if (['PaymentCompleted'].includes(ctx.status)) {
    if (!ctx.intakeFormSubmitted) steps.push('Fill in your **intake form** — find it in the Documents section');
    else steps.push('Upload your **required documents**');
  }

  if (['IntakeFormCompleted'].includes(ctx.status)) {
    if (ctx.documentsUploaded === 0) steps.push('Upload your **required documents** — ID, employment, references, and evidence');
    else steps.push('Continue uploading any **remaining documents**');
  }

  if (ctx.feedbackRequested) {
    steps.push('You have **resubmission requests** — check your notifications for which documents need attention');
  }

  if (ctx.hasAdditionalDocRequests) {
    steps.push('You have **additional documents** requested — check the Documents page for the upload section');
  }

  if (['DocumentsUploaded', 'SubmissionReview'].includes(ctx.status)) {
    steps.push('Your documents are **under review** — no action needed from you right now. We\'ll notify you if anything is needed.');
  }

  if (['SentToRTO', 'RTOReview'].includes(ctx.status)) {
    steps.push('Your application is **with the RTO** for assessment. We\'ll update you once they\'ve reviewed it.');
  }

  if (['RTOCompleted', 'CertificateIssued'].includes(ctx.status)) {
    steps.push('Your certificate is being **processed**. You\'ll receive a notification when it\'s ready to download.');
  }

  if (steps.length === 0) {
    return `Your application for **${ctx.qualificationName}** is at the **${ctx.status}** stage. No specific action is needed right now — we'll notify you when something requires your attention.`;
  }

  return `Here's what to do next for **${ctx.qualificationName}** (${ctx.applicationId}):\n\n${steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}`;
};

const handlePayment = (ctx) => {
  if (ctx.totalPaid > 0) {
    return `For **${ctx.qualificationName}** (${ctx.applicationId}), you've paid **$${ctx.totalPaid.toLocaleString('en-AU')}** so far.\n\nTo view your payment details, plan, or make another payment, go to the **Payments** section in your portal.`;
  }
  return `No payments have been recorded yet for **${ctx.qualificationName}** (${ctx.applicationId}).\n\nYou can make a payment through the **Payments** section. We accept online payments and payment plans.`;
};

const handleCertificate = (ctx) => {
  if (ctx.hasCertificate) {
    return `Your certificate for **${ctx.qualificationName}** has been issued! Go to the **Certificates** section to download it. If a hard copy has been dispatched, check your email for Australia Post tracking details.`;
  }
  if (['RTOCompleted'].includes(ctx.status)) {
    return `Your RTO assessment is complete. Your certificate is being prepared — you'll receive a notification when it's available to download.`;
  }
  return `Your certificate for **${ctx.qualificationName}** hasn't been issued yet. Your application is currently at the **${ctx.status}** stage. We'll notify you as soon as it's ready.`;
};

const handleDocsNeeded = (ctx) => {
  const docs = [
    '**Identity Documents** (100+ points required) — Driver\'s Licence, Passport, Birth Certificate, Medicare Card, etc.',
    '**Educational Documents** — USI VET Transcript, USI Portal Screenshot, Previous Qualifications',
    '**Employment Evidence** — Resume, Employment Letter, References (x2), Payslips/Invoices (3+)',
  ];

  let response = `For your **${ctx.qualificationName}** application, you'll need:\n\n${docs.map((d, i) => `${i + 1}. ${d}`).join('\n')}\n\n`;

  response += 'Some qualifications also require visual evidence (photos and videos of your work). Check the Documents page for your specific requirements.';

  if (ctx.hasAdditionalDocRequests) {
    response += '\n\n⚠️ You also have **additional documents** requested by admin. Check the Documents page for the specific items needed.';
  }

  return response;
};

const handleDocsPending = (ctx) => {
  if (ctx.documentsUploaded === 0) {
    return `You haven't uploaded any documents yet for **${ctx.qualificationName}**. Go to the **Documents** section to start uploading.`;
  }

  let response = `You've uploaded **${ctx.documentsUploaded}** document(s) so far for **${ctx.qualificationName}**.`;

  if (ctx.feedbackRequested) {
    response += '\n\n⚠️ Some documents need **resubmission** — check your notifications for details.';
  }
  if (ctx.hasAdditionalDocRequests) {
    response += '\n\n⚠️ Additional documents have been **requested** — check the Documents page.';
  }
  if (!ctx.feedbackRequested && !ctx.hasAdditionalDocRequests) {
    response += '\n\nCheck the Documents page to see if any required items are still missing.';
  }

  return response;
};

const handleReferenceLetter = () => {
  return "You can request a reference letter template from the admin team. Look for the info icon near the document upload area on your Documents page, or contact the admin team directly. If you need help filling it in, our team is happy to guide you.\n\nYou'll need **two references** — these should be from employers or supervisors who can verify your work experience.";
};

const handleHumanSupport = () => {
  return null; // Signal to frontend to show support button
};

// ---------------------------------------------------------------------------
// KB context retrieval
// ---------------------------------------------------------------------------

/**
 * Fetch relevant knowledge base entries for a query.
 * Uses MongoDB text search with priority and stage-aware sorting.
 */
const getKBContext = async (message, applicationStage) => {
  let entries = [];
  try {
    entries = await KnowledgeBase.find(
      { $text: { $search: message } },
      { score: { $meta: 'textScore' } }
    )
      .sort({ score: { $meta: 'textScore' }, priority: -1 })
      .limit(5)
      .lean();
  } catch {
    // Text index may not exist yet
  }

  // Prefer stage-specific entries
  if (applicationStage && entries.length > 1) {
    const stageSpecific = entries.filter((e) => e.applicationStage === applicationStage);
    if (stageSpecific.length > 0) {
      entries = [...stageSpecific, ...entries.filter((e) => e.applicationStage !== applicationStage)];
    }
  }

  return entries.slice(0, 5);
};

// ---------------------------------------------------------------------------
// LLM answer generation (fallback for GENERAL intent)
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT_TEMPLATE = `You are the Certified Australia support assistant. You help students with their RPL (Recognised Prior Learning) applications.

Your role:
- Answer questions about the application process, document uploads, payments, certificates, and support.
- Be friendly, concise, and helpful. Use markdown formatting for clarity.
- If you don't know the answer, say so and suggest creating a support ticket.
- Never make up information about specific application statuses or payment amounts.
- Keep responses under 200 words.

Portal navigation guide:
- Dashboard: overview of application status and next steps
- Documents: upload ID, employment, education, and evidence documents
- Payments: view payment status, make payments, see payment plan details
- Certificates: download issued certificates, view delivery tracking
- Support: create support tickets, view existing tickets
- Calendar: view scheduled meetings and follow-up calls
- Inbox: view notifications and updates

Important Certified Australia information:
- RPL = Recognised Prior Learning — formal recognition of skills gained through work experience
- Students need 100+ points from ID documents (e.g., Passport 70pts, Driver's Licence 40pts, Medicare 25pts)
- The 21-day completion window is a KPI for RTO assessment, not a hard deadline
- All qualifications are nationally recognised through Australian RTOs
- The portal is AUD-only
- Certificate delivery includes a soft-copy download and optional hard-copy via Australia Post

{CONTEXT_BLOCK}`;

const generateLLMAnswer = async (message, chatHistory, kbEntries, appContext) => {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;

  let contextBlock = '';
  if (kbEntries.length > 0) {
    contextBlock += `\nRelevant knowledge base entries:\n${kbEntries.map((e) => `Q: ${e.question}\nA: ${e.answer}`).join('\n\n')}\n`;
  }
  if (appContext) {
    contextBlock += `\nStudent's application: ${appContext.qualificationName} (${appContext.applicationId}), Status: ${appContext.status}, Documents uploaded: ${appContext.documentsUploaded}, Total paid: $${appContext.totalPaid}`;
  }

  const systemPrompt = SYSTEM_PROMPT_TEMPLATE.replace('{CONTEXT_BLOCK}', contextBlock);

  // Build message history (last 8 messages for context)
  const messages = [{ role: 'system', content: systemPrompt }];
  if (chatHistory?.length > 0) {
    const recent = chatHistory.slice(-8);
    for (const msg of recent) {
      messages.push({
        role: msg.role === 'user' ? 'user' : 'assistant',
        content: msg.text || msg.content || '',
      });
    }
  }
  messages.push({ role: 'user', content: message });

  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        max_tokens: 400,
        temperature: 0.4,
        messages,
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.choices?.[0]?.message?.content || null;
  } catch {
    return null;
  }
};

// ---------------------------------------------------------------------------
// Main answer function
// ---------------------------------------------------------------------------

/**
 * Answer a student question with intent routing.
 * @param {Object} params - { studentId, message, applicationId?, chatHistory? }
 * @returns {Object} - { answer, matched, source, relatedQuestions, suggestEscalation, meta }
 */
const getAnswer = async ({ studentId, message, applicationId, chatHistory }) => {
  if (!message || message.trim().length < 3) {
    return { answer: "Could you tell me more about what you need help with?", matched: false };
  }

  // Step 1: Classify intent
  const intent = await classifyIntent(message);

  // Step 2: Handle human support request immediately
  if (intent === 'HUMAN_SUPPORT') {
    return {
      answer: "I understand you'd like to speak with our support team. Click the button below to create a support ticket, and our team will get back to you shortly.",
      matched: true,
      suggestEscalation: true,
      meta: { showSupportButton: true },
    };
  }

  // Step 3: Get application context for app-specific intents
  const appSpecificIntents = ['NEXT_STEP', 'APP_STATUS', 'DOCS_NEEDED', 'DOCS_PENDING', 'CERTIFICATE', 'PAYMENT'];
  let appContext = null;

  if (appSpecificIntents.includes(intent) && studentId) {
    // Check if student has multiple apps
    const apps = await listStudentApps(studentId);

    if (apps.length > 1 && !applicationId) {
      // Return app selection prompt
      return {
        answer: "You have multiple applications. Which one are you asking about?",
        matched: true,
        source: 'system',
        meta: {
          needsApplicationSelection: true,
          applications: apps,
        },
      };
    }

    appContext = await getApplicationContext(studentId, applicationId);
  }

  // Step 4: Deterministic handlers for known intents
  if (appContext) {
    let deterministicAnswer = null;

    switch (intent) {
      case 'APP_STATUS':
        deterministicAnswer = handleAppStatus(appContext);
        break;
      case 'NEXT_STEP':
        deterministicAnswer = handleNextStep(appContext);
        break;
      case 'PAYMENT':
        deterministicAnswer = handlePayment(appContext);
        break;
      case 'CERTIFICATE':
        deterministicAnswer = handleCertificate(appContext);
        break;
      case 'DOCS_NEEDED':
        deterministicAnswer = handleDocsNeeded(appContext);
        break;
      case 'DOCS_PENDING':
        deterministicAnswer = handleDocsPending(appContext);
        break;
    }

    if (deterministicAnswer) {
      return {
        answer: deterministicAnswer,
        matched: true,
        source: 'deterministic',
        intent,
      };
    }
  }

  // Step 5: Reference letter handler (no app context needed)
  if (intent === 'REFERENCE_LETTER') {
    return {
      answer: handleReferenceLetter(),
      matched: true,
      source: 'deterministic',
      intent,
    };
  }

  // Step 6: Get KB context and try LLM for general questions
  if (!appContext && studentId) {
    appContext = await getApplicationContext(studentId, applicationId);
  }
  const kbEntries = await getKBContext(message, appContext?.status);

  const aiAnswer = await generateLLMAnswer(message, chatHistory, kbEntries, appContext);

  if (aiAnswer) {
    return {
      answer: aiAnswer,
      matched: true,
      source: 'ai',
      intent,
      relatedQuestions: kbEntries.slice(0, 3).map((e) => e.question).filter(Boolean),
    };
  }

  // Step 7: KB text search fallback
  if (kbEntries.length > 0) {
    return {
      answer: kbEntries[0].answer,
      category: kbEntries[0].category,
      matched: true,
      source: 'knowledge_base',
      relatedQuestions: kbEntries.slice(1, 4).map((e) => e.question),
    };
  }

  // Step 8: No match — suggest escalation
  return {
    answer: "I'm sorry, I couldn't find an answer to your question. Would you like me to create a support ticket so our team can help you?",
    matched: false,
    suggestEscalation: true,
  };
};

// ---------------------------------------------------------------------------
// Escalation
// ---------------------------------------------------------------------------

const escalateToTicket = async ({ studentId, chatTranscript, subject }) => {
  const ticket = await ticketService.createTicket({
    requesterId: studentId,
    title: subject || 'Chatbot Escalation',
    description: 'Escalated from chatbot — student question could not be resolved automatically.',
    type: 'query',
    category: 'general',
    priority: 'medium',
    source: 'chatbot',
    chatbotTranscript: (chatTranscript || []).map((line) => ({
      role: typeof line === 'string' ? (line.startsWith('Student') ? 'student' : 'bot') : (line.role || 'bot'),
      content: typeof line === 'string' ? line : (line.text || line.content || String(line)),
    })),
  });

  return ticket;
};

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  knowledge: knowledgeCrud,
  getAnswer,
  escalateToTicket,
};
