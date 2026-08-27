const express = require('express');
const controller = require('../controllers/rtoPartnerController');
const { protect, authorize } = require('../middleware/auth');

const router = express.Router();

// Any staff member who can open the RTO Submission card needs to READ the list to send a
// package. Editing the shared list is Admin/CEO — an Agent picking the wrong partner is a
// misdirected email, but an Agent editing the list misdirects everyone else's too.
const canRead = [protect, authorize('Admin', 'CEOReportingManager', 'Agent', 'Marketing')];
const canWrite = [protect, authorize('Admin', 'CEOReportingManager')];

router.route('/')
  .get(canRead, controller.list)
  .post(canWrite, controller.create);

router.route('/:id')
  .get(canRead, controller.getById)
  .patch(canWrite, controller.update)
  .delete(canWrite, controller.remove);

module.exports = router;
