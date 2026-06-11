const asyncHandler = require('../utils/asyncHandler');
const rbacService = require('../services/rbacService');

exports.getDefaults = asyncHandler(async (req, res) => {
  const result = rbacService.getDefaults();
  res.status(200).json(result);
});

exports.getUserPermissions = asyncHandler(async (req, res) => {
  const userId = req.params.id === 'me' ? req.user._id : req.params.id;
  const result = await rbacService.getUserPermissions(userId);
  res.status(200).json(result);
});

exports.updateUserPermissions = asyncHandler(async (req, res) => {
  const result = await rbacService.updateUserPermissions(
    req.params.id,
    req.body.permissions,
    req.user._id
  );
  res.status(200).json(result);
});

exports.pollPermissions = asyncHandler(async (req, res) => {
  const userId = req.params.id === 'me' ? req.user._id : req.params.id;
  const result = await rbacService.pollPermissions(userId);
  res.status(200).json(result);
});
