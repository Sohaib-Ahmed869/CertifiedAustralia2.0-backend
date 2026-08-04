/**
 * twilioVoiceService — low-level Twilio Voice primitives (no DB, no sockets).
 *
 * Covers everything the call-burst / softphone feature needs from Twilio:
 *   • REST client + config guards
 *   • browser Voice SDK access tokens (VoiceGrant → TwiML App)
 *   • TwiML builders for the agent leg and the student legs (conference bridge)
 *   • placing an outbound call to a student and hanging one up
 *   • X-Twilio-Signature webhook validation
 *
 * Env (SID/token/number already used by smsService):
 *   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER
 *   TWILIO_API_KEY_SID, TWILIO_API_KEY_SECRET   — for browser access tokens
 *   TWILIO_TWIML_APP_SID                        — the browser's outgoing app
 *   API_PUBLIC_URL                              — public backend base for webhooks
 */

const twilio = require('twilio');

/* ── Config guards ─────────────────────────────────────────── */

// Enough to place/hang up PSTN calls.
const isConfigured = () =>
  !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_PHONE_NUMBER);

// Additionally required for the in-browser softphone (access tokens).
const isBrowserConfigured = () =>
  isConfigured() &&
  !!(process.env.TWILIO_API_KEY_SID && process.env.TWILIO_API_KEY_SECRET && process.env.TWILIO_TWIML_APP_SID);

let _client = null;
const getClient = () => {
  if (!isConfigured()) throw new Error('Twilio is not configured (missing TWILIO_* env vars)');
  if (!_client) {
    // Region-homed accounts (e.g. au1) reject REST calls on the default us1 host,
    // so target the region. Do NOT set an edge for REST: region+edge together build
    // a host like api.sydney.au1.twilio.com that this account rejects (20003).
    // WARNING: the Twilio SDK also auto-reads TWILIO_REGION/TWILIO_EDGE from the
    // environment, so TWILIO_EDGE must NOT be present in .env or it re-poisons this
    // client. The media edge lives in TWILIO_DEVICE_EDGE (read in createAccessToken).
    const opts = {};
    if (process.env.TWILIO_REGION) opts.region = process.env.TWILIO_REGION;
    _client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN, opts);
  }
  return _client;
};

// Public base URL Twilio uses to reach our webhooks (no trailing slash).
const publicBase = () =>
  (process.env.API_PUBLIC_URL || 'http://localhost:5000').replace(/\/+$/, '');

const webhook = (path) => `${publicBase()}/api/webhooks/twilio${path}`;

/* ── Browser access token ──────────────────────────────────── */

/**
 * Mint a Voice access token for the agent's browser Device.
 * identity uniquely maps the WebRTC endpoint back to the user.
 */
function createAccessToken(identity) {
  if (!isBrowserConfigured()) {
    throw new Error('Twilio browser voice is not configured (missing API key / TwiML app)');
  }
  const AccessToken = twilio.jwt.AccessToken;
  const VoiceGrant = AccessToken.VoiceGrant;

  const token = new AccessToken(
    process.env.TWILIO_ACCOUNT_SID,
    process.env.TWILIO_API_KEY_SID,
    process.env.TWILIO_API_KEY_SECRET,
    { identity, ttl: 3600 }
  );
  token.addGrant(
    new VoiceGrant({
      outgoingApplicationSid: process.env.TWILIO_TWIML_APP_SID,
      // Allow the browser Device to RECEIVE calls too. Inbound PSTN calls landing
      // on a user's allotted number are bridged to their client via <Dial><Client>
      // targeting this same `agent:<userId>` identity (see dialClientTwiml).
      incomingAllow: true,
    })
  );
  // Region-bound (e.g. au1) API keys only validate at their own edge. The browser
  // Device must connect to that edge or Twilio returns 20101 AccessTokenInvalid.
  // NB: this is read from TWILIO_DEVICE_EDGE, *not* TWILIO_EDGE — the Twilio Node
  // SDK auto-reads TWILIO_EDGE from process.env and combines it with TWILIO_REGION
  // for REST, producing an invalid host (api.sydney.au1.twilio.com → 20003) that
  // breaks outbound dialing. Keep the media edge in a var the SDK does not claim.
  const edge = process.env.TWILIO_DEVICE_EDGE || null;
  return { token: token.toJwt(), identity, expiresIn: 3600, edge };
}

/* ── TwiML builders ────────────────────────────────────────── */

/**
 * Agent leg — the browser softphone joins the conference and holds it open.
 * endConferenceOnExit: when the agent hangs up, the whole call tears down.
 */
function agentConferenceTwiml(conferenceName) {
  const res = new twilio.twiml.VoiceResponse();
  const dial = res.dial();
  dial.conference(
    {
      startConferenceOnEnter: true,
      endConferenceOnExit: true,
      // Silence Twilio's default hold music while waiting for a recipient.
      waitUrl: '',
      statusCallback: webhook('/conference'),
      statusCallbackEvent: 'start end join leave',
    },
    conferenceName
  );
  return res.toString();
}

