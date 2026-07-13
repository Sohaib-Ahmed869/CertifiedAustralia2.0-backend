/**
 * smsService — send SMS via the Twilio REST API using the built-in fetch
 * (no SDK dependency). Configured through env:
 *   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER
 */

const isConfigured = () =>
  !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_PHONE_NUMBER);

async function sendSms(to, body) {
  if (!isConfigured()) {
    throw new Error('SMS is not configured (missing TWILIO_* env vars)');
  }
  if (!to) throw new Error('SMS recipient is required');

  const sid = process.env.TWILIO_ACCOUNT_SID;
  const auth = Buffer.from(`${sid}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64');
  const url = `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`;

  const params = new URLSearchParams({
    To: to,
    From: process.env.TWILIO_PHONE_NUMBER,
    Body: body,
  });

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params.toString(),
  });

  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json())?.message || ''; } catch { /* ignore */ }
    throw new Error(`Twilio send failed (${res.status})${detail ? `: ${detail}` : ''}`);
  }
  return res.json();
}

module.exports = { sendSms, isConfigured };
