const express = require('express');
const { protect, authorize } = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');
const xeroService = require('../services/xeroService');

const router = express.Router();

// Connection status (no auth needed for callback)
router.get('/callback', asyncHandler(async (req, res) => {
  const result = await xeroService.handleCallback(req.query.code);
  // Redirect back to settings page after OAuth
  const redirectUrl = `${process.env.APP_BASE_URL || 'http://localhost:5173'}/admin/settings?xero=connected`;
  res.redirect(redirectUrl);
}));

// All other routes require auth
router.use(protect);
router.use(authorize('Admin', 'CEOReportingManager'));

router.get('/status', asyncHandler(async (req, res) => {
  const status = xeroService.getConnectionStatus();
  res.json(status);
}));

router.get('/auth-url', asyncHandler(async (req, res) => {
  const url = xeroService.getAuthUrl();
  res.json({ url });
}));

router.post('/disconnect', asyncHandler(async (req, res) => {
  const result = xeroService.disconnect();
  res.json(result);
}));

router.post('/sync-invoice', asyncHandler(async (req, res) => {
  const result = await xeroService.syncInvoice(req.body.paymentId);
  res.json(result);
}));

router.get('/reconcile', asyncHandler(async (req, res) => {
  const result = await xeroService.reconcile();
  res.json(result);
}));

module.exports = router;
