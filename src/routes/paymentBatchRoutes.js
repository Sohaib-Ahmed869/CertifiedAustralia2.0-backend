const express = require('express');
const { protect, authorize } = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');
const paymentBatchService = require('../services/paymentBatchService');

const router = express.Router();

router.use(protect);
router.use(authorize('Admin', 'CEOReportingManager'));

// List batches
router.get('/', asyncHandler(async (req, res) => {
  const items = await paymentBatchService.list(req.query);
  res.json({ items });
}));

// Get single batch
router.get('/:id', asyncHandler(async (req, res) => {
  const item = await paymentBatchService.getById(req.params.id);
  res.json({ item });
}));

// Generate batch for a week
router.post('/generate', asyncHandler(async (req, res) => {
  const item = await paymentBatchService.generateBatch(req.body.weekKey);
  res.status(201).json({ item });
}));

// Approve batch
router.patch('/:id/approve', asyncHandler(async (req, res) => {
  const item = await paymentBatchService.approve(req.params.id, req.user._id);
  res.json({ item });
}));

// Release batch
router.post('/:id/release', asyncHandler(async (req, res) => {
  const item = await paymentBatchService.release(req.params.id, req.user._id);
  res.json({ item });
}));

// Complete batch
router.patch('/:id/complete', asyncHandler(async (req, res) => {
  const item = await paymentBatchService.complete(req.params.id);
  res.json({ item });
}));

module.exports = router;
