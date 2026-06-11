const buildCrud = require('./commonCrud');
const Task = require('../models/Task');

module.exports = {
  tasks: buildCrud(Task),
};
