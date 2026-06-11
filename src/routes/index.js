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

// Standalone intake form access (read-only)
router.get('/intake-forms/:id', applicationController.intakeForms.getById);

module.exports = router;
