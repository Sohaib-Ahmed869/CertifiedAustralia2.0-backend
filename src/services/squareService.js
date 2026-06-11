const AppError = require('../utils/AppError');

const squareBaseUrl = () => {
  return process.env.SQUARE_ENV === 'production'
    ? 'https://connect.squareup.com'
    : 'https://connect.squareupsandbox.com';
};

const createSquarePayment = async ({ amount, sourceId, idempotencyKey, note }) => {
  const accessToken = process.env.SQUARE_ACCESS_TOKEN;
  const locationId = process.env.SQUARE_LOCATION_ID;

  if (!accessToken || !locationId) {
    throw new AppError('Square credentials are not configured', 500);
  }

  const response = await fetch(`${squareBaseUrl()}/v2/payments`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      source_id: sourceId,
      idempotency_key: idempotencyKey,
      location_id: locationId,
      amount_money: {
        amount: Math.round(Number(amount) * 100),
        currency: process.env.SQUARE_ENV === 'production' ? 'AUD' : 'USD',
      },
      note,
    }),
  });

  const payload = await response.json();

  if (!response.ok) {
    throw new AppError(payload?.errors?.[0]?.detail || 'Square payment failed', 400);
  }

  return payload.payment;
};

module.exports = {
  createSquarePayment,
};
