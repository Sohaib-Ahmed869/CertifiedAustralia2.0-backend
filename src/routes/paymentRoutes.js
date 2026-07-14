const express = require('express');
const controller = require('../controllers/paymentController');
const { protect, authorize } = require('../middleware/auth');

const router = express.Router();

// All payment endpoints require authentication.
router.use(protect);

// Plan management, stats, deletion and edits are staff-only.
// Students get read-only access (scoped to their own records) plus the ability
// to record a payment for their own application via POST '/'.
const staff = authorize('Admin', 'CEOReportingManager', 'Agent');

router.route('/plans')
  .get(controller.listPaymentPlans)
  .post(staff, controller.createPaymentPlan);

router.route('/plans/:id')
  .get(controller.getPaymentPlanById)
  .patch(staff, controller.updatePaymentPlan)
  .delete(staff, controller.paymentPlans.remove);

router.post('/plans/:id/payments', staff, controller.applyPaymentToPlan);

router.patch('/plans/:id/pause', staff, controller.pausePlan);
router.patch('/plans/:id/resume', staff, controller.resumePlan);
router.patch('/plans/:id/cancel', staff, controller.cancelPlan);
router.patch('/plans/:id/installments/:index/skip', staff, controller.skipInstallment);

// Stats and export routes MUST be before /:id to avoid Express param collision
router.get('/stats', staff, controller.getStats);
router.get('/export', staff, controller.exportCsv);

router.route('/')
  .get(controller.listPayments)
  .post(controller.createPayment);

router.route('/:id')
  .get(controller.getPaymentById)
  .patch(staff, controller.payments.update)
  .delete(staff, controller.payments.remove);

module.exports = router;
