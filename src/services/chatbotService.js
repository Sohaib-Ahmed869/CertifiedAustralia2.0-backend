/**
 * Chatbot Service — Progress-aware student support bot
 *
 * Architecture (ported from old project v1):
 *   1. LLM intent classification (gpt-4o-mini, fast + cheap)
 *   2. Deterministic handlers for known intents (no LLM cost)
 *   3. LLM fallback with KB context injection for general questions (gpt-4o)
 *   4. Escalation to support ticket when unresolved
 */

const KnowledgeBase = require('../models/KnowledgeBase');
const Application = require('../models/Application');
const Payment = require('../models/Payment');
const PaymentPlan = require('../models/PaymentPlan');
const Checklist = require('../models/Checklist');
const Student = require('../models/Student');
const IntakeForm = require('../models/IntakeForm');
const ticketService = require('./ticketService');
const buildCrud = require('./commonCrud');

const knowledgeCrud = buildCrud(KnowledgeBase, {});

// ---------------------------------------------------------------------------
// Intent classification
// ---------------------------------------------------------------------------

const INTENTS = [
  'NEXT_STEP', 'APP_STATUS', 'DOCS_NEEDED', 'DOCS_PENDING',
  'CERTIFICATE', 'PAYMENT', 'HUMAN_SUPPORT', 'REFERENCE_LETTER',
  'USI', 'CANCELLATION', 'GENERAL',
];

/**
 * Classify the student's intent using regex first, then fast LLM fallback.
 */
