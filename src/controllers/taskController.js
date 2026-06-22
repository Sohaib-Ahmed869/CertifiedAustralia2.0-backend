const asyncHandler = require('../utils/asyncHandler');
const createCrudController = require('./crudController');
const { tasks, createTask } = require('../services/taskService');

const crud = createCrudController(tasks);

module.exports = {
  ...crud,
  // Override create to use notification-aware createTask
  create: asyncHandler(async (req, res) => {
    const result = await createTask({
      ...req.body,
      createdBy: req.user._id,
    });
    res.status(201).json({ item: result });
  }),
};
