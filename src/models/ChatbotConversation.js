const mongoose = require('mongoose');

/**
 * A persisted student ↔ chatbot session.
 *
 * The widget used to keep the whole conversation in React state and the backend
 * was stateless per turn (`/chatbot/ask` receives `chatHistory` from the client),
 * so nothing survived a refresh unless the student escalated to a ticket. This
 * model is the record: every turn is appended as it happens, keyed to the
 * student, so staff can read what students actually ask the bot — and see which
 * questions it failed to answer, which is the signal for what belongs in the
 * knowledge base.
 *
 * Session identity comes from the client: the first `/ask` of a session has no
 * `conversationId`, the response carries the new one, and the widget echoes it
 * back on every later turn. A refresh therefore starts a new conversation,
 * which is the intended granularity — one document per sitting.
 */

// Only two speakers. The widget's own roles ('user'/'suggestions'/'system') are
// normalised before they get here so the stored shape matches the one
// `ChatbotTranscriptPanel` already renders for escalated tickets.
const MESSAGE_ROLES = ['student', 'bot'];

const messageSchema = new mongoose.Schema(
  {
    role: { type: String, enum: MESSAGE_ROLES, required: true },
    content: { type: String, default: '' },
    // Bot-only diagnostics, straight off the `getAnswer` result. `source` says
    // which tier produced the reply (knowledge_base / deterministic / ai /
    // system) and `matched: false` marks a question the bot could not answer —
    // together they're the knowledge-base gap report.
    source: { type: String },
    intent: { type: String },
    matched: { type: Boolean },
    suggestedEscalation: { type: Boolean },
    at: { type: Date, default: Date.now },
  },
  { _id: false }
);

const chatbotConversationSchema = new mongoose.Schema(
  {
    studentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    // The application the student was asking about, if the widget could resolve
    // one. Nullable — plenty of questions aren't application-specific.
    applicationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Application',
      default: null,
    },
    messages: { type: [messageSchema], default: [] },

    // Denormalised counters — maintained with `$inc` alongside the `$push` so a
    // list view never has to load (or aggregate over) the messages array.
    messageCount: { type: Number, default: 0 },
    studentMessageCount: { type: Number, default: 0 },
    unansweredCount: { type: Number, default: 0 },

    // Set when the student turned this conversation into a support ticket. The
    // ticket keeps its own frozen `chatbotTranscript`; this is the live link
    // back, so a conversation that continued after escalating still reads whole.
    escalated: { type: Boolean, default: false },
    ticketId: { type: mongoose.Schema.Types.ObjectId, ref: 'Ticket', default: null },

    // First thing the student asked — the list view's title, stored rather than
    // sliced out of `messages` so the list projection can skip that array.
    firstQuestion: { type: String, default: '' },

    lastMessageAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

// Declared here only (never `index: true` on the paths as well) — a duplicated
// declaration adds a startup warning to the known-clean baseline.
chatbotConversationSchema.index({ studentId: 1, lastMessageAt: -1 });
chatbotConversationSchema.index({ lastMessageAt: -1 });
chatbotConversationSchema.index({ escalated: 1, lastMessageAt: -1 });
chatbotConversationSchema.index({ unansweredCount: 1, lastMessageAt: -1 });

module.exports = mongoose.model('ChatbotConversation', chatbotConversationSchema);
module.exports.MESSAGE_ROLES = MESSAGE_ROLES;
