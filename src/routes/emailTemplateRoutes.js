const express = require('express');
const controller = require('../controllers/emailTemplateController');
const { protect } = require('../middleware/auth');

const router = express.Router();

router.use(protect);

router.route('/')
  .get(controller.list)
  .post(controller.create);

router.route('/:id')
  .get(controller.getById)
  .patch(controller.update)
  .delete(controller.remove);

router.post('/:id/send', controller.sendTemplate);
router.post('/:id/send-bulk', controller.sendBulk);

module.exports = router;
