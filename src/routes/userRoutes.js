const express = require('express');
const controller = require('../controllers/userController');
const { protect, authorize } = require('../middleware/auth');

const router = express.Router();

// User management is staff-only — students never enumerate or mutate user records.
router.use(protect);
router.use(authorize('Admin', 'CEOReportingManager', 'Agent', 'InternalRTO', 'ExternalRTO', 'Support', 'Marketing'));

router.route('/')
  .get(controller.list)
  .post(controller.create);

router.route('/:id')
  .get(controller.getById)
  .patch(controller.update)
  .delete(controller.remove);

module.exports = router;
