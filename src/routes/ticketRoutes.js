const express = require('express');
const controller = require('../controllers/ticketController');
const { protect } = require('../middleware/auth');
const upload = require('../middleware/upload');

const router = express.Router();

router.use(protect);

// Stats BEFORE /:id to avoid Express param collision
router.get('/stats', controller.getStats);

router.route('/')
  .get(controller.list)
  .post(upload.array('attachments', 5), controller.createTicket);

router.route('/:id')
  .get(controller.getById)
  .patch(controller.update)
  .delete(controller.remove);

router.post('/:id/messages', upload.array('attachments', 5), controller.addMessage);
router.patch('/:id/resolve', controller.resolveTicket);

module.exports = router;
