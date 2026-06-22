const KnowledgeBase = require('../models/KnowledgeBase');
const Application = require('../models/Application');
const Ticket = require('../models/Ticket');
const buildCrud = require('./commonCrud');

const knowledgeCrud = buildCrud(KnowledgeBase, {});

/**
 * Answer a student question using the knowledge base.
 * Progress-aware: filters by application stage when available.
 * Returns the best matching answer or an escalation suggestion.
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

  // Search knowledge base: text search + optional stage filter
  const searchFilter = { $text: { $search: message } };

  // Find matches sorted by text score + priority
  let results = await KnowledgeBase.find(
    searchFilter,
    { score: { $meta: 'textScore' } }
  )
    .sort({ score: { $meta: 'textScore' }, priority: -1 })
    .limit(5)
    .lean();

  // Prefer stage-specific answers if available
  if (applicationStage && results.length > 1) {
    const stageSpecific = results.filter((r) => r.applicationStage === applicationStage);
    if (stageSpecific.length > 0) {
      results = [...stageSpecific, ...results.filter((r) => r.applicationStage !== applicationStage)];
    }
  }

  if (results.length > 0) {
    const best = results[0];
    return {
      answer: best.answer,
      category: best.category,
      matched: true,
      relatedQuestions: results.slice(1, 4).map((r) => r.question),
    };
  }

  // Check for reference letter template queries (CA-05 integration)
  const refLetterKeywords = ['reference letter', 'referee', 'reference template', 'supporting template'];
  const isRefLetterQuery = refLetterKeywords.some((kw) => message.toLowerCase().includes(kw));
  if (isRefLetterQuery) {
    return {
      answer: "You can request a reference letter template from the admin team. Look for the info icon near the document upload area, or contact the admin team directly for assistance.",
      category: 'reference_letters',
      matched: true,
    };
  }

  // No match found — suggest escalation
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
  const ticket = await Ticket.create({
    studentId,
    title: subject || 'Chatbot Escalation',
    description: 'Escalated from chatbot — student question could not be resolved automatically.',
    status: 'open',
    priority: 'medium',
    source: 'chatbot',
    chatbotTranscript: chatTranscript || [],
  });

  return ticket.toObject();
};

module.exports = {
  knowledge: knowledgeCrud,
  getAnswer,
  escalateToTicket,
};
