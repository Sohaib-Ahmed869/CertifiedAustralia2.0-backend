const express = require('express');
const controller = require('../controllers/applicationController');
const docController = require('../controllers/documentController');
const upload = require('../middleware/upload');

const router = express.Router();

router.route('/')
  .get(controller.applications.list)
  .post(controller.createApplication);

// Stats and export routes MUST be before /:id to avoid Express param collision
router.get('/stats', controller.getStats);
router.get('/export', controller.exportCsv);

router.route('/:id')
  .get(controller.getApplication)
  .patch(controller.updateApplication)
  .delete(controller.deleteApplication);

router.patch('/:id/assign-agent', controller.assignAgent);
router.patch('/:id/assign-rto', controller.assignRTO);
router.post('/:id/send-to-rto-portal', controller.sendToRTOPortal);
router.post('/:id/rto-submission', controller.sendRTOSubmission);
router.patch('/:id/status', controller.updateStatus);
router.post('/:id/notes', controller.addNote);
router.post('/:id/discounts', controller.addDiscount);
router.delete('/:id/discounts/:discountId', controller.removeDiscount);
router.post('/:id/calls', controller.logCall);

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

// Document review (RTO/Admin feedback on individual documents)
router.patch('/:id/documents/:docId/review', controller.reviewDocument);

// 21-day timer management (pause/resume/start)
router.patch('/:id/timer', controller.updateTimer);

module.exports = router;
