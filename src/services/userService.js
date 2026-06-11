const buildCrud = require('./commonCrud');
const User = require('../models/User');

module.exports = {
  users: buildCrud(User),
};
