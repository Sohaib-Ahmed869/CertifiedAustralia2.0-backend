const express = require('express');
const controller = require('../controllers/adCampaignController');
const upload = require('../middleware/upload');
const { protect, authorize } = require('../middleware/auth');

const router = express.Router();

// Mirrors marketingSourceRoutes: READ is open to any signed-in user, because a
// campaign is a label that SourceBadge renders on list screens across several
// portals — a role gate here would show one portal a raw key. WRITE is
// Admin/CEO/Marketing, the same trio that owns the Marketing Links page.
const canWrite = [protect, authorize('Admin', 'CEOReportingManager', 'Marketing')];

// PUBLIC — the sign-up page has no session and must resolve `?campaign=` to its
// real platform before it can decide whether to ask "How did you hear about
// us?". Declared before `/:id` per the literal-before-param convention.
router.get('/public', controller.publicList);

router.route('/')
  .get(protect, controller.list)
  .post(canWrite, controller.create);

// PUBLIC — this URL is the `src` of an `<img>`, which cannot send an
// Authorization header, so it cannot be gated. See the controller for why the
// exposure (an ad creative already running publicly) is acceptable, and why
// this exists at all rather than linking straight to Drive.
router.get('/:id/image', controller.serveImage);

router.post('/:id/image', canWrite, upload.single('image'), controller.uploadImage);
router.delete('/:id/image', canWrite, controller.removeImage);

router.route('/:id')
  .patch(canWrite, controller.update)
  .delete(canWrite, controller.remove);

module.exports = router;
