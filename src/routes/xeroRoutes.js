const express = require('express');
const { protect, authorize } = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');
const xeroService = require('../services/xeroService');

const router = express.Router();

// OAuth callback — public (Xero redirects here after auth)
router.get('/callback', asyncHandler(async (req, res) => {
  await xeroService.handleCallback(req.query.code);
  const redirectUrl = `${process.env.APP_BASE_URL || 'http://localhost:5173'}/admin/settings?xero=connected`;
  res.redirect(redirectUrl);
}));

// All other routes require Admin/CEO auth
router.use(protect);
router.use(authorize('Admin', 'CEOReportingManager'));

// Connection management
router.get('/status', asyncHandler(async (req, res) => {
  const status = await xeroService.getConnectionStatus();
  res.json(status);
}));

router.get('/auth-url', asyncHandler(async (req, res) => {
  const url = xeroService.getAuthUrl();
  res.json({ url });
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
