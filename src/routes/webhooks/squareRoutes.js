const express = require('express');
const controller = require('../../controllers/webhookController');

const router = express.Router();

router.post(
  '/payments',
  express.raw({ type: 'application/json' }),
  controller.squarePaymentsWebhook
);

module.exports = router;
