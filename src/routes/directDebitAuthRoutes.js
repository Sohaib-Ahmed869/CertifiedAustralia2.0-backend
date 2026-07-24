const express = require('express');
const controller = require('../controllers/directDebitAuthController');
const { protect, authorize } = require('../middleware/auth');

const router = express.Router();

// ── Public token routes (customer-facing form) — declared BEFORE protect ──
router.get('/token/:token', controller.getByToken);
router.post('/token/:token/submit', controller.submit);

// ── Protected admin routes ──
router.use(protect);
router.get('/:applicationId', controller.getByApplication);
router.post('/:applicationId/enable', authorize('Admin', 'CEOReportingManager'), controller.enable);
router.post('/:applicationId/disable', authorize('Admin', 'CEOReportingManager'), controller.disable);
router.post('/:applicationId/resend', authorize('Admin', 'CEOReportingManager'), controller.resend);

module.exports = router;
