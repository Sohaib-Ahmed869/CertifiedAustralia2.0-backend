const crypto = require('crypto');
const AppError = require('../utils/AppError');
const Payment = require('../models/Payment');

const verifySquareWebhookSignature = ({ rawBody, signature, webhookUrl }) => {
  const secret = process.env.SQUARE_WEBHOOK_SIGNATURE_KEY;

  if (!secret) {
    throw new AppError('SQUARE_WEBHOOK_SIGNATURE_KEY is not configured', 500);
  }

  if (!signature) {
    throw new AppError('Missing Square webhook signature', 401);
  }

  const expectedSignature = crypto
    .createHmac('sha1', secret)
    .update(webhookUrl + rawBody)
    .digest('base64');

  const expectedBuffer = Buffer.from(expectedSignature);
  const providedBuffer = Buffer.from(signature);

  if (
    expectedBuffer.length !== providedBuffer.length ||
    !crypto.timingSafeEqual(expectedBuffer, providedBuffer)
  ) {
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
