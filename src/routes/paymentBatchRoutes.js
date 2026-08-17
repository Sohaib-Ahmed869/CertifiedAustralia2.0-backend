const express = require('express');
const { protect, authorize } = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');
const paymentBatchService = require('../services/paymentBatchService');

const router = express.Router();

router.use(protect);
router.use(authorize('Admin', 'CEOReportingManager'));

// ── Config ── (declared before /:id so "config" isn't matched as an ObjectId)
router.get('/config', asyncHandler(async (req, res) => {
  const config = await paymentBatchService.getConfig();
  res.json({ config });
}));

router.patch('/config', asyncHandler(async (req, res) => {
  const config = await paymentBatchService.updateConfig(req.body, req.user._id);
  res.json({ config });
}));

// Re-sweep any RTO invoice that isn't queued yet + refresh unpaid rows
router.post('/reconcile', asyncHandler(async (req, res) => {
  const result = await paymentBatchService.reconcile({ force: true });
  res.json(result);
}));

// Ensure a week exists and sweep it (manual fallback — the queue is automatic)
router.post('/generate', asyncHandler(async (req, res) => {
  const item = await paymentBatchService.generateBatch(req.body.weekKey);
  res.status(201).json({ item });
}));

// ── Read ──
router.get('/', asyncHandler(async (req, res) => {
  const result = await paymentBatchService.list(req.query);
  res.json(result);
}));

router.get('/:id', asyncHandler(async (req, res) => {
  const item = await paymentBatchService.getById(req.params.id);
  res.json({ item });
}));

// ── Week-level actions ──
router.patch('/:id/approve', asyncHandler(async (req, res) => {
  const item = await paymentBatchService.approve(req.params.id, req.user._id);
  res.json({ item });
}));

router.post('/:id/release', asyncHandler(async (req, res) => {
  const item = await paymentBatchService.release(req.params.id, req.user._id);
  res.json({ item });
}));

router.patch('/:id/complete', asyncHandler(async (req, res) => {
  const item = await paymentBatchService.complete(req.params.id);
  res.json({ item });
}));

router.patch('/:id', asyncHandler(async (req, res) => {
  const item = await paymentBatchService.updateBatch(req.params.id, req.body);
  res.json({ item });
}));

// Push the week to Xero as ACCPAY bills
router.post('/:id/xero-push', asyncHandler(async (req, res) => {
  const result = await paymentBatchService.pushToXero(req.params.id, req.user._id);
  res.json(result);
}));

// ── Row-level actions ──
router.patch('/:id/items/:itemId', asyncHandler(async (req, res) => {
  const item = await paymentBatchService.updateItem(req.params.id, req.params.itemId, req.body);
  res.json({ item });
}));

router.post('/:id/items/:itemId/pay', asyncHandler(async (req, res) => {
  const item = await paymentBatchService.markItemPaid(req.params.id, req.params.itemId, {
    ...req.body,
    userId: req.user._id,
  });
  res.json({ item });
}));

router.post('/:id/items/:itemId/unpay', asyncHandler(async (req, res) => {
  const item = await paymentBatchService.markItemUnpaid(req.params.id, req.params.itemId, {
    ...req.body,
    userId: req.user._id,
  });
  res.json({ item });
}));

router.post('/:id/items/:itemId/move', asyncHandler(async (req, res) => {
  const item = await paymentBatchService.moveItem(req.params.id, req.params.itemId, req.body.weekKey);
  res.json({ item });
}));

module.exports = router;
