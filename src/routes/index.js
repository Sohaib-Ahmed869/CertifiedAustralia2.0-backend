const express = require('express');
const authRoutes = require('./authRoutes');
const userRoutes = require('./userRoutes');
const catalogRoutes = require('./catalogRoutes');
const applicationRoutes = require('./applicationRoutes');
const paymentRoutes = require('./paymentRoutes');
const taskRoutes = require('./taskRoutes');
const rbacRoutes = require('./rbacRoutes');
const ticketRoutes = require('./ticketRoutes');
const notificationRoutes = require('./notificationRoutes');
const emailTemplateRoutes = require('./emailTemplateRoutes');
const ceoDashboardRoutes = require('./ceoDashboardRoutes');
const dynamicFormRoutes = require('./dynamicFormRoutes');
const schedulerRoutes = require('./schedulerRoutes');
const agentTargetRoutes = require('./agentTargetRoutes');
const calendarRoutes = require('./calendarRoutes');
const campaignRoutes = require('./campaignRoutes');
const mailboxRoutes = require('./mailboxRoutes');
const documentFeedbackRoutes = require('./documentFeedbackRoutes');
const chatRoutes = require('./chatRoutes');
const callLogRoutes = require('./callLogRoutes');
const rtoInvoiceRoutes = require('./rtoInvoiceRoutes');
const paymentBatchRoutes = require('./paymentBatchRoutes');
const xeroRoutes = require('./xeroRoutes');
const applicationController = require('../controllers/applicationController');

const router = express.Router();

router.use('/auth', authRoutes);
router.use('/users', userRoutes);
router.use('/', catalogRoutes);
router.use('/applications', applicationRoutes);
router.use('/payments', paymentRoutes);
router.use('/tasks', taskRoutes);
router.use('/rbac', rbacRoutes);
router.use('/tickets', ticketRoutes);
router.use('/notifications', notificationRoutes);
router.use('/email-templates', emailTemplateRoutes);
router.use('/ceo-dashboard', ceoDashboardRoutes);
router.use('/dynamic-forms', dynamicFormRoutes);
router.use('/scheduler', schedulerRoutes);
router.use('/agent-targets', agentTargetRoutes);
router.use('/calendar', calendarRoutes);
router.use('/campaigns', campaignRoutes);
router.use('/mailboxes', mailboxRoutes);
router.use('/document-feedback', documentFeedbackRoutes);
router.use('/chat', chatRoutes);
router.use('/call-logs', callLogRoutes);
router.use('/rto-invoices', rtoInvoiceRoutes);
router.use('/payment-batches', paymentBatchRoutes);
router.use('/xero', xeroRoutes);

// Standalone intake form access (read-only)
router.get('/intake-forms/:id', applicationController.intakeForms.getById);

module.exports = router;
