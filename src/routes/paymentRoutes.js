const express = require('express');
const controller = require('../controllers/paymentController');

const router = express.Router();

router.route('/plans')
  .get(controller.paymentPlans.list)
  .post(controller.createPaymentPlan);

router.route('/plans/:id')
  .get(controller.paymentPlans.getById)
  .patch(controller.updatePaymentPlan)
  .delete(controller.paymentPlans.remove);

router.post('/plans/:id/payments', controller.applyPaymentToPlan);

router.patch('/plans/:id/pause', controller.pausePlan);
router.patch('/plans/:id/resume', controller.resumePlan);
router.patch('/plans/:id/cancel', controller.cancelPlan);
router.patch('/plans/:id/installments/:index/skip', controller.skipInstallment);

// Stats and export routes MUST be before /:id to avoid Express param collision
router.get('/stats', controller.getStats);
router.get('/export', controller.exportCsv);

router.route('/')
  .get(controller.payments.list)
  .post(controller.createPayment);

router.route('/:id')
  .get(controller.payments.getById)
  .patch(controller.payments.update)
  .delete(controller.payments.remove);

module.exports = router;
