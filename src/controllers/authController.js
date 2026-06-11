const asyncHandler = require('../utils/asyncHandler');
const authService = require('../services/authService');

exports.register = asyncHandler(async (req, res) => {
  const result = await authService.register(req.body);
  res.status(201).json(result);
});

exports.login = asyncHandler(async (req, res) => {
  const result = await authService.login(req.body);
  res.status(200).json(result);
});

exports.verifyMfa = asyncHandler(async (req, res) => {
  const result = await authService.verifyMfa(req.body);
  res.status(200).json(result);
});

exports.setupMfa = asyncHandler(async (req, res) => {
  const result = await authService.setupMfa(req.user._id);
  res.status(200).json(result);
});

exports.confirmMfa = asyncHandler(async (req, res) => {
  const result = await authService.confirmMfa(req.user._id, req.body.otp);
  res.status(200).json(result);
});

exports.disableMfa = asyncHandler(async (req, res) => {
  const result = await authService.disableMfa(req.user._id);
  res.status(200).json(result);
});

exports.forgotPassword = asyncHandler(async (req, res) => {
  const result = await authService.forgotPassword(req.body.email);
  res.status(200).json(result);
});

exports.resetPassword = asyncHandler(async (req, res) => {
  const result = await authService.resetPassword(req.body);
  res.status(200).json(result);
});

exports.getMe = asyncHandler(async (req, res) => {
  const user = await authService.getMe(req.user._id);
  res.status(200).json({ user });
});

exports.changePassword = asyncHandler(async (req, res) => {
  const result = await authService.changePassword(
    req.user._id,
    req.body.currentPassword,
    req.body.newPassword
  );
  res.status(200).json(result);
});
