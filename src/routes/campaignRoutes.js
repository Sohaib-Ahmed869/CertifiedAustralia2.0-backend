const express = require('express');
const controller = require('../controllers/campaignController');
const { protect, authorize } = require('../middleware/auth');

const router = express.Router();

router.use(protect);
router.use(authorize('Admin', 'CEOReportingManager'));

// Stats + bounce check + audience preview BEFORE /:id to avoid Express param collision
router.get('/stats', controller.getStats);
router.post('/check-bounces', controller.checkBounces);
router.post('/audience-count', controller.getAudienceCount);

router.route('/')
  .get(controller.list)
  .post(controller.createCampaign);

router.route('/:id')
  .get(controller.getById)
  .patch(controller.update)
  .delete(controller.remove);

router.get('/:id/recipients', controller.getRecipients);
router.post('/:id/send', controller.send);
router.post('/:id/schedule', controller.schedule);
router.post('/:id/cancel-schedule', controller.cancelSchedule);
router.post('/:id/pause', controller.pause);
router.post('/:id/resume', controller.resume);
router.post('/:id/check-bounces', controller.checkBounces);

module.exports = router;
