const express = require('express');
const controller = require('../controllers/notificationController');
const { protect } = require('../middleware/auth');

const router = express.Router();

router.use(protect);

// Mark all read and unread count BEFORE /:id to avoid param collision
router.patch('/mark-all-read', controller.markAllRead);
router.get('/unread-count', controller.getUnreadCount);

router.route('/')
  .get(controller.list)
  .post(controller.createNotification);

router.route('/:id')
  .get(controller.getById)
  .patch(controller.update)
  .delete(controller.remove);

router.patch('/:id/read', controller.markRead);

module.exports = router;
