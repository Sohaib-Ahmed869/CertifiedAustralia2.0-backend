const express = require('express');
const controller = require('../controllers/paymentLinkController');
const { protect, authorize } = require('../middleware/auth');

const router = express.Router();

router.use(protect);

// Same staff set that may record a payment by hand — raising a payment request
// is the same act of collection, just delivered by email.
const staff = authorize('Admin', 'CEOReportingManager', 'Agent');

// Literal sub-paths BEFORE '/:id', or Express matches "balance" as an id.
router.get('/balance/:applicationId', controller.getBalance);

router.route('/')
  // Student-scoped inside the controller.
  .get(controller.list)
  .post(staff, controller.create);

router.post('/:id/resend', staff, controller.resend);
router.post('/:id/cancel', staff, controller.cancel);

router.get('/:id', controller.getById);

module.exports = router;
