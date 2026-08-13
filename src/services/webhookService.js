const crypto = require('crypto');
const AppError = require('../utils/AppError');
const Payment = require('../models/Payment');

const timingSafeCompare = (expected, provided) => {
  const expectedBuffer = Buffer.from(expected);
  const providedBuffer = Buffer.from(provided);

  return (
    expectedBuffer.length === providedBuffer.length &&
    crypto.timingSafeEqual(expectedBuffer, providedBuffer)
  );
};

const verifySquareWebhookSignature = ({
  rawBody,
  signature,
  legacySignature,
  webhookUrl,
}) => {
  const secret = process.env.SQUARE_WEBHOOK_SIGNATURE_KEY;

  if (!secret) {
    throw new AppError('SQUARE_WEBHOOK_SIGNATURE_KEY is not configured', 500);
  }

  if (!signature && !legacySignature) {
    throw new AppError('Missing Square webhook signature', 401);
  }

  const signedPayload = webhookUrl + rawBody;

  // Current Square subscriptions sign with HMAC-SHA256 (x-square-hmacsha256-signature).
  // Legacy subscriptions still send HMAC-SHA1 (x-square-signature).
  const algorithm = signature ? 'sha256' : 'sha1';
  const provided = signature || legacySignature;

  const expectedSignature = crypto
    .createHmac(algorithm, secret)
    .update(signedPayload)
    .digest('base64');

  if (!timingSafeCompare(expectedSignature, provided)) {
    // Square signs `notificationUrl + rawBody` using the SUBSCRIPTION's signature
    // key, so a mismatch is almost always config, not tampering: the URL we
    // rebuilt here differs from the one registered on the subscription, or the
    // key belongs to a different subscription (sandbox vs production, or
    // rotated). Log both sides — never the key itself — so the cause is visible
    // in the server log instead of guessable only from Square's failure email.
    console.warn(
      `[squareWebhook] signature mismatch (${algorithm}). ` +
        `Signed URL used: "${webhookUrl}" — this must match the subscription's ` +
        'Notification URL character for character (scheme, host, path, no trailing slash). ' +
        `Signature key fingerprint: ${crypto.createHash('sha256').update(secret).digest('hex').slice(0, 12)}`
    );
    throw new AppError('Invalid Square webhook signature', 401);
  }

  return true;
};

const handleSquarePaymentEvent = async (payload) => {
  const eventType = payload?.type;
  const payment = payload?.data?.object?.payment;

  if (!payment) {
    return { acknowledged: true, eventType };
  }

  const paymentRecord = await Payment.findOne({
    $or: [
      { squarePaymentId: payment.id },
      { squareTransactionId: payment.id },
    ],
  });

  if (!paymentRecord) {
    return { acknowledged: true, eventType, matchedPayment: false };
  }

  paymentRecord.squarePaymentId = payment.id;
  paymentRecord.squareTransactionId = payment.id;
  paymentRecord.status = payment.status === 'COMPLETED' ? 'completed' : paymentRecord.status;
  paymentRecord.xeroSyncStatus = paymentRecord.xeroSyncStatus || 'pending';
  paymentRecord.updatedAt = new Date();

  await paymentRecord.save();

  return { acknowledged: true, eventType, matchedPayment: true };
};

module.exports = {
  verifySquareWebhookSignature,
  handleSquarePaymentEvent,
};
