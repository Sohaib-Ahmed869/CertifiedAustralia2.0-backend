const asyncHandler = require('../utils/asyncHandler');
const guardrailService = require('../services/guardrailService');

module.exports = {
  // Public — FE reads which guards to render.
  getPublicConfig: asyncHandler(async (req, res) => {
    res.json(await guardrailService.publicConfig());
  }),

  // Staff — full config for the CEO dashboard.
  getConfig: asyncHandler(async (req, res) => {
    res.json(await guardrailService.readConfig());
  }),

  // CEO — update toggles + thresholds.
  updateConfig: asyncHandler(async (req, res) => {
    res.json(await guardrailService.updateConfig(req.body, req.user._id));
  }),

  // Public (rate-limited) — issue + deliver a registration OTP.
  sendOtp: asyncHandler(async (req, res) => {
    const { channel, destination } = req.body;
    const result = await guardrailService.sendOtp({ purpose: 'registration', channel, destination });
    res.json(result);
  }),
};
