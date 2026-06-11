const createCrudController = require('./crudController');
const { tasks } = require('../services/taskService');

module.exports = createCrudController(tasks);
