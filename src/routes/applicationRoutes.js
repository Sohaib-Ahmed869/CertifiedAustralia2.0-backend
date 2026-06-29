const express = require('express');
const controller = require('../controllers/applicationController');
const docController = require('../controllers/documentController');
const upload = require('../middleware/upload');
const { protect } = require('../middleware/auth');

const router = express.Router();

router.use(protect);

router.route('/')
  .get(controller.applications.list)
  .post(controller.createApplication);

// Stats, export and search routes MUST be before /:id to avoid Express param collision
router.get('/stats', controller.getStats);
router.get('/export', controller.exportCsv);
router.get('/notes/search', controller.searchNotes);

// Optimized student detail — full app + lightweight siblings
router.get('/student/:studentId/detail/:id', controller.getStudentDetail);

router.route('/:id')
  .get(controller.getApplication)
  .patch(controller.updateApplication)
  .delete(controller.deleteApplication);

router.patch('/:id/assign-agent', controller.assignAgent);
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
