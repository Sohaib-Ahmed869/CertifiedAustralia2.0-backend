const express = require('express');
const controller = require('../controllers/mailboxController');
const { protect, authorize } = require('../middleware/auth');

const router = express.Router();

router.use(protect);
router.use(authorize('Admin', 'CEOReportingManager'));

router.route('/')
  .get(controller.list)
  .post(controller.connect);

router.route('/:id')
  .get(controller.getById)
  .patch(controller.updateConfig)
  .delete(controller.disconnect);

router.post('/:id/verify', controller.verify);

module.exports = router;
