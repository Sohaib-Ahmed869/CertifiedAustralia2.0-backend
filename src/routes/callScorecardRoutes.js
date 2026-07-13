const express = require('express');
const { protect, authorize } = require('../middleware/auth');
const controller = require('../controllers/callScorecardController');

const router = express.Router();

router.use(protect);

// Roles that can log calls + view their own scorecard
const CALL_ROLES = ['Agent', 'Admin', 'CEOReportingManager', 'Marketing'];
// Staff-only (team / by-time / target config)
const STAFF_ROLES = ['Admin', 'CEOReportingManager'];

// Events + individual scorecard + typeahead (agent self-service)
router.get('/events', authorize(...CALL_ROLES), controller.listEvents);
router.post('/events', authorize(...CALL_ROLES), controller.createEvent);
router.patch('/events/:id', authorize(...CALL_ROLES), controller.updateEvent);
router.delete('/events/:id', authorize(...CALL_ROLES), controller.deleteEvent);
router.get('/applications/search', authorize(...CALL_ROLES), controller.searchApplications);
router.get('/scorecard/individual', authorize(...CALL_ROLES), controller.getIndividualScorecard);

// Targets — readable by all call roles, editable by staff
router.get('/targets', authorize(...CALL_ROLES), controller.getTargets);
router.put('/targets', authorize(...STAFF_ROLES), controller.updateTargets);

// Team / by-time dashboards — staff only
router.get('/scorecard/team', authorize(...STAFF_ROLES), controller.getTeamScorecard);
router.get('/dashboard/by-time', authorize(...STAFF_ROLES), controller.getByTimeDashboard);

module.exports = router;
