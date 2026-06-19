const express = require('express');
const controller = require('../controllers/campaignController');
const { protect, authorize } = require('../middleware/auth');

const router = express.Router();

router.use(protect);
router.use(authorize('Admin', 'CEOReportingManager'));

// Stats BEFORE /:id to avoid Express param collision
router.get('/stats', controller.getStats);

router.route('/')
  .get(controller.list)
  .post(controller.createCampaign);

router.route('/:id')
  .get(controller.getById)
  .patch(controller.update)
  .delete(controller.remove);

router.post('/:id/send', controller.send);
router.post('/:id/pause', controller.pause);
router.post('/:id/resume', controller.resume);

module.exports = router;
