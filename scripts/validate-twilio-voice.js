/**
 * validate-twilio-voice.js — diagnose Twilio 20101 (AccessTokenInvalid).
 *
 * Verifies, using the exact env the app uses, that:
 *   1. API Key SID + Secret authenticate (HTTP basic) against the REST API
 *   2. The API Key actually belongs to TWILIO_ACCOUNT_SID (the #1 cause of 20101)
 *   3. The TwiML App SID exists under that account
 *   4. A freshly minted Voice token decodes with the expected iss/sub/grants
 *
 * Run from certfied-australia-v2-be/:
 *   node scripts/validate-twilio-voice.js
 */

require('dotenv').config();
const twilio = require('twilio');

const {
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_API_KEY_SID,
  TWILIO_API_KEY_SECRET,
  TWILIO_TWIML_APP_SID,
  TWILIO_REGION,
  TWILIO_EDGE,
} = process.env;

const mask = (v) => (v ? `${v.slice(0, 4)}…${v.slice(-2)} (len ${v.length})` : '(missing)');
const ok = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const bad = (m) => console.log(`  \x1b[31m✗ ${m}\x1b[0m`);
const info = (m) => console.log(`    ${m}`);

(async () => {
  console.log('\n── Twilio Voice credential check ─────────────────────────\n');
  console.log('  TWILIO_ACCOUNT_SID   :', mask(TWILIO_ACCOUNT_SID));
  console.log('  TWILIO_AUTH_TOKEN    :', mask(TWILIO_AUTH_TOKEN));
  console.log('  TWILIO_API_KEY_SID   :', mask(TWILIO_API_KEY_SID));
  console.log('  TWILIO_API_KEY_SECRET:', mask(TWILIO_API_KEY_SECRET));
  console.log('  TWILIO_TWIML_APP_SID :', mask(TWILIO_TWIML_APP_SID));
  console.log('  TWILIO_REGION        :', TWILIO_REGION || '(default us1)');
  console.log('  TWILIO_EDGE          :', TWILIO_EDGE || '(default)');
  console.log('');

  // Sanity: prefixes.
  if (!/^AC/.test(TWILIO_ACCOUNT_SID || '')) bad('ACCOUNT_SID should start with "AC"');
  if (!/^SK/.test(TWILIO_API_KEY_SID || '')) bad('API_KEY_SID should start with "SK"');
  if (!/^AP/.test(TWILIO_TWIML_APP_SID || '')) bad('TWIML_APP_SID should start with "AP"');

  // REST client: region only. region+edge together (e.g. au1+sydney) build a host
  // this account rejects with 20003 — the edge belongs on the browser Device, not REST.
  const regionOpts = {};
  if (TWILIO_REGION) regionOpts.region = TWILIO_REGION;

  /* 1 + 2. API key authenticates AND belongs to the account.
   * We auth AS the API key (username=SK…, password=secret) but scope the
   * request to TWILIO_ACCOUNT_SID. If the key belongs to a different account,
   * Twilio returns 20003/authenticate error → this is exactly the 20101 cause. */
  console.log('[1] API Key authenticates & belongs to the account…');
  try {
    const keyClient = twilio(TWILIO_API_KEY_SID, TWILIO_API_KEY_SECRET, {
      accountSid: TWILIO_ACCOUNT_SID,
      ...regionOpts,
    });
    const acct = await keyClient.api.v2010.accounts(TWILIO_ACCOUNT_SID).fetch();
    ok(`API Key is valid AND scoped to this account (${acct.friendlyName}, status: ${acct.status})`);
  } catch (e) {
    bad(`API Key could NOT authenticate against ${TWILIO_ACCOUNT_SID}`);
    info(`Twilio says: [${e.status || '?'}] code ${e.code || '?'} — ${e.message}`);
    info('→ This is the classic 20101 cause: the API Key belongs to a DIFFERENT');
    info('  account than TWILIO_ACCOUNT_SID, or the secret is wrong/rotated.');
    info('  Fix: recreate an API Key in the SAME account as TWILIO_ACCOUNT_SID');
    info('  (Console → Account → API keys & tokens) and update both env vars.');
  }

  /* Confirm the key resource is owned by the account (explicit ownership read). */
  console.log('\n[2] API Key resource is owned by the account…');
  try {
    const authClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, regionOpts);
    const key = await authClient.keys(TWILIO_API_KEY_SID).fetch();
    ok(`Account owns API Key "${key.friendlyName || TWILIO_API_KEY_SID}" (created ${key.dateCreated})`);
  } catch (e) {
    bad('This account does NOT own that API Key SID (or AUTH_TOKEN is wrong).');
    info(`Twilio says: [${e.status || '?'}] code ${e.code || '?'} — ${e.message}`);
    info('→ The SK… key must live under TWILIO_ACCOUNT_SID. It does not.');
  }

  /* 3. TwiML App exists under the account. */
  console.log('\n[3] TwiML App SID exists under the account…');
  try {
    const authClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, regionOpts);
    const app = await authClient.applications(TWILIO_TWIML_APP_SID).fetch();
    ok(`TwiML App found: "${app.friendlyName}"`);
    info(`voiceUrl: ${app.voiceUrl || '(none — Device.connect will fail after token OK)'}`);
  } catch (e) {
    bad('TwiML App SID not found in this account.');
    info(`Twilio says: [${e.status || '?'}] code ${e.code || '?'} — ${e.message}`);
  }

  /* 4. Mint a token exactly like the app and decode it. */
  console.log('\n[4] Mint + decode a Voice access token (as the app does)…');
  try {
    const AccessToken = twilio.jwt.AccessToken;
    const VoiceGrant = AccessToken.VoiceGrant;
    const token = new AccessToken(
      TWILIO_ACCOUNT_SID,
      TWILIO_API_KEY_SID,
      TWILIO_API_KEY_SECRET,
      { identity: 'agent:diagnostic', ttl: 3600 }
    );
    token.addGrant(new VoiceGrant({ outgoingApplicationSid: TWILIO_TWIML_APP_SID, incomingAllow: false }));
    const jwt = token.toJwt();
    const [, payloadB64] = jwt.split('.');
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64').toString('utf8'));
    ok('Token minted.');
    info(`iss (should = API_KEY_SID): ${payload.iss}  ${payload.iss === TWILIO_API_KEY_SID ? '✓' : '✗ MISMATCH'}`);
    info(`sub (should = ACCOUNT_SID): ${payload.sub}  ${payload.sub === TWILIO_ACCOUNT_SID ? '✓' : '✗ MISMATCH'}`);
    const nowSkew = payload.nbf ? payload.nbf * 1000 - Date.now() : 0;
    info(`grants: ${JSON.stringify(payload.grants)}`);
    info(`expires in: ${Math.round((payload.exp * 1000 - Date.now()) / 1000)}s`);
    if (Math.abs(nowSkew) > 5000) info(`⚠ clock skew vs token nbf: ${Math.round(nowSkew / 1000)}s — large skew can also trigger 20101`);
  } catch (e) {
    bad(`Token minting threw: ${e.message}`);
  }

  console.log('\n──────────────────────────────────────────────────────────');
  console.log('If [1] or [2] failed → that IS the 20101. Regenerate the API');
  console.log('Key inside the account matching TWILIO_ACCOUNT_SID. If [1]-[4]');
  console.log('all pass, the credentials are fine and 20101 is an edge/region');
  console.log('mismatch — ensure the browser Device uses edge/region "au1/sydney".');
  console.log('');
  process.exit(0);
})().catch((e) => { console.error('fatal:', e); process.exit(1); });