const classifyIntent = async (message) => {
  // Regex patterns — ORDER MATTERS: more specific patterns first
  // CANCELLATION must precede PAYMENT ("cancel my payment plan", "refund") and
  // USI must precede DOCS_NEEDED ("USI transcript document") — both are narrower.
  if (/\b(cancel|cancelling|canceling|cancellation|withdraw|withdrawal|terminate|discontinue|opt.?out|back.?out|pull.?out|quit)\b/i.test(message)
    || /\b(stop|end|close).{0,20}\b(payment|plan|subscription|direct.?debit|application|enrol|enroll|course|membership|account)/i.test(message)
    || /\b(no longer|don'?t|do not).{0,15}\b(want|wish|need).{0,25}\b(continue|proceed|application|course|qualification|enrol|enroll)/i.test(message)) return 'CANCELLATION';
  if (/\busi\b|\bunique student identifier\b/i.test(message)) return 'USI';
  // Document-related intents must come before NEXT_STEP to avoid "what do I need" matching NEXT_STEP
  if (/\b(what.*document|which.*document|document.*need|what.*upload|required.*document|checklist|evidence.*need|what.*do.*i.*need.*upload|what.*need.*submit)\b/i.test(message)) return 'DOCS_NEEDED';
  if (/\b(pending.*document|missing.*document|outstanding|incomplete|remaining.*upload|what.*uploaded|upload.*status|have.*i.*uploaded)\b/i.test(message)) return 'DOCS_PENDING';
  if (/\b(reference.*letter|referee|reference.*template|supporting.*template)\b/i.test(message)) return 'REFERENCE_LETTER';
  if (/\b(certificate|cert.*download|cert.*track|cert.*delivery|auspost|tracking|hard.*copy)\b/i.test(message)) return 'CERTIFICATE';
  if (/\b(pay|payment|plan|instalment|installment|invoice|receipt|refund|how.*much|cost|price|fee|balance|owe|remaining.*pay)\b/i.test(message)) return 'PAYMENT';
  if (/\b(speak.*human|talk.*agent|real.*person|support.*ticket|contact.*support|help.*agent|call.*someone|escalat)\b/i.test(message)) return 'HUMAN_SUPPORT';
  if (/\b(next step|what.*(do|should).*(next|now)|how.*start|what.*first|what.*do.*next)\b/i.test(message)) return 'NEXT_STEP';
  if (/\b(status|where.*(is|are)|progress|stage|application.*(status|stage)|how.*going)\b/i.test(message)) return 'APP_STATUS';

  // Try LLM classification
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
            content: `Classify the student's message into exactly one intent. Reply with ONLY the intent name.\nIntents: ${INTENTS.join(', ')}`,
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
// Application context (enriched — mirrors old project)
// ---------------------------------------------------------------------------

const getApplicationContext = async (studentId, applicationId) => {
  const query = applicationId
    ? { _id: applicationId, studentId }
    : { studentId };

  const app = await Application.findOne(query)
    .sort('-createdAt')
    .populate('qualificationId', 'name code caPrice')
    .populate('industryId', 'name')
    .lean();

  if (!app) return null;

  // Get payment info
  const payments = await Payment.find({ applicationId: app._id, status: 'completed' })
    .select('amount type createdAt')
    .lean();

  const totalPaid = payments
    .filter((p) => ['upfront', 'plan', 'manualMarkPaid'].includes(p.type))
    .reduce((sum, p) => sum + (p.amount || 0), 0);

  // Discounts live on the application (signup discount written at registration plus any
  // added by an admin). Legacy records may also carry a Payment row of type 'discount',
  // so both are counted.
  const applicationDiscount = (app.discounts || [])
    .reduce((sum, d) => sum + (d.amount || 0), 0);

  const paymentDiscount = payments
    .filter((p) => p.type === 'discount')
    .reduce((sum, p) => sum + Math.abs(p.amount || 0), 0);

  const discountAmount = applicationDiscount + paymentDiscount;

  const price = app.qualificationId?.caPrice || 0;
  const remaining = Math.max(0, price - discountAmount - totalPaid);

  // Get payment plan info
  let paymentPlan = null;
  if (app.paymentPlanId) {
    paymentPlan = await PaymentPlan.findById(app.paymentPlanId).lean();
  }

  // Additional doc requests
  const additionalDocRequests = (app.additionalDocRequests || []).filter((r) => r.status === 'open');

  // Resubmission / feedback requested
  const feedbackRequested = (app.resubmissionRequests || []).some((r) => r.status === 'pending');

  return {
    applicationId: app.applicationId,
    status: app.status,
    qualificationName: app.qualificationId?.name || 'Unknown',
    qualificationCode: app.qualificationId?.code || '',
    industryName: app.industryId?.name || '',
    price,
    totalPaid,
    discountAmount,
    remaining,
    paymentCompleted: !!app.paymentCompleted,
    partialPayment: !!app.partialPayment,
    intakeFormSubmitted: app.intakeFormSubmitted || !!app.intakeFormId,
    documentsUploaded: app.documentsUploaded === true,
    documentCount: (app.documentIds || []).length,
    hasCertificate: !!app.certificateId,
    hasAdditionalDocRequests: additionalDocRequests.length > 0,
    additionalDocRequests: additionalDocRequests.map((r) => ({
      items: r.items || [],
      deadline: r.deadline,
      status: r.status,
    })),
    rtoAssigned: !!app.assignedRTOId,
    feedbackRequested,
    // Payment plan details
    hasPlan: !!paymentPlan,
    planStatus: paymentPlan?.status || null,
    planInstallments: paymentPlan?.installments?.length || 0,
    planCompleted: paymentPlan?.installments?.filter((i) => i.status === 'paid').length || 0,
    planNextDue: paymentPlan?.installments?.find((i) => i.status === 'pending') || null,
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
// Deterministic intent handlers (rich — mirrors old project)
// ---------------------------------------------------------------------------

const STATUS_DESCRIPTIONS = {
  LeadCaptured: 'Your application has been created. An agent will be assigned to you shortly.',
  ScreeningCompleted: 'Your screening form has been submitted. Please proceed with payment.',
  AgentAssigned: 'A sales agent has been assigned to your application. They will contact you soon.',
  New: 'Your application has been created. Please proceed with payment when ready.',
  WaitingForPayment: 'Your application is waiting for payment. Please complete your payment to proceed.',
  PaymentPending: 'Your application is waiting for payment. Please complete your payment to proceed.',
  StudentIntakeForm: 'Please complete your Student Intake Form to continue.',
  PaymentCompleted: 'Payment received! Please fill in your intake form next.',
  IntakeFormCompleted: 'Intake form submitted. Please upload your required documents.',
  UploadDocuments: 'Please upload your required documents — ID verification, employment evidence, and references.',
  DocumentsUploaded: 'Documents uploaded. The admin team will review your submission.',
  SubmissionReview: 'Your submission is under admin review. You may be asked to resubmit specific documents.',
  ResubmissionRequired: 'Some documents need to be resubmitted. Check your notifications for details.',
  SentToRTO: 'Your application has been sent to the RTO (Registered Training Organisation) for assessment.',
  RTOReview: 'The RTO is currently reviewing your application and evidence.',
  RTOFeedback: 'The RTO has provided feedback on your application. Check with admin for details.',
  RTOCompleted: 'The RTO has completed their assessment. Your certificate will be processed soon.',
  RTOInvoiceUploaded: 'The RTO assessment is complete and invoicing is in progress. Your certificate is being prepared.',
  StudentCompleted: 'All student obligations are complete. Your application is being processed.',
  CertificateGenerated: 'Your certificate has been generated and is ready for review.',
  CertificateIssued: 'Your certificate has been issued! Check the Certificates section to download it.',
  InDelivery: 'Your hard-copy certificate has been dispatched. Check your email for Australia Post tracking details.',
  Delivered: 'Your certificate has been delivered. Congratulations!',
  Archived: 'This application has been archived.',
};

const handleAppStatus = (ctx) => {
  const desc = STATUS_DESCRIPTIONS[ctx.status] || `Your application status is: ${ctx.status}`;
  let response = `**${ctx.qualificationName}** (${ctx.applicationId})\n\nStatus: **${ctx.status}**\n\n${desc}`;

  // Add obligation summary
  response += '\n\n**Your progress:**';
  response += `\n- Payment: ${ctx.paymentCompleted ? '✅ Completed' : ctx.totalPaid > 0 ? `⏳ $${ctx.totalPaid.toLocaleString('en-AU')} of $${ctx.price.toLocaleString('en-AU')} paid` : '❌ Not yet paid'}`;
  response += `\n- Intake Form: ${ctx.intakeFormSubmitted ? '✅ Submitted' : '❌ Not yet submitted'}`;
  response += `\n- Documents: ${ctx.documentsUploaded ? '✅ Uploaded' : ctx.documentCount > 0 ? `⏳ ${ctx.documentCount} file(s) uploaded — not yet submitted` : '❌ Not yet uploaded'}`;

  return response;
};

const handleNextStep = (ctx) => {
  if (ctx.hasCertificate) {
    return `Great news! Your certificate for **${ctx.qualificationName}** has been issued. You can download it from the **Certificates** section of your portal.`;
  }

  // Feedback / resubmission takes priority
  if (ctx.feedbackRequested) {
    return `Our team has reviewed your application for **${ctx.qualificationName}** and has requested some changes.\n\nPlease check your **notifications** or **email** for details on which documents need attention, then go to **Documents** to re-upload them.\n\nIf you're not sure what's needed, you can ask me "what documents are pending?" or create a support ticket.`;
  }

  // Additional doc requests
  if (ctx.hasAdditionalDocRequests) {
    const items = ctx.additionalDocRequests.flatMap((r) => r.items || []);
    let response = `You have **additional documents** requested for **${ctx.qualificationName}**.\n\nGo to your **Documents** page and scroll to the "Additional Documents" section. The following items are needed:\n`;
    if (items.length > 0) {
      response += items.map((item) => `- ${item}`).join('\n');
    }
    response += '\n\nPlease upload each item and click **Submit** when done.';
    return response;
  }

  const steps = [];

  // Payment
  if (!ctx.paymentCompleted && ctx.totalPaid === 0) {
    steps.push('Complete your **payment** — go to the **Payments** section on your Dashboard. You can pay in full or set up a payment plan.');
  } else if (!ctx.paymentCompleted && ctx.totalPaid > 0) {
    steps.push(`Continue your **payment** — you've paid $${ctx.totalPaid.toLocaleString('en-AU')} of $${ctx.price.toLocaleString('en-AU')}. Go to **Payments** to pay the remaining balance.`);
  }

  // Intake form
  if (!ctx.intakeFormSubmitted) {
    steps.push('Fill in your **Student Intake Form** — this collects your personal details, employment history, and education background. Find it on your Dashboard or the Intake Form page.');
  }

  // Documents
  if (!ctx.documentsUploaded) {
    if (ctx.documentCount === 0) {
      steps.push('Upload your **required documents** — ID verification (100+ points), employment evidence, educational documents, and references. Go to the **Documents** section.');
    } else {
      steps.push(`Continue uploading documents — you have ${ctx.documentCount} file(s) so far but haven't submitted yet. Go to **Documents** to upload remaining files and click **Submit Documents** when complete.`);
    }
  }

  // Waiting states
  if (ctx.documentsUploaded && ctx.intakeFormSubmitted && ctx.paymentCompleted) {
    if (['DocumentsUploaded', 'SubmissionReview', 'StudentCompleted'].includes(ctx.status)) {
      return `All your obligations for **${ctx.qualificationName}** are complete! Your application is now **under review** by our team. No action is needed from you right now — we'll notify you if anything is required.\n\nRPL assessments typically take 4–8 weeks after all documents are submitted. We'll keep you updated.`;
    }
    if (['SentToRTO', 'RTOReview'].includes(ctx.status)) {
      return `Your application for **${ctx.qualificationName}** is **with the RTO** for assessment. No action is needed from you right now. We'll update you once they've completed their review.`;
    }
    if (['RTOCompleted', 'RTOInvoiceUploaded', 'CertificateGenerated'].includes(ctx.status)) {
      return `Your RTO assessment for **${ctx.qualificationName}** is **complete**! Your certificate is being prepared — you'll receive a notification when it's ready to download.`;
    }
  }

  if (steps.length === 0) {
    return `Your application for **${ctx.qualificationName}** is at the **${ctx.status}** stage. No specific action is needed right now — we'll notify you when something requires your attention.`;
  }

  return `Here's what to do next for **${ctx.qualificationName}** (${ctx.applicationId}):\n\n${steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}`;
};

const handlePayment = (ctx) => {
  let response = `**Payment summary for ${ctx.qualificationName}** (${ctx.applicationId}):\n\n`;

  response += `- Course fee: **$${ctx.price.toLocaleString('en-AU')}**\n`;
  if (ctx.discountAmount > 0) {
    response += `- Discount applied: **-$${ctx.discountAmount.toLocaleString('en-AU')}**\n`;
  }
  response += `- Amount paid: **$${ctx.totalPaid.toLocaleString('en-AU')}**\n`;
  response += `- Remaining: **$${ctx.remaining.toLocaleString('en-AU')}**\n`;

  if (ctx.paymentCompleted) {
    response += '\n✅ Your payment is **fully completed**. No further payments are required.';
  } else if (ctx.hasPlan) {
    response += `\n**Payment plan:** ${ctx.planCompleted} of ${ctx.planInstallments} instalments completed (${ctx.planStatus}).`;
    if (ctx.planNextDue) {
      const dueDate = new Date(ctx.planNextDue.dueDate).toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Australia/Sydney' });
      response += `\nNext instalment: **$${ctx.planNextDue.amount.toLocaleString('en-AU')}** due on **${dueDate}**.`;
    }
  } else if (ctx.totalPaid === 0) {
    response += '\nTo make a payment, go to the **Payments** section in your portal. You can pay in full or set up a payment plan.';
  } else {
    response += '\nTo pay the remaining balance, go to the **Payments** section in your portal.';
  }

  return response;
};

const handleCertificate = (ctx) => {
  if (ctx.hasCertificate) {
    return `Your certificate for **${ctx.qualificationName}** has been issued! 🎉\n\nGo to the **Certificates** section in your portal to download the soft copy.\n\nIf a hard copy has been dispatched via Australia Post, check your email for tracking details. Delivery typically takes 3–5 business days within Australia.`;
  }
  if (['RTOCompleted', 'RTOInvoiceUploaded', 'CertificateGenerated'].includes(ctx.status)) {
    return `Your RTO assessment is complete for **${ctx.qualificationName}**. Your certificate is being prepared — you'll receive a notification when it's available to download.`;
  }
  return `Your certificate for **${ctx.qualificationName}** hasn't been issued yet. Your application is currently at the **${ctx.status}** stage.\n\nRPL assessments typically take 4–8 weeks after all documents and obligations are completed. We'll notify you as soon as your certificate is ready.`;
};

const handleDocsNeeded = async (ctx) => {
  // Try to get qualification-specific checklist
  let checklistText = null;
  if (ctx.qualificationCode || ctx.qualificationName) {
    try {
      const app = await Application.findOne({ applicationId: ctx.applicationId }).populate('qualificationId').lean();
      if (app?.qualificationId?.checklistId) {
        const checklist = await Checklist.findById(app.qualificationId.checklistId).lean();
        if (checklist?.sections?.length) {
          checklistText = checklist.sections
            .map((s) => `**${s.title}**:\n${(s.items || []).map((item) => `  - ${item.name || item}`).join('\n')}`)
            .join('\n\n');
        }
      }
    } catch { /* ignore */ }
  }

  if (checklistText) {
    let response = `Here's the specific evidence checklist for **${ctx.qualificationName}**:\n\n${checklistText}`;
    if (ctx.hasAdditionalDocRequests) {
      response += '\n\n⚠️ You also have **additional documents** requested by admin. Check the Documents page for the specific items needed.';
    }
    return response;
  }

  // SWMS and Visual Evidence share the same trade-industry gate
  const VISUAL_EVIDENCE_INDUSTRIES = ['automotive', 'building & construction', 'hospitality', 'information & communications technology', 'beauty therapy & hairdressing'];
  const isTradeIndustry = VISUAL_EVIDENCE_INDUSTRIES.some((n) => (ctx.industryName || '').toLowerCase().includes(n));

  // Generic document list
  const docs = [
    '**Identity Documents** (100+ points required) — combine from: Driver\'s Licence (40pts), Passport (70pts), Birth Certificate (70pts), Medicare Card (25pts), ID Card (40pts), Credit Card (15pts), Australian Citizenship (70pts)',
    '**Educational Documents** — USI VET Transcript, USI Portal Screenshot, Previous Qualifications',
    `**Employment Evidence** — Resume, Employment Letter, Reference One, Reference Two, ${isTradeIndustry ? 'SWMS (Safe Work Method Statement), ' : ''}Payslips/Invoices (at least 3)`,
  ];

  let response = `For your **${ctx.qualificationName}** application, you'll need:\n\n${docs.map((d, i) => `${i + 1}. ${d}`).join('\n')}\n\n`;

  if (isTradeIndustry) {
    response += '4. **Visual Evidence** — Photos of your work (min 10) and Videos (min 5)\n\n';
  }

  response += 'Check the **Documents** page for your complete requirements.';

  if (ctx.hasAdditionalDocRequests) {
    response += '\n\n⚠️ You also have **additional documents** requested by admin. Check the Documents page for the specific items needed.';
  }

  return response;
};

const handleDocsPending = (ctx) => {
  if (ctx.documentCount === 0) {
    return `You haven't uploaded any documents yet for **${ctx.qualificationName}**.\n\nGo to the **Documents** section on your Dashboard to start uploading your ID, employment evidence, references, and other required files.`;
  }

  let response = `You've uploaded **${ctx.documentCount}** file(s) so far for **${ctx.qualificationName}**.`;

  if (ctx.documentsUploaded) {
    response += '\n\n✅ Documents have been **submitted**. Our team will review them.';
  } else {
    response += '\n\n⏳ Documents have **not been submitted** yet. Please go to the **Documents** page, upload any remaining files, and click **Submit Documents** when complete.';
  }

  if (ctx.feedbackRequested) {
    response += '\n\n⚠️ Some documents need **resubmission** — check your notifications or email for details on which files need to be re-uploaded.';
  }
  if (ctx.hasAdditionalDocRequests) {
    const items = ctx.additionalDocRequests.flatMap((r) => r.items || []);
    response += `\n\n⚠️ **Additional documents requested:**`;
    if (items.length > 0) {
      response += '\n' + items.map((item) => `- ${item}`).join('\n');
    }
    response += '\n\nUpload these in the "Additional Documents" section of your Documents page.';
  }

  return response;
};

const handleReferenceLetter = () => {
  return "You can request a **reference letter template** from the admin team. Here's how:\n\n1. Go to your **Documents** page\n2. Find the **Reference One** or **Reference Two** upload section\n3. Click the **info icon** (ℹ️) next to the reference field name\n4. In the tooltip that appears, click **\"Request Template from Admin\"**\n5. The system will automatically email you the template for your qualification, and the admin team will also be notified\n\nYou'll need **two references** — these should be from employers or supervisors who can verify your work experience relevant to your qualification.\n\nIf you need further help, you can create a **support ticket** or contact us at **info@certifiedaustralia.com.au** or call **1300 044 927**.";
};

const handleHumanSupport = () => {
  return null; // Signal to frontend to show support button
};

/**
 * The USI is per-student, not per-application. It is captured on the Student
 * record at sign-up and again on the Intake Form — read both, newest wins.
 */
const getStudentUSI = async (studentId) => {
  if (!studentId) return null;
  try {
    const student = await Student.findById(studentId).select('usi').lean();
    if (student?.usi) return String(student.usi).trim();

    // IntakeForm is keyed by applicationId, not studentId — go via the student's
    // applications to reach it.
    const apps = await Application.find({ studentId }).select('_id').lean();
    if (!apps.length) return null;
    const intake = await IntakeForm.findOne({ applicationId: { $in: apps.map((a) => a._id) }, usi: { $nin: [null, ''] } })
      .sort('-createdAt')
      .select('usi')
      .lean();
    return intake?.usi ? String(intake.usi).trim() : null;
  } catch {
    return null;
  }
};

const USI_HELP_LINKS = "**Create a USI (free):** https://www.usi.gov.au/students/get-a-usi\n**Forgotten your USI?** https://www.usi.gov.au/faqs/i-have-forgotten-my-usi";

/**
 * USI questions split into a few distinct asks — "what is it", "I don't have
 * one", "I forgot mine", "where do I put it", "the USI documents".
 * All of them are answerable without an LLM, so this stays deterministic.
 */
const handleUSI = (message, usiOnFile) => {
  const msg = String(message || '').toLowerCase();

  const noUSI = /\b(no|don'?t|do not|dont|haven'?t|have not|without|need|get|create|apply|obtain|register|sign.?up|new)\b/.test(msg)
    && !/\b(what.*is|meaning|stands? for)\b/.test(msg);
  const forgotten = /\b(forgot|forgotten|lost|can'?t remember|cannot remember|find my|retrieve|recover|what.*is my|where.*is my)\b/.test(msg);
  const whereToEnter = /\b(enter|put|add|update|change|provide|submit|where.*do.*i)\b/.test(msg);
  const aboutDocs = /\b(transcript|screenshot|document|upload|evidence)\b/.test(msg);

  const onFileLine = usiOnFile
    ? `\n\n📄 The USI we currently have on file for you is **${usiOnFile}**.`
    : `\n\n📄 We don't have a USI on file for you yet — you'll need to add it to your **Student Intake Form** before your application can be assessed.`;

  let response = "**USI — Unique Student Identifier**\n\nA USI is a free, government-issued 10-character code (letters and numbers) that acts as your permanent reference number for all nationally recognised training in Australia. By law, every student doing nationally recognised training needs one — we can't issue your certificate without it.";

  // Order matters: a question about the USI *documents* ("do I need to upload
  // the USI transcript") contains "need"/"upload" and would otherwise be read
  // as "I don't have a USI". Recovery beats creation — never send someone who
  // has lost their USI off to create a second one.
  if (aboutDocs) {
    response += "\n\n**We ask for two USI items** in **Documents → Educational Qualifications**:\n- **USI VET Transcript** — a digital record of all nationally recognised training you've completed in Australia. To get it: log in at https://www.usi.gov.au with your USI, then download your transcript.\n- **USI Portal Screenshot** — a screenshot of your USI portal showing your **name and USI number** together.";
    response += onFileLine;
    return response;
  }

  if (forgotten) {
    response = "**Forgotten or lost your USI?**\n\nYou don't need to create a new one — you can recover your existing USI. Go to https://www.usi.gov.au/faqs/i-have-forgotten-my-usi and use the **Forgotten USI** option. You'll need the ID you originally created it with (for example your driver's licence, Medicare card, or passport).";
    response += onFileLine;
    response += "\n\nOnce you have it, add it to your **Student Intake Form** in the portal.";
    return response;
  }

  if (noUSI) {
    response += "\n\n**You can create one yourself in about 5 minutes — it's free:**\n1. Go to https://www.usi.gov.au/students/get-a-usi\n2. Click **Create your USI**\n3. Agree to the terms and verify your identity with **one** form of ID — driver's licence, Medicare card, Australian passport, birth certificate, citizenship certificate, ImmiCard, or visa\n4. Enter your personal details exactly as they appear on that ID\n5. Set your contact details and check questions, then submit\n\nYour USI is issued immediately on screen — save it somewhere safe.";
    response += onFileLine;
    response += `\n\nIf you think you might already have one (for example from previous TAFE or college study), check first: https://www.usi.gov.au/faqs/i-have-forgotten-my-usi\n\nIf you get stuck creating your USI, create a support ticket below or call us on **1300 044 927** and we'll walk you through it.`;
    return response;
  }

  if (whereToEnter) {
    response += "\n\n**Where to enter it:** open your **Student Intake Form** in the portal — the USI field is in the personal details section and is required. If your intake form is already submitted and the USI needs correcting, create a support ticket below and our team will update it for you.";
    response += onFileLine;
    return response;
  }

  response += onFileLine;
  response += `\n\n${USI_HELP_LINKS}\n\nYou'll also need to upload your **USI VET Transcript** and a **USI Portal Screenshot** under **Documents → Educational Qualifications**.\n\nAnything else about your USI I can help with?`;
  return response;
};

/**
 * Cancellations, withdrawals and refunds are commercial decisions — the bot
 * must never confirm or action one. It hands the student to support warmly and
 * flags the ticket so it doesn't sit in the queue as a routine query.
 */
const handleCancellation = () => (
  "I'm sorry to hear you're thinking about cancelling.\n\nCancellations, withdrawals and refunds aren't something I can process myself — they need to go to our support team so they can talk it through with you properly, explain what it means for your application and any payments already made, and check whether there's anything we can sort out for you first.\n\n**Please create a support ticket below and a team member will contact you to discuss this.**\n\nIf you'd rather speak to someone straight away, call us on **1300 044 927** or email **info@certifiedaustralia.com.au**."
);

// ---------------------------------------------------------------------------
// Embedding helpers
// ---------------------------------------------------------------------------

const getEmbedding = async (text) => {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;
  try {
    const res = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: 'text-embedding-3-small', input: text }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.data?.[0]?.embedding || null;
  } catch {
    return null;
  }
};

const cosineSimilarity = (a, b) => {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
};

/**
 * Generate and store embedding for a KB entry.
 */
const generateKBEmbedding = async (entryId) => {
  const entry = await KnowledgeBase.findById(entryId);
  if (!entry) return null;
  const text = `${entry.question} ${entry.answer} ${(entry.tags || []).join(' ')}`;
  const embedding = await getEmbedding(text);
  if (embedding) {
    entry.embedding = embedding;
    await entry.save();
  }
  return embedding;
};

/**
 * Generate embeddings for all KB entries that don't have one.
 */
const generateAllEmbeddings = async () => {
  const entries = await KnowledgeBase.find({ $or: [{ embedding: { $exists: false } }, { embedding: null }, { embedding: { $size: 0 } }] });
  let count = 0;
  for (const entry of entries) {
    const text = `${entry.question} ${entry.answer} ${(entry.tags || []).join(' ')}`;
    const embedding = await getEmbedding(text);
    if (embedding) {
      entry.embedding = embedding;
      await entry.save();
      count++;
    }
  }
  return count;
};

// ---------------------------------------------------------------------------
// KB context retrieval (embedding-based with text search fallback)
// ---------------------------------------------------------------------------

const SIMILARITY_THRESHOLD = 0.25;

const getKBContext = async (message, applicationStage) => {
  // Try embedding-based semantic search first
  const queryEmbedding = await getEmbedding(message);
  if (queryEmbedding) {
    const allEntries = await KnowledgeBase.find({ embedding: { $exists: true, $ne: null, $not: { $size: 0 } } })
      .select('question answer tags applicationStage priority category embedding')
      .lean();

    if (allEntries.length > 0) {
      const scored = allEntries
        .map((e) => ({ ...e, similarity: cosineSimilarity(queryEmbedding, e.embedding) }))
        .filter((e) => e.similarity >= SIMILARITY_THRESHOLD)
        .sort((a, b) => b.similarity - a.similarity);

      // Boost stage-specific entries
      if (applicationStage && scored.length > 1) {
        const stageSpecific = scored.filter((e) => e.applicationStage === applicationStage);
        const rest = scored.filter((e) => e.applicationStage !== applicationStage);
        const reordered = [...stageSpecific, ...rest];
        return reordered.slice(0, 5).map(({ embedding, ...e }) => e);
      }

      return scored.slice(0, 5).map(({ embedding, ...e }) => e);
    }
  }

  // Fallback: MongoDB text search
  let entries = [];
  try {
    entries = await KnowledgeBase.find(
      { $text: { $search: message } },
      { score: { $meta: 'textScore' } }
    )
      .sort({ score: { $meta: 'textScore' }, priority: -1 })
      .limit(5)
      .select('-embedding')
      .lean();
  } catch {
    // Text index may not exist yet
  }

  if (applicationStage && entries.length > 1) {
    const stageSpecific = entries.filter((e) => e.applicationStage === applicationStage);
    if (stageSpecific.length > 0) {
      entries = [...stageSpecific, ...entries.filter((e) => e.applicationStage !== applicationStage)];
    }
  }

  return entries.slice(0, 5);
};

// ---------------------------------------------------------------------------
// LLM answer generation (fallback for GENERAL intent — uses gpt-4o)
// ---------------------------------------------------------------------------

const buildSystemPrompt = (kbEntries, appContext) => {
  let prompt = `You are a warm, patient, and knowledgeable student support assistant for Certified Australia — a Registered Training Organisation (RTO) that helps students get nationally recognised qualifications through Recognition of Prior Learning (RPL).

Your job is to help real students — many of whom are unfamiliar with online portals — feel confident and supported throughout their application journey.

GUIDELINES:
- Be warm, plain-spoken, and reassuring. Avoid jargon. Students may be stressed.
- Give specific, actionable steps. Never say "contact your provider" when you can tell them exactly where to click.
- Never refer to technical IDs in your replies unless the student asked for them.
- Never make up information. If unsure, direct them to email info@certifiedaustralia.com.au or call 1300 044 927.
- Do not share any other student's information.
- Format responses with short paragraphs or bullet points — never long walls of text.
- Keep responses under 200 words.
- If a student seems frustrated, acknowledge their frustration and be extra clear.

COMMON STUDENT SITUATIONS YOU SHOULD HANDLE:
1. "What do I do next?" — Check their payment, intake form, and document upload status. Guide them to the first incomplete step.
2. "What documents do I need?" — Show the qualification checklist. Explain each category briefly.
3. "What have I uploaded / what's still pending?" — Show which documents are uploaded vs outstanding.
4. "How do I pay?" — Explain payment options (full payment or payment plan) and where to find the Pay button.
5. "How long will this take?" — RPL assessments typically take 4–8 weeks after all documents are submitted.
6. "I can't log in / forgot my password" — Direct them to the login page and the "Forgot Password" link.
7. "I uploaded the wrong document / need to replace a file" — Go to Documents, upload the corrected file for the same field.
8. "What is RPL?" — Recognition of Prior Learning: getting a qualification recognised based on existing skills and experience, without sitting a full course.
9. "What is a Student Intake Form?" — A form about personal details, employment history, and education. Needed before assessment can begin.
10. "What is 100-point ID?" — A combination of identity documents totalling 100 points. Examples: Passport (70 pts), Driver's Licence (40 pts), Medicare card (25 pts).
11. "My application is stuck / hasn't moved" — Reassure and check their status. Often waiting for payment, intake form, or documents.
12. "When will I get my certificate?" — After assessment is complete. Typically a few weeks after RTO review.
13. "I need to speak to someone" — Acknowledge warmly and offer the support ticket option.
14. "I've been asked to resubmit documents" — Admin has reviewed and needs corrections. Check notifications for details, then re-upload in the Documents section.
15. "I've been asked to provide additional documents" — Named upload slots have been created. Go to Documents → Additional Documents section.
16. "What is a USI / I don't have a USI" — A Unique Student Identifier: a free, government-issued 10-character code required by law for all nationally recognised training in Australia. Students create one at https://www.usi.gov.au/students/get-a-usi with one form of ID; a forgotten USI is recovered at https://www.usi.gov.au/faqs/i-have-forgotten-my-usi (never tell a student to create a second USI). It is entered on the Student Intake Form, and students also upload a USI VET Transcript and a USI Portal Screenshot under Documents → Educational Qualifications.
17. "I want to cancel / withdraw / get a refund" — NEVER confirm, action, or promise a cancellation or refund, and never quote cancellation terms or fees. Respond with empathy, explain that this needs to be discussed with the support team, and direct them to create a support ticket or call 1300 044 927.

PORTAL NAVIGATION:
- Dashboard: overview of applications and quick actions
- Documents: upload ID, employment, education, and evidence documents
- Payments: view payment status, make payments, see payment plan details
- Certificates: download issued certificates, view delivery tracking
- Support: create support tickets, view existing tickets
- Intake Form: complete personal information and qualification requirements

IMPORTANT INFORMATION:
- RPL = Recognised Prior Learning — formal recognition of skills gained through work experience
- Students need 100+ points from ID documents
- The 21-day completion window is a KPI for RTO assessment, not a hard deadline
- All qualifications are nationally recognised through Australian RTOs
- The portal is AUD-only
- Certificate delivery: soft-copy download + optional hard-copy via Australia Post`;

  if (kbEntries?.length > 0) {
    prompt += `\n\n─── Portal Knowledge Base ───\nUse the following knowledge to answer the student's question accurately:\n\n${kbEntries.map((e) => `Q: ${e.question}\nA: ${e.answer}`).join('\n\n')}`;
  }

  if (appContext) {
    prompt += `\n\n─── Student's Current Application ───
Application ID: ${appContext.applicationId}
Qualification: ${appContext.qualificationName}
Current Status: ${appContext.status}
Payment: ${appContext.paymentCompleted ? 'Fully paid' : appContext.totalPaid > 0 ? `Partially paid — $${appContext.totalPaid} of $${appContext.price}` : `Not yet paid — total fee $${appContext.price}${appContext.discountAmount ? ` (discount: $${appContext.discountAmount})` : ''}`}
Payment Plan: ${appContext.hasPlan ? `Active — ${appContext.planCompleted} of ${appContext.planInstallments} payments completed (${appContext.planStatus})` : 'No payment plan'}
Student Intake Form: ${appContext.intakeFormSubmitted ? 'Submitted' : 'Not yet submitted'}
Documents: ${appContext.documentsUploaded ? 'Submitted' : appContext.documentCount > 0 ? `${appContext.documentCount} file(s) uploaded but not submitted` : 'Not yet uploaded'}
Feedback / Resubmission: ${appContext.feedbackRequested ? 'YES — admin has requested document corrections' : 'No'}
Additional Docs Requested: ${appContext.hasAdditionalDocRequests ? `YES — ${appContext.additionalDocRequests.flatMap((r) => r.items || []).length} item(s)` : 'No'}
Certificate: ${appContext.hasCertificate ? 'Issued — available for download' : 'Not yet issued'}`;
  }

  return prompt;
};

const generateLLMAnswer = async (message, chatHistory, kbEntries, appContext) => {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;

  const systemPrompt = buildSystemPrompt(kbEntries, appContext);

  // Build message history (last 12 messages for context)
  const messages = [{ role: 'system', content: systemPrompt }];
  if (chatHistory?.length > 0) {
    const recent = chatHistory.slice(-12);
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
        model: 'gpt-4o',
        max_tokens: 600,
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

const KB_DIRECT_THRESHOLD = 0.55; // High-confidence KB matches bypass intent routing

const getAnswer = async ({ studentId, message, applicationId, chatHistory }) => {
  if (!message || message.trim().length < 3) {
    return { answer: "Could you tell me more about what you need help with?", matched: false };
  }

  // Step 0: Check knowledge base FIRST for strong matches before intent classification.
  // If an admin has added a specific Q&A to the KB, it should take priority over
  // deterministic handlers which give generic status-based responses.
  try {
    const kbResults = await getKBContext(message, null);
    if (kbResults.length > 0) {
      const topMatch = kbResults[0];
      // High-confidence embedding match
      const hasStrongEmbedding = topMatch.similarity >= KB_DIRECT_THRESHOLD;
      // Text search match — check if the question is a close match (case-insensitive containment)
      const msgLower = message.toLowerCase().trim();
      const qLower = (topMatch.question || '').toLowerCase().trim();
      const hasStrongText = !topMatch.similarity && qLower && (
        msgLower.includes(qLower) || qLower.includes(msgLower) ||
        // Overlap check: >60% of words match
        (() => {
          const msgWords = msgLower.split(/\s+/).filter(w => w.length > 2);
          const qWords = qLower.split(/\s+/).filter(w => w.length > 2);
          const overlap = msgWords.filter(w => qWords.includes(w)).length;
          return qWords.length > 0 && (overlap / qWords.length) >= 0.6;
        })()
      );

      if (hasStrongEmbedding || hasStrongText) {
        return {
          answer: topMatch.answer,
          matched: true,
          source: 'knowledge_base',
          meta: { kbEntryId: topMatch._id, category: topMatch.category },
        };
      }
    }
  } catch { /* KB search failed — continue with intent routing */ }

  // Step 1: Classify intent
  const intent = await classifyIntent(message);

  // Step 2: Handle human support request immediately
  if (intent === 'HUMAN_SUPPORT') {
    return {
      answer: "I understand you'd like to speak with our support team. Click the button below to create a support ticket, and our team will get back to you shortly.\n\nYou can also reach us at **info@certifiedaustralia.com.au** or call **1300 044 927**.",
      matched: true,
      suggestEscalation: true,
      meta: { showSupportButton: true },
    };
  }

  // Step 2b: Cancellation / withdrawal / refund — always route to a human, and
  // tag the escalation so support sees it as urgent rather than a general query.
  if (intent === 'CANCELLATION') {
    return {
      answer: handleCancellation(),
      matched: true,
      source: 'deterministic',
      intent,
      suggestEscalation: true,
      meta: {
        showSupportButton: true,
        escalation: { category: 'payments', priority: 'high' },
      },
    };
  }

  // Step 2c: USI — answered from the student's own record, no LLM needed
  if (intent === 'USI') {
    const usiOnFile = await getStudentUSI(studentId);
    return {
      answer: handleUSI(message, usiOnFile),
      matched: true,
      source: 'deterministic',
      intent,
    };
  }

  // Step 3: Get application context for app-specific intents
  const appSpecificIntents = ['NEXT_STEP', 'APP_STATUS', 'DOCS_NEEDED', 'DOCS_PENDING', 'CERTIFICATE', 'PAYMENT', 'REFERENCE_LETTER'];
  let appContext = null;

  if (appSpecificIntents.includes(intent) && studentId) {
    const apps = await listStudentApps(studentId);

    if (apps.length > 1 && !applicationId) {
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
        deterministicAnswer = await handleDocsNeeded(appContext);
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

  // Step 5: Reference letter handler (context-aware — checks if template exists)
  if (intent === 'REFERENCE_LETTER') {
    let templateInfo = '';
    try {
      const ReferenceLetterTemplate = require('../models/ReferenceLetterTemplate');
      // Try to find template for the student's qualification
      if (appContext?.qualificationId) {
        const qualId = typeof appContext.qualificationId === 'object' ? appContext.qualificationId._id : appContext.qualificationId;
        const template = await ReferenceLetterTemplate.findOne({ qualificationId: qualId }).lean();
        if (template) {
          templateInfo = `\n\n**Good news!** A reference letter template is available for your qualification. Use the "Request Template from Admin" button in the Documents section, and it will be emailed to you automatically.`;
        }
      }
    } catch (e) { /* non-fatal */ }
    return {
      answer: handleReferenceLetter() + templateInfo,
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
    answer: "That one's best answered by a person rather than me. Create a support ticket below and our team will get back to you to discuss it.\n\nYou can also reach us at **info@certifiedaustralia.com.au** or call **1300 044 927**.\n\nIn the meantime, I can help with your application status, next steps, required documents, payments, reference letters, your USI, or your certificate.",
    matched: false,
    suggestEscalation: true,
  };
};

// ---------------------------------------------------------------------------
// Escalation
// ---------------------------------------------------------------------------

// Transcript lines arrive either as strings or as { role, text|content }. The
// widget sends role 'user' for the student — normalise everything to
// 'student' | 'bot' so the support UI has a single shape to render.
const normaliseTranscript = (chatTranscript) => (chatTranscript || []).map((line) => {
  if (typeof line === 'string') {
    return {
      role: line.startsWith('Student') ? 'student' : 'bot',
      content: line,
    };
  }
  const role = line.role === 'user' || line.role === 'student' ? 'student' : 'bot';
  const entry = {
    role,
    content: line.text || line.content || String(line),
  };
  if (line.at || line.timestamp) entry.timestamp = new Date(line.at || line.timestamp);
  return entry;
});

// Whitelisted against the Ticket schema enums — an unknown value from the
// client would otherwise fail validation and 500 the escalation.
const TICKET_CATEGORIES = ['intake_form', 'documents', 'payments', 'technical', 'rto_support', 'general', 'other'];
const TICKET_PRIORITIES = ['low', 'medium', 'high', 'urgent'];

const escalateToTicket = async ({ studentId, chatTranscript, subject, applicationId, category, priority }) => {
  const transcript = normaliseTranscript(chatTranscript);

  // The student's last question is what support actually needs to answer — use
  // it as the title so chatbot tickets aren't all identically named in the inbox.
  const lastQuestion = [...transcript].reverse().find((l) => l.role === 'student' && l.content?.trim())?.content?.trim();
  const title = lastQuestion
    ? (lastQuestion.length > 90 ? `${lastQuestion.slice(0, 90)}...` : lastQuestion)
    : (subject || 'Chatbot Escalation');

  const description = lastQuestion
    ? `Escalated from chatbot — the assistant could not resolve this.\n\nStudent's question:\n"${lastQuestion}"\n\nThe full chatbot conversation is shown on this ticket.`
    : 'Escalated from chatbot — student question could not be resolved automatically.';

  const ticket = await ticketService.createTicket({
    requesterId: studentId,
    title,
    description,
    type: 'query',
    category: TICKET_CATEGORIES.includes(category) ? category : 'general',
    priority: TICKET_PRIORITIES.includes(priority) ? priority : 'medium',
    source: 'chatbot',
    ...(applicationId ? { applicationId } : {}),
    chatbotTranscript: transcript,
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
  generateKBEmbedding,
  generateAllEmbeddings,
};
