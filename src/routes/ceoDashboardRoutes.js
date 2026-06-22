const express = require('express');
const controller = require('../controllers/ceoDashboardController');
const { protect, authorize } = require('../middleware/auth');

const router = express.Router();

// All routes require authentication + Admin, CEOReportingManager, or Marketing role
router.use(protect);
router.use(authorize('Admin', 'CEOReportingManager', 'Marketing'));

// ── Dashboard aggregation routes ──
router.get('/overview', controller.getOverview);
router.get('/leads', controller.getLeads);
router.get('/call-attempts', controller.getCallAttempts);
router.get('/agent-performance', controller.getAgentPerformance);
router.get('/marketing', controller.getMarketing);
router.get('/marketing/export', controller.exportMarketing);
router.post('/marketing/spend', controller.createMarketingSpend);
router.get('/supplier-liability', controller.getSupplierLiability);

// ── Cashflow routes ──
router.get('/cashflow/range', controller.getCashflowRange);
router.get('/cashflow/config', controller.getCashflowConfig);
router.patch('/cashflow/config', controller.updateCashflowConfig);
router.get('/cashflow/:weekKey', controller.getWeekSummary);
router.post('/cashflow/:weekKey/mark-paid', controller.markPaid);
router.post('/cashflow/:weekKey/undo-paid', controller.undoPaid);
router.post('/cashflow/:weekKey/flex-allocation', controller.setFlexAllocation);

module.exports = router;
