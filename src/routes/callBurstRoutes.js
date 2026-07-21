const express = require('express');
const { protect } = require('../middleware/auth');
const requirePermission = require('../middleware/requirePermission');
const controller = require('../controllers/callBurstController');

const router = express.Router();

router.use(protect);
router.use(requirePermission('tab_call_burst'));

// Browser softphone bootstrap + config probe
router.get('/status', controller.getStatus);
router.post('/token', controller.getToken);

// Recipient picker
router.get('/recipients', controller.listRecipients);

// Burst lifecycle
router.post('/burst', controller.startBurst);
router.post('/single', controller.startSingle);
router.get('/burst/:id', controller.getBurst);
router.post('/burst/:id/hangup', controller.hangup);

module.exports = router;
