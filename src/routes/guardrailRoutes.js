const express = require('express');
const { protect, authorize } = require('../middleware/auth');
const { otpSendRateGuard } = require('../middleware/guardrails');
const controller = require('../controllers/guardrailController');

const router = express.Router();

// Public — the registration FE reads this to decide which widgets to render.
router.get('/config/public', controller.getPublicConfig);

// Public (rate-limited) — issue + deliver a registration OTP.
router.post('/send-otp', otpSendRateGuard, controller.sendOtp);

// Staff read / CEO write — the control plane behind a real auth guard.
router.get('/config', protect, authorize('Admin', 'CEOReportingManager'), controller.getConfig);
router.put('/config', protect, authorize('Admin', 'CEOReportingManager'), controller.updateConfig);

module.exports = router;
