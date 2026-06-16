const express = require('express');
const controller = require('../controllers/dynamicFormController');
const { protect, authorize } = require('../middleware/auth');

const router = express.Router();

router.use(protect);

// --- Form definitions ---

// List forms by qualification (before /:id to avoid param collision)
router.get('/by-qualification/:qualId', controller.listByQualification);

router
  .route('/')
  .get(controller.list)
  .post(authorize('Admin', 'CEOReportingManager'), controller.create);

router
  .route('/:id')
  .get(controller.getById)
  .patch(authorize('Admin', 'CEOReportingManager'), controller.update)
  .delete(authorize('Admin', 'CEOReportingManager'), controller.remove);

router.post(
  '/:id/duplicate',
  authorize('Admin', 'CEOReportingManager'),
  controller.duplicateForm
);

router.post(
  '/:id/assign',
  authorize('Admin', 'CEOReportingManager'),
  controller.assignToQualifications
);

router.delete(
  '/:id/qualifications/:qualId',
  authorize('Admin', 'CEOReportingManager'),
  controller.detachFromQualification
);

// --- Form Submissions ---

router.get('/submissions/by-application/:appId', controller.listSubmissionsByApplication);

router
  .route('/submissions')
  .get(controller.listSubmissions)
  .post(controller.createSubmission);

router
  .route('/submissions/:id')
  .get(controller.getSubmission)
  .patch(controller.updateSubmission)
  .delete(authorize('Admin', 'CEOReportingManager'), controller.removeSubmission);

router.patch(
  '/submissions/:id/review',
  authorize('Admin', 'CEOReportingManager', 'InternalRTO'),
  controller.reviewSubmission
);

module.exports = router;
