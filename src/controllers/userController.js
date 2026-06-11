const createCrudController = require('./crudController');
const { users } = require('../services/userService');

module.exports = createCrudController(users);
