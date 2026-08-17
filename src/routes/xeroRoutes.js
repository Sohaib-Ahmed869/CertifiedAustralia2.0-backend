const express = require('express');
const { protect, authorize } = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');
const xeroService = require('../services/xeroService');

const router = express.Router();

// OAuth callback — public (Xero redirects a *browser* here after consent, so
// there is no session and no JSON client on the other end: every outcome has to
// end in a redirect back to the settings page, never an API error response.)
router.get('/callback', async (req, res) => {
  const appBase = process.env.APP_BASE_URL || process.env.FRONTEND_URL || 'http://localhost:5173';
  const settingsUrl = `${appBase.replace(/\/+$/, '')}/admin/settings/xero`;
  const fail = (message) =>
    res.redirect(`${settingsUrl}?xero=error&message=${encodeURIComponent(message.slice(0, 200))}`);

  // Xero reports a declined consent as ?error=, not as a missing code.
  if (req.query.error) return fail(req.query.error_description || req.query.error);
  if (!req.query.code) return fail('Xero did not return an authorization code');

  try {
    // The initiating user rode along in `state` — it is the only way this public
    // route can attribute the connection.
    const { userId } = xeroService.decodeState(req.query.state);
    await xeroService.handleCallback(req.query.code, userId);
    return res.redirect(`${settingsUrl}?xero=connected`);
  } catch (err) {
    return fail(err.message || 'Failed to complete the Xero connection');
  }
});

// All other routes require Admin/CEO auth
router.use(protect);
router.use(authorize('Admin', 'CEOReportingManager'));

// Connection management
router.get('/status', asyncHandler(async (req, res) => {
  const status = await xeroService.getConnectionStatus();
  res.json(status);
}));

router.get('/auth-url', asyncHandler(async (req, res) => {
  const url = xeroService.getAuthUrl(req.user._id);
  // redirectUri is returned so the UI can show exactly what must be registered
  // on the Xero app — a mismatch here is the most common connect failure.
  res.json({ url, redirectUri: xeroService.getRedirectUri() });
}));

router.post('/disconnect', asyncHandler(async (req, res) => {
  const result = await xeroService.disconnect();
  res.json(result);
}));

// Invoice sync
router.post('/sync-invoice', asyncHandler(async (req, res) => {
  const result = await xeroService.syncInvoice(req.body.paymentId);
  res.json(result);
}));

router.post('/sync-all', asyncHandler(async (req, res) => {
  const result = await xeroService.syncAll();
  res.json({ message: 'Batch sync complete', ...result });
}));

// Reconciliation
router.post('/reconcile', asyncHandler(async (req, res) => {
  const result = await xeroService.reconcile();
  res.json(result);
}));

router.get('/reconciliation-report', asyncHandler(async (req, res) => {
  const report = await xeroService.getReconciliationReport();
  res.json(report);
}));

// Sync history
router.get('/sync-history', asyncHandler(async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 20;
  const result = await xeroService.getSyncHistory(page, limit);
  res.json(result);
}));

module.exports = router;
