const asyncHandler = require('../utils/asyncHandler');
const AppError = require('../utils/AppError');
const callBurstService = require('../services/callBurstService');
const twilioVoice = require('../services/twilioVoiceService');

/* ── Authenticated API (agent-facing) ──────────────────────── */

// Mint a browser Voice access token so the Device can register up-front.
const getToken = asyncHandler(async (req, res) => {
  if (!twilioVoice.isBrowserConfigured()) {
    throw new AppError('Calling is not configured. Add the Twilio voice credentials first.', 503);
  }
  const data = twilioVoice.createAccessToken(`agent:${req.user._id}`);
  res.json(data);
});

// Config probe for the UI (so it can disable the call buttons gracefully).
const getStatus = asyncHandler(async (req, res) => {
  res.json({ configured: twilioVoice.isBrowserConfigured() });
});

// Start a burst to many recipients.
const startBurst = asyncHandler(async (req, res) => {
  const result = await callBurstService.startBurst({
    agent: req.user,
    applicationIds: req.body.applicationIds,
    mode: 'burst',
  });
  res.status(201).json(result);
});

// Start a 1-on-1 call (single-recipient burst) — backs the call buttons.
const startSingle = asyncHandler(async (req, res) => {
  const applicationIds = req.body.applicationId ? [req.body.applicationId] : req.body.applicationIds;
  const result = await callBurstService.startBurst({
    agent: req.user,
    applicationIds,
    mode: 'single',
  });
  res.status(201).json(result);
});

const listRecipients = asyncHandler(async (req, res) => {
  const data = await callBurstService.listRecipients({
    search: req.query.search,
    status: req.query.status,
    mine: req.query.mine,
    agent: req.user,
    limit: req.query.limit,
  });
  res.json(data);
});

const getBurst = asyncHandler(async (req, res) => {
  const burst = await callBurstService.getBurst(req.params.id, req.user);
  res.json({ burst });
});

const hangup = asyncHandler(async (req, res) => {
  const burst = await callBurstService.hangup(req.params.id, req.user);
  res.json({ burst });
});

/* ── Public Twilio webhooks (signature-validated) ──────────── */

function guard(req, res) {
  if (!twilioVoice.validateSignature(req)) {
    res.status(403).send('Invalid signature');
    return false;
  }
  return true;
}

// Agent's browser call landed → park them in the conference.
const voiceAgent = asyncHandler(async (req, res) => {
  if (!guard(req, res)) return;
  const burstId = req.query.burstId || req.body.burstId;
  const twiml = await callBurstService.registerAgentLeg(burstId, req.body.CallSid);
  res.type('text/xml').send(twiml);
});

// A recipient answered → drop them into the conference (connect-on-answer).
const voiceStudent = asyncHandler(async (req, res) => {
  if (!guard(req, res)) return;
  const burstId = req.query.burstId || req.body.burstId;
  // We only need the conference name; fetch it via the service-owned model.
  const CallBurst = require('../models/CallBurst');
  const burst = await CallBurst.findById(burstId).select('conferenceName').lean();
  const conf = burst?.conferenceName;
  if (!conf) return res.type('text/xml').send('<Response><Hangup/></Response>');
  res.type('text/xml').send(twilioVoice.studentConferenceTwiml(conf));
});

const status = asyncHandler(async (req, res) => {
  if (!guard(req, res)) return;
  await callBurstService.onStatusEvent(req.body);
  res.status(204).end();
});

const conference = asyncHandler(async (req, res) => {
  if (!guard(req, res)) return;
  await callBurstService.onConferenceEvent(req.body);
  res.status(204).end();
});

module.exports = {
  getToken,
  getStatus,
  listRecipients,
  startBurst,
  startSingle,
  getBurst,
  hangup,
  voiceAgent,
  voiceStudent,
  status,
  conference,
};
