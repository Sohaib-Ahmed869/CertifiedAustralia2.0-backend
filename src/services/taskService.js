const buildCrud = require('./commonCrud');
const Task = require('../models/Task');

module.exports = {
  tasks: buildCrud(Task, {
    populate: [
      { path: 'assignedTo', select: 'firstName lastName email' },
      { path: 'applicationId', select: 'applicationId status' },
    ],
  }),
};
