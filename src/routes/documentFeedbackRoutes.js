const express = require('express');
const { protect, authorize } = require('../middleware/auth');
const controller = require('../controllers/documentFeedbackController');

const router = express.Router();

// All routes require authentication
router.use(protect);

/* ── Student endpoints — declared first to avoid /:id collision ── */
router.get('/student/application/:applicationId', authorize('Student'), controller.listForStudent);
router.post('/student/:id/reply', authorize('Student'), controller.studentReply);
router.post('/student/:id/complete', authorize('Student'), controller.studentMarkComplete);

/* ── RTO endpoints ── */
router.get('/rto/application/:applicationId', authorize('InternalRTO'), controller.listForRto);
router.post('/rto/application/:applicationId', authorize('InternalRTO'), controller.createRtoFeedback);
router.patch('/rto/:id/reply', authorize('InternalRTO'), controller.rtoReply);
router.post('/rto/:id/resolve', authorize('InternalRTO'), controller.rtoResolve);
router.post('/rto/:id/reject-resolution', authorize('InternalRTO'), controller.rtoRejectResolution);

/* ── Admin/Agent endpoints ── */
const adminRoles = ['Admin', 'CEOReportingManager', 'Agent'];
router.get('/application/:applicationId', authorize(...adminRoles), controller.listForApplication);
router.get('/application/:applicationId/admin-direct', authorize(...adminRoles), controller.listAdminDirect);
router.get('/application/:applicationId/stats', authorize(...adminRoles), controller.getStats);
router.post('/application/:applicationId', authorize(...adminRoles), controller.createAdminFeedback);
router.patch('/:id/reply', authorize(...adminRoles), controller.adminReply);
router.post('/:id/forward', authorize(...adminRoles), controller.forwardToStudent);
router.post('/:id/approve-resolution', authorize(...adminRoles), controller.approveResolution);
router.post('/:id/reject-resolution', authorize(...adminRoles), controller.rejectResolution);
router.post('/:id/resolve', authorize(...adminRoles), controller.resolveAdminDirect);

module.exports = router;
