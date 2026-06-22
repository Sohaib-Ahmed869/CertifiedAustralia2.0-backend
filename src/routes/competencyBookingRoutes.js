const express = require('express');
const { protect } = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');
const svc = require('../services/competencyBookingService');

const router = express.Router();

router.use(protect);

// List bookings
router.get('/', asyncHandler(async (req, res) => {
  const result = await svc.list(req.query);
  res.json(result);
}));

// Get assessor bookings for a date range (availability view)
router.get('/assessor/:assessorId', asyncHandler(async (req, res) => {
  const { dateFrom, dateTo } = req.query;
  if (!dateFrom || !dateTo) return res.status(400).json({ message: 'dateFrom and dateTo required' });
  const items = await svc.getAssessorBookings(req.params.assessorId, dateFrom, dateTo);
  res.json({ items });
}));

// Create booking
router.post('/', asyncHandler(async (req, res) => {
  const item = await svc.create({ ...req.body, createdBy: req.user._id });
  res.status(201).json({ item });
}));

// Reschedule (assessor or admin)
router.patch('/:id/reschedule', asyncHandler(async (req, res) => {
  const item = await svc.reschedule(req.params.id, {
    ...req.body,
    rescheduledBy: req.user._id,
  });
  res.json({ item });
}));

// Complete
router.patch('/:id/complete', asyncHandler(async (req, res) => {
  const item = await svc.complete(req.params.id, req.body);
  res.json({ item });
}));

// Cancel
router.patch('/:id/cancel', asyncHandler(async (req, res) => {
  const item = await svc.cancel(req.params.id);
  res.json({ item });
}));

module.exports = router;
