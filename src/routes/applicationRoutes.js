const express = require('express');
const controller = require('../controllers/applicationController');
const docController = require('../controllers/documentController');
const upload = require('../middleware/upload');
const { protect, authorize } = require('../middleware/auth');
const AppError = require('../utils/AppError');
const Application = require('../models/Application');

const router = express.Router();

router.use(protect);

// Ownership guard: a Student may only act on their OWN application on any `:id` route
// (get, update, delete, notes, documents, status, certificate, etc.).
// NOTE: router.param callbacks take a 4th `value` arg — must NOT be wrapped in
// asyncHandler (which only forwards req/res/next), so we handle the promise inline.
router.param('id', (req, res, next, id) => {
  if (req.user.role !== 'Student') return next();
  Application.findById(id).select('studentId').lean()
    .then((app) => {
      if (!app) return next(new AppError('Application not found', 404));
      if (String(app.studentId) !== String(req.user._id)) {
        return next(new AppError('Not authorized to access this application', 403));
      }
      next();
    })
    .catch(next);
});

// Ownership guard: a Student may only request their own studentId (e.g. detail route).
router.param('studentId', (req, res, next, studentId) => {
  if (req.user.role === 'Student' && String(studentId) !== String(req.user._id)) {
    return next(new AppError('Not authorized to access this student', 403));
  }
  next();
});

router.route('/')
  .get(controller.listApplications)
  .post(controller.createApplication);

// Stats, export and search routes MUST be before /:id to avoid Express param collision
router.get('/stats', controller.getStats);
router.get('/export', controller.exportCsv);

// Admin forecast-aware list + scoped CSV export (staff only)
const STAFF_ROLES = ['Admin', 'CEOReportingManager', 'Agent', 'Marketing'];
router.get('/admin-list', authorize(...STAFF_ROLES), controller.adminList);
router.get('/admin-export', authorize(...STAFF_ROLES), controller.adminExportCsv);
router.get('/notes/search', controller.searchNotes);

// Optimized student detail — full app + lightweight siblings
router.get('/student/:studentId/detail/:id', controller.getStudentDetail);

router.route('/:id')
  .get(controller.getApplication)
  .patch(controller.updateApplication)
  .delete(controller.deleteApplication);

router.patch('/:id/assign-agent', controller.assignAgent);
router.patch('/:id/source', controller.updateSource);
router.patch('/:id/lead-status', controller.updateLeadStatus);
router.patch('/:id/assign-rto', controller.assignRTO);
router.post('/:id/send-to-rto-portal', controller.sendToRTOPortal);
router.post('/:id/rto-submission', controller.sendRTOSubmission);
router.patch('/:id/status', controller.updateStatus);
router.patch('/:id/restore', controller.restoreFromArchive);
router.post('/:id/notes', controller.addNote);
router.patch('/:id/notes/:noteId', controller.editNote);
router.delete('/:id/notes/:noteId', controller.deleteNote);
router.post('/:id/discounts', controller.addDiscount);
router.delete('/:id/discounts/:discountId', controller.removeDiscount);
router.post('/:id/calls', controller.logCall);

// Additional document requests (CA-08 gated upload)
router.post('/:id/additional-doc-requests', controller.createAdditionalDocRequest);
router.patch('/:id/additional-doc-requests/:requestId/submit', controller.submitAdditionalDocs);
router.patch('/:id/additional-doc-requests/:requestId/review', controller.reviewAdditionalDocs);

// RTO submission versioning
router.post('/:id/rto-submissions', controller.createRTOSubmission);

router.route('/:id/intake')
  .post(controller.createIntakeForm);

router.route('/:id/intake/:formId')
  .patch(controller.updateIntakeForm);

router.route('/:id/screening')
  .post(controller.createScreeningForm);

router.route('/:id/screening/:formId')
  .patch(controller.updateScreeningForm);

/* ── Document upload endpoints ── */
router.get('/:id/documents', docController.listDocuments);
router.post('/:id/documents/upload', upload.single('file'), docController.uploadSingle);
router.post('/:id/documents/upload-multiple', upload.array('files', 20), docController.uploadMultiple);
router.delete('/:id/documents/:docId', docController.deleteDocument);

router.put('/:id/certificate', upload.single('certificate'), controller.uploadCertificate);
router.post('/:id/certificate/:certId/notify-soft-copy', controller.notifySoftCopy);
router.post('/:id/certificate/:certId/dispatch-hard-copy', controller.dispatchHardCopy);
router.post('/:id/certificate/:certId/mark-delivered', controller.markCertificateDelivered);

// Dynamic forms
router.post('/:id/toggle-dynamic-forms', controller.toggleDynamicForms);
router.get('/:id/available-forms', controller.getAvailableForms);

// Follow-up calls
router.post('/:id/follow-ups', controller.addFollowUp);
router.patch('/:id/follow-ups/:followUpId/complete', controller.completeFollowUp);
router.delete('/:id/follow-ups/:followUpId', controller.deleteFollowUp);

// Post-certification form email
router.post('/:id/send-post-cert-form', controller.sendPostCertForm);

// Reference letter template email
router.post('/:id/send-ref-letter-template', controller.sendRefLetterTemplate);
router.post('/:id/request-ref-letter-template', controller.requestRefLetterTemplate);

// Resend context-based application email
router.post('/:id/resend-email', controller.resendEmail);

// Predefined email templates
router.post('/:id/send-predefined-email', controller.sendPredefinedEmail);

// RTO activity logging
router.post('/:id/rto-activity', controller.logRTOActivity);

// Document review (RTO/Admin feedback on individual documents)
router.patch('/:id/documents/:docId/review', controller.reviewDocument);

// 21-day timer status (read-only — timer is automatic, no manual pause/resume)
router.get('/:id/timer', controller.getTimerStatus);

module.exports = router;
