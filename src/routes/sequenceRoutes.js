const express = require('express');
const controller = require('../controllers/sequenceController');
const { protect, authorize } = require('../middleware/auth');

const router = express.Router();

router.use(protect);
router.use(authorize('Admin', 'CEOReportingManager'));

// Static routes BEFORE /:id to avoid Express param collision.
router.get('/stats', controller.getSequenceStats);
router.post('/audience-count', controller.getAudienceCount);

router.route('/')
  .get(controller.getSequences)
  .post(controller.createSequence);

router.route('/:id')
  .get(controller.getSequenceById)
  .patch(controller.updateSequence)
  .delete(controller.deleteSequence);

router.get('/:id/enrollments', controller.getSequenceEnrollments);
router.post('/:id/duplicate', controller.duplicateSequence);
router.post('/:id/start', controller.startSequence);
router.post('/:id/pause', controller.pauseSequence);
router.post('/:id/resume', controller.resumeSequence);
router.post('/:id/cancel', controller.cancelSequence);
router.post('/:id/run-now', controller.runSequenceNow);

module.exports = router;
