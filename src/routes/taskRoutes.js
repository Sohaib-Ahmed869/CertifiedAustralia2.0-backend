const express = require('express');
const controller = require('../controllers/taskController');

const router = express.Router();

router.route('/')
  .get(controller.list)
  .post(controller.create);

router.route('/:id')
  .get(controller.getById)
  .patch(controller.update)
  .delete(controller.remove);

module.exports = router;
