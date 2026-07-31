const asyncHandler = require('../utils/asyncHandler');
const AppError = require('../utils/AppError');
const {
  verifySquareWebhookSignature,
  handleSquarePaymentEvent,
} = require('../services/webhookService');

// Square signs `notificationUrl + rawBody`, where notificationUrl is exactly the URL
// registered on the subscription. SQUARE_WEBHOOK_URL pins it; otherwise fall back to the
// backend's public base URL. APP_BASE_URL is the frontend base elsewhere, so it is a last resort.
const resolveWebhookUrl = (req) => {
  if (process.env.SQUARE_WEBHOOK_URL) {
    return process.env.SQUARE_WEBHOOK_URL;
  }

  const base = (
    process.env.API_PUBLIC_URL ||
    process.env.BACKEND_URL ||
    process.env.APP_BASE_URL ||
    'http://localhost:5000'
  ).replace(/\/$/, '');

  return `${base}${req.originalUrl}`;
};

const squarePaymentsWebhook = asyncHandler(async (req, res) => {
  const rawBody = req.body?.toString('utf8') || '';
  const signature = req.headers['x-square-hmacsha256-signature'];
  const legacySignature = req.headers['x-square-signature'];
  const webhookUrl = resolveWebhookUrl(req);

  if (!rawBody) {
    throw new AppError('Empty Square webhook payload', 400);
  }

  verifySquareWebhookSignature({ rawBody, signature, legacySignature, webhookUrl });

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