/**
 * Student leg — CONNECT ON ANSWER. Whoever picks up first is dropped straight
 * into the conference with the agent (no press-1, no AMD gating). Voicemails
 * don't answer, so they never win. Losers are hung up by the winner-lock.
 */
function studentConferenceTwiml(conferenceName) {
  const res = new twilio.twiml.VoiceResponse();
  const dial = res.dial();
  dial.conference(
    {
      startConferenceOnEnter: true,
      endConferenceOnExit: false,
      statusCallback: webhook('/conference'),
      statusCallbackEvent: 'join leave',
    },
    conferenceName
  );
  return res.toString();
}

/* ── Inbound TwiML builders ────────────────────────────────── */

/**
 * Bridge an inbound PSTN call to the assigned user's browser softphone.
 * `answerOnBridge` keeps the caller hearing ringback (not a premature "answer")
 * until the agent actually picks up. Caller context is passed as <Client>
 * parameters so the browser's incoming-call modal can show who's calling; if
 * the agent doesn't answer within `timeout`, Twilio requests the `action` URL
 * which routes the caller to voicemail.
 */
function dialClientTwiml({ userId, callerNumber, contactName, displayApplicationId, timeout = 25 }) {
  const res = new twilio.twiml.VoiceResponse();
  const dial = res.dial({
    answerOnBridge: true,
    timeout,
    action: webhook('/voice/inbound/action'),
    method: 'POST',
  });
  const client = dial.client();
  client.identity(`agent:${userId}`);
  client.parameter({ name: 'direction', value: 'inbound' });
  client.parameter({ name: 'from', value: callerNumber || '' });
  client.parameter({ name: 'contactName', value: contactName || '' });
  client.parameter({ name: 'appId', value: displayApplicationId || '' });
  return res.toString();
}

/**
 * Voicemail capture — played when an inbound call goes unanswered (or lands on
 * a number nobody is assigned to). Records up to 2 minutes, then POSTs the
 * recording to the voicemail webhook.
 */
function voicemailTwiml({ greeting } = {}) {
  const res = new twilio.twiml.VoiceResponse();
  res.say(
    { voice: 'alice' },
    greeting ||
      'Sorry, we are unable to take your call right now. Please leave a message after the tone, and we will get back to you.'
  );
  res.record({
    maxLength: 120,
    playBeep: true,
    timeout: 5,
    finishOnKey: '#',
    action: webhook('/voice/inbound/voicemail'),
    method: 'POST',
  });
  // Reached only if the caller left no recording (immediate hangup / silence).
  res.say({ voice: 'alice' }, 'We did not receive a message. Goodbye.');
  res.hangup();
  return res.toString();
}

/* ── Outbound calls ────────────────────────────────────────── */

/**
 * Place one outbound call to a recipient's phone. On answer, Twilio fetches
 * the student voice webhook which returns studentConferenceTwiml.
 * `from` is the initiating agent's allotted caller ID (falls back to the global
 * TWILIO_PHONE_NUMBER). `timeout` bounds the ring; unanswered legs → no-answer.
 */
async function callStudent({ to, burstId, from, timeout = 30 }) {
  const call = await getClient().calls.create({
    to,
    from: from || process.env.TWILIO_PHONE_NUMBER,
    url: webhook(`/voice/student?burstId=${encodeURIComponent(burstId)}`),
    method: 'POST',
    timeout,
    statusCallback: webhook(`/status?burstId=${encodeURIComponent(burstId)}`),
    statusCallbackMethod: 'POST',
    statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
  });
  return call.sid;
}

/** Hang up a call leg (used to drop the losing recipients). */
async function endCall(callSid) {
  if (!callSid) return;
  try {
    await getClient().calls(callSid).update({ status: 'completed' });
  } catch (err) {
    // Already ended / not found — nothing to drop.
    if (err && err.status !== 404) console.warn(`[twilio] endCall ${callSid}: ${err.message}`);
  }
}

/* ── Webhook signature validation ──────────────────────────── */

/**
 * Validate an incoming Twilio webhook via X-Twilio-Signature.
 * The signed URL must be the exact public URL Twilio requested (query string
 * included), so we rebuild it from API_PUBLIC_URL + originalUrl.
 */
function validateSignature(req) {
  if (process.env.TWILIO_SKIP_SIGNATURE === '1') return true; // dev/tunnel escape hatch
  const signature = req.headers['x-twilio-signature'];
  if (!signature) return false;
  const url = `${publicBase()}${req.originalUrl}`;
  return twilio.validateRequest(process.env.TWILIO_AUTH_TOKEN, signature, url, req.body || {});
}

module.exports = {
  isConfigured,
  isBrowserConfigured,
  getClient,
  createAccessToken,
  agentConferenceTwiml,
  studentConferenceTwiml,
  dialClientTwiml,
  voicemailTwiml,
  callStudent,
  endCall,
  validateSignature,
  webhook,
  publicBase,
};
