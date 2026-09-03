const express = require('express');
const controller = require('../controllers/marketingSourceController');
const { protect, authorize } = require('../middleware/auth');

const router = express.Router();

// READ is open to any signed-in user: this is a label/colour registry with no PII, and
// SourceBadge renders it on list screens across the Admin, Support and RTO portals — a
// role gate here would show one portal raw keys next to a globe icon.
//
// WRITE is Admin/CEO/Marketing. Marketing owns the Marketing Links page (it is the one
// non-exec role with `tab_marketing_links`), and adding a tracking link is exactly the
// job this feature exists to hand them.
const canWrite = [protect, authorize('Admin', 'CEOReportingManager', 'Marketing')];

router.route('/')
  .get(protect, controller.list)
  .post(canWrite, controller.create);

router.route('/:id')
  .patch(canWrite, controller.update)
  .delete(canWrite, controller.remove);

module.exports = router;
