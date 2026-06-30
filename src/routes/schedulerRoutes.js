const express = require('express');
const { protect, authorize } = require('../middleware/auth');
const asyncHandler = require('../utils/asyncHandler');
const {
  processDueInstallments,
  sendPaymentReminders,
  flagOverdueInstallments,
  sendApplicationReminders,
  checkRtoPaymentTimers,
} = require('../services/schedulerService');
const xeroService = require('../services/xeroService');

const router = express.Router();

router.use(protect);
router.use(authorize('Admin', 'CEOReportingManager'));

// POST /api/scheduler/run-auto-debit — manually trigger auto-debit processing
router.post(
  '/run-auto-debit',
  asyncHandler(async (req, res) => {
    const result = await processDueInstallments();
    res.json({ message: 'Auto-debit processing complete', ...result });
  })
);

// POST /api/scheduler/run-reminders — manually trigger payment reminders
router.post(
  '/run-reminders',
  asyncHandler(async (req, res) => {
    const result = await sendPaymentReminders();
    res.json({ message: 'Payment reminders sent', ...result });
  })
);

// POST /api/scheduler/run-overdue-check — manually trigger overdue flagging
router.post(
  '/run-overdue-check',
  asyncHandler(async (req, res) => {
    const result = await flagOverdueInstallments();
    res.json({ message: 'Overdue check complete', ...result });
  })
);

// POST /api/scheduler/run-app-reminders — manually trigger application reminders
router.post(
  '/run-app-reminders',
  asyncHandler(async (req, res) => {
    const result = await sendApplicationReminders();
    res.json({ message: 'Application reminders sent', ...result });
  })
);

// POST /api/scheduler/run-rto-timer-check — manually trigger RTO 21-day timer check
router.post(
  '/run-rto-timer-check',
  asyncHandler(async (req, res) => {
    const result = await checkRtoPaymentTimers();
    res.json({ message: 'RTO timer check complete', ...result });
  })
);

// POST /api/scheduler/run-xero-sync — manually trigger Xero sync + reconciliation
router.post(
  '/run-xero-sync',
  asyncHandler(async (req, res) => {
    const syncResult = await xeroService.syncAll();
    const reconcileResult = await xeroService.reconcile();
    res.json({
      message: 'Xero sync + reconciliation complete',
      sync: syncResult,
      reconciliation: reconcileResult,
    });
  })
);

module.exports = router;
