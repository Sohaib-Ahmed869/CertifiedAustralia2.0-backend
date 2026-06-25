const express = require('express');
const { protect, authorize } = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');
const chatbotService = require('../services/chatbotService');

const router = express.Router();

router.use(protect);

// Student chatbot endpoint
router.post('/ask', asyncHandler(async (req, res) => {
  const result = await chatbotService.getAnswer({
    studentId: req.user._id,
    message: req.body.message,
    applicationId: req.body.applicationId || null,
    chatHistory: req.body.chatHistory || [],
  });
  res.json(result);
}));

// Escalate to ticket
router.post('/escalate', asyncHandler(async (req, res) => {
  const ticket = await chatbotService.escalateToTicket({
    studentId: req.user._id,
    chatTranscript: req.body.transcript,
    subject: req.body.subject,
  });
  res.status(201).json({ item: ticket });
}));

// Knowledge base CRUD (admin only)
router.get('/knowledge',
  authorize('Admin', 'CEOReportingManager'),
  asyncHandler(async (req, res) => {
    const result = await chatbotService.knowledge.list(req.query);
    res.json(result);
  })
);

router.post('/knowledge',
  authorize('Admin', 'CEOReportingManager'),
  asyncHandler(async (req, res) => {
    const item = await chatbotService.knowledge.create({
      ...req.body,
      updatedBy: req.user._id,
    });
    res.status(201).json({ item });
  })
);

router.patch('/knowledge/:id',
  authorize('Admin', 'CEOReportingManager'),
  asyncHandler(async (req, res) => {
    const item = await chatbotService.knowledge.update(req.params.id, {
      ...req.body,
      updatedBy: req.user._id,
      updatedAt: new Date(),
    });
    res.json({ item });
  })
);

router.delete('/knowledge/:id',
  authorize('Admin', 'CEOReportingManager'),
  asyncHandler(async (req, res) => {
    await chatbotService.knowledge.remove(req.params.id);
    res.json({ message: 'Deleted' });
  })
);

module.exports = router;
