const AppError = require('../utils/AppError');

// Pinned so a future Square default-version bump can't silently change the
// payment-link response shape (we depend on `order_id` being present).
const SQUARE_API_VERSION = '2025-01-23';

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

/**
 * SQUARE PAYMENT LINKS (hosted checkout) — used by the "send a payment link to
 * the student" flow. Separate from `createSquarePayment` above, which charges a
 * card the portal already holds; here Square hosts the page and WE never see
 * the card.
 *
 * Currency follows the same environment rule as `createSquarePayment`: the
 * sandbox test location is US-based and rejects AUD, so sandbox links really do
 * charge USD. Only production charges AUD. Keep the two in step — a link priced
 * in a currency the location doesn't accept fails at creation, not at checkout.
 */
const squareCurrency = () => (process.env.SQUARE_ENV === 'production' ? 'AUD' : 'USD');

const squareCredentials = () => {
  const accessToken = process.env.SQUARE_ACCESS_TOKEN;
  const locationId = process.env.SQUARE_LOCATION_ID;

  if (!accessToken || !locationId) {
    throw new AppError('Square credentials are not configured', 500);
  }

  return { accessToken, locationId };
};

/**
 * Create a hosted Square checkout link.
 *
 * `quick_pay` is used rather than a full catalog order: the portal is the source
 * of truth for what is owed, so the link only needs a name, an amount and a
 * location.
 *
 * Returns the raw Square `payment_link`. The caller MUST persist `order_id` —
 * it is the only field that ties the eventual webhook payment back to the link
 * (we never create the charge ourselves, so its payment id is unknown to us).
 *
 * @param {{ amount: number, name: string, idempotencyKey: string,
 *           buyerEmail?: string, note?: string, redirectUrl?: string,
 *           expiresAt?: Date|string }} params
 */
const createSquarePaymentLink = async ({
  amount,
  name,
  idempotencyKey,
  buyerEmail,
  note,
  redirectUrl,
  expiresAt,
}) => {
  const { accessToken, locationId } = squareCredentials();

  const checkoutOptions = {
    // Square's own confirmation page is a dead end for the student, so send
    // them back to the portal when the caller supplies a destination.
    ...(redirectUrl ? { redirect_url: redirectUrl } : {}),
    ask_for_shipping_address: false,
  };

  const body = {
    idempotency_key: idempotencyKey,
    quick_pay: {
      name: (name || 'Course Payment').slice(0, 255),
      price_money: {
        amount: Math.round(Number(amount) * 100),
        currency: squareCurrency(),
      },
      location_id: locationId,
    },
    checkout_options: checkoutOptions,
    ...(buyerEmail ? { pre_populated_data: { buyer_email: buyerEmail } } : {}),
    ...(note ? { payment_note: String(note).slice(0, 500) } : {}),
    // Square expires the checkout itself, so a link cannot be paid after the
    // portal has stopped counting on it. RFC 3339.
    ...(expiresAt ? { payment_link_expires_at: new Date(expiresAt).toISOString() } : {}),
  };

  const response = await fetch(`${squareBaseUrl()}/v2/online-checkout/payment-links`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      'Square-Version': SQUARE_API_VERSION,
    },
    body: JSON.stringify(body),
  });

  const payload = await response.json();

  if (!response.ok) {
    throw new AppError(
      payload?.errors?.[0]?.detail || 'Square could not create the payment link',
      400
    );
  }

  return payload.payment_link;
};

/**
 * Delete a payment link at Square so the URL stops accepting payment.
 *
 * NON-FATAL BY CONTRACT: returns `false` instead of throwing. Cancelling in the
 * portal must always succeed — if Square is unreachable, the portal has still
 * stopped expecting the money, and a late payment would arrive as an unmatched
 * webhook rather than silently settling a cancelled request.
 */
const deleteSquarePaymentLink = async (paymentLinkId) => {
  if (!paymentLinkId) return false;

  try {
    const { accessToken } = squareCredentials();
    const response = await fetch(
      `${squareBaseUrl()}/v2/online-checkout/payment-links/${paymentLinkId}`,
      {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Square-Version': SQUARE_API_VERSION,
        },
      }
    );
    return response.ok;
  } catch (err) {
    console.error('[squareService] deleteSquarePaymentLink error:', err.message);
    return false;
  }
};

module.exports = {
  createSquarePayment,
  createSquarePaymentLink,
  deleteSquarePaymentLink,
  squareCurrency,
};
