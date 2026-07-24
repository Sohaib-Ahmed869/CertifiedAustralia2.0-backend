const asyncHandler = require('../utils/asyncHandler');
const service = require('../services/directDebitAuthService');

module.exports = {
  /* ── Public (token-secured) ── */
  getByToken: asyncHandler(async (req, res) => {
    const item = await service.getByToken(req.params.token);
    res.status(200).json({ item });
  }),
  submit: asyncHandler(async (req, res) => {
    const item = await service.submit(req.params.token, req.body);
    res.status(200).json({ item });
  }),

  /* ── Protected (admin) ── */
  getByApplication: asyncHandler(async (req, res) => {
    const item = await service.getByApplication(req.params.applicationId);
    res.status(200).json({ item });
  }),
  enable: asyncHandler(async (req, res) => {
    const item = await service.enableAuthority(req.params.applicationId, { userId: req.user._id });
    res.status(200).json({ item });
  }),
  disable: asyncHandler(async (req, res) => {
    const item = await service.disableAuthority(req.params.applicationId);
    res.status(200).json({ item });
  }),
  resend: asyncHandler(async (req, res) => {
    const item = await service.resendEmail(req.params.applicationId, { userId: req.user._id });
    res.status(200).json({ item });
  }),
};
