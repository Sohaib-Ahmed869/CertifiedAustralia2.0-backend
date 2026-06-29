const asyncHandler = require('../utils/asyncHandler');
const createCrudController = require('./crudController');
const { tasks, createTask } = require('../services/taskService');
const Application = require('../models/Application');

const crud = createCrudController(tasks);

module.exports = {
  ...crud,
  // Override list to support relatedUserId (find tasks by studentId OR by applicationId belonging to that student)
  list: asyncHandler(async (req, res) => {
    const query = { ...req.query };

    if (query.relatedUserId) {
      const userId = query.relatedUserId;
      delete query.relatedUserId;

      // Find all applications belonging to this student
      const apps = await Application.find({ studentId: userId }).select('_id').lean();
      const appIds = apps.map((a) => a._id);

      // Tasks linked directly via studentId OR via an applicationId for this student
      query.$or = [
        { studentId: userId },
        ...(appIds.length > 0 ? [{ applicationId: { $in: appIds } }] : []),
      ];
    }

    const result = await tasks.list(query);
    res.status(200).json(result);
  }),
  // Override create to use notification-aware createTask
  create: asyncHandler(async (req, res) => {
    const result = await createTask({
      ...req.body,
      createdBy: req.user._id,
    });
    res.status(201).json({ item: result });
  }),
};
