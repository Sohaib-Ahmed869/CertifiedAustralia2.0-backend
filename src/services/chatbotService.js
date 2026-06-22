const KnowledgeBase = require('../models/KnowledgeBase');
const Application = require('../models/Application');
const ticketService = require('./ticketService');
const buildCrud = require('./commonCrud');

const knowledgeCrud = buildCrud(KnowledgeBase, {});

/**
 * Call OpenAI to generate an answer using knowledge base context.
 * Falls back to text search if OpenAI is unavailable.
 */
const callOpenAI = async (message, context) => {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;

  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        max_tokens: 300,
        temperature: 0.3,
        messages: [
          {
            role: 'system',
            content: `You are the Certified Australia support assistant. You help students with their RPL (Recognised Prior Learning) applications.

Your role:
- Answer questions about the application process, document uploads, payments, certificates, and support.
- Be friendly, concise, and helpful.
- If you don't know the answer, say so and suggest creating a support ticket.
- Never make up information about specific application statuses or payment amounts.

${context.applicationStage ? `The student's current application stage is: ${context.applicationStage}` : ''}

${context.knowledgeEntries.length > 0 ? `Relevant knowledge base entries:\n${context.knowledgeEntries.map((e) => `Q: ${e.question}\nA: ${e.answer}`).join('\n\n')}` : ''}`,
          },
          { role: 'user', content: message },
        ],
      }),
    });

    if (!res.ok) return null;

    const data = await res.json();
    return data.choices?.[0]?.message?.content || null;
  } catch {
    return null;
  }
};

/**
 * Answer a student question.
 * Uses OpenAI with knowledge base context when available.
 * Falls back to text search only if OpenAI is unavailable.
 */
const getAnswer = async ({ studentId, message }) => {
  if (!message || message.trim().length < 3) {
    return { answer: "Could you tell me more about what you need help with?", matched: false };
  }

  // Get student's current application stage for context
  let applicationStage = null;
  if (studentId) {
    const app = await Application.findOne({ studentId }).sort('-createdAt').lean();
    if (app) applicationStage = app.status;
  }

  // Fetch relevant knowledge base entries for context
  let kbEntries = [];
  try {
    kbEntries = await KnowledgeBase.find(
      { $text: { $search: message } },
      { score: { $meta: 'textScore' } }
    )
      .sort({ score: { $meta: 'textScore' }, priority: -1 })
      .limit(5)
      .lean();
  } catch {
    // Text index may not exist yet — that's fine
  }

  // Check for reference letter template queries (CA-05)
  const refLetterKeywords = ['reference letter', 'referee', 'reference template', 'supporting template'];
  const isRefLetterQuery = refLetterKeywords.some((kw) => message.toLowerCase().includes(kw));
  if (isRefLetterQuery) {
    return {
      answer: "You can request a reference letter template from the admin team. Look for the info icon near the document upload area on your Documents page, or contact the admin team directly for assistance. If you need help filling it in, our team is happy to guide you.",
      category: 'reference_letters',
      matched: true,
    };
  }

  // Try OpenAI first
  const aiAnswer = await callOpenAI(message, {
    applicationStage,
    knowledgeEntries: kbEntries,
  });

  if (aiAnswer) {
    return {
      answer: aiAnswer,
      matched: true,
      source: 'ai',
      relatedQuestions: kbEntries.slice(0, 3).map((e) => e.question).filter(Boolean),
    };
  }

  // Fallback: use knowledge base text search directly
  if (kbEntries.length > 0) {
    // Prefer stage-specific answers
    if (applicationStage) {
      const stageSpecific = kbEntries.filter((e) => e.applicationStage === applicationStage);
      if (stageSpecific.length > 0) kbEntries = [...stageSpecific, ...kbEntries.filter((e) => e.applicationStage !== applicationStage)];
    }

    return {
      answer: kbEntries[0].answer,
      category: kbEntries[0].category,
      matched: true,
      source: 'knowledge_base',
      relatedQuestions: kbEntries.slice(1, 4).map((e) => e.question),
    };
  }

  // No match — suggest escalation
  return {
    answer: "I'm sorry, I couldn't find an answer to your question. Would you like me to create a support ticket so our team can help you?",
    matched: false,
    suggestEscalation: true,
  };
};

/**
 * Escalate a chatbot conversation to a support ticket.
 */
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
      role: typeof line === 'string' ? (line.startsWith('Student') ? 'student' : 'bot') : 'bot',
      content: typeof line === 'string' ? line : String(line),
    })),
  });

  return ticket;
};

module.exports = {
  knowledge: knowledgeCrud,
  getAnswer,
  escalateToTicket,
};
