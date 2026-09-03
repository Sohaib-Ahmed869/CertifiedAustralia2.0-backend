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

// Literal sub-paths before nothing else here, but keep them grouped and after /:id —
// they don't collide because the method+path pair is distinct.
router.post('/:id/verify', controller.verify);
router.post('/:id/reconnect', controller.reconnect);

module.exports = router;
