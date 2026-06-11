const asyncHandler = require('../utils/asyncHandler');
const AppError = require('../utils/AppError');
const {
  verifySquareWebhookSignature,
  handleSquarePaymentEvent,
} = require('../services/webhookService');

const squarePaymentsWebhook = asyncHandler(async (req, res) => {
  const rawBody = req.body?.toString('utf8') || '';
  const signature = req.headers['x-square-signature'];
  const webhookUrl = `${process.env.APP_BASE_URL || 'http://localhost:5000'}${req.originalUrl}`;

  if (!rawBody) {
    throw new AppError('Empty Square webhook payload', 400);
  }

  verifySquareWebhookSignature({ rawBody, signature, webhookUrl });

  const payload = JSON.parse(rawBody);
  const result = await handleSquarePaymentEvent(payload);

  res.status(200).json({
    received: true,
    ...result,
  });
});

module.exports = {
  squarePaymentsWebhook,
};
