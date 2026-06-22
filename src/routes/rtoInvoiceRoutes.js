const express = require('express');
const { protect, authorize } = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');
const rtoInvoiceService = require('../services/rtoInvoiceService');

const router = express.Router();

router.use(protect);
router.use(authorize('Admin', 'CEOReportingManager'));

// List invoices
router.get('/', asyncHandler(async (req, res) => {
  const result = await rtoInvoiceService.list(req.query);
  res.json(result);
}));

// Get single invoice
router.get('/:id', asyncHandler(async (req, res) => {
  const item = await rtoInvoiceService.getById(req.params.id);
  res.json({ item });
}));

// Create/upload invoice
router.post('/', asyncHandler(async (req, res) => {
  const item = await rtoInvoiceService.createInvoice({
    ...req.body,
    uploadedBy: req.user._id,
  });
  res.status(201).json({ item });
}));

// Verify invoice (confirm extracted data + map to application)
router.patch('/:id/verify', asyncHandler(async (req, res) => {
  const item = await rtoInvoiceService.verify(req.params.id, {
    ...req.body,
    verifiedBy: req.user._id,
  });
  res.json({ item });
}));

// Schedule into weekly batch
router.patch('/:id/schedule', asyncHandler(async (req, res) => {
  const item = await rtoInvoiceService.schedule(req.params.id, req.body.weekKey);
  res.json({ item });
}));

// Mark as paid
router.patch('/:id/paid', asyncHandler(async (req, res) => {
  const item = await rtoInvoiceService.markPaid(req.params.id);
  res.json({ item });
}));

// Reject invoice
router.patch('/:id/reject', asyncHandler(async (req, res) => {
  const item = await rtoInvoiceService.reject(req.params.id, {
    rejectedBy: req.user._id,
    reason: req.body.reason,
  });
  res.json({ item });
}));

// Auto-map to application
router.post('/:id/auto-map', asyncHandler(async (req, res) => {
  const result = await rtoInvoiceService.autoMap(req.params.id);
  res.json(result);
}));

// Delete invoice
router.delete('/:id', asyncHandler(async (req, res) => {
  const result = await rtoInvoiceService.remove(req.params.id);
  res.json(result);
}));

module.exports = router;
