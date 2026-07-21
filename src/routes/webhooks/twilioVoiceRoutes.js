const express = require('express');
const controller = require('../../controllers/callBurstController');

/**
 * Public Twilio Voice webhooks (no JWT — authenticated via X-Twilio-Signature
 * inside the controller). Twilio POSTs application/x-www-form-urlencoded, which
 * the global express.urlencoded parser already handles.
 */
const router = express.Router();

router.post('/voice/agent', controller.voiceAgent);
router.post('/voice/student', controller.voiceStudent);
router.post('/status', controller.status);
router.post('/conference', controller.conference);

module.exports = router;
