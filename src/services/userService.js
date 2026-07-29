const buildCrud = require('./commonCrud');
const User = require('../models/User');

module.exports = {
  users: buildCrud(User, {
    // Resolve the Refer-a-Friend referrer so the student detail page can show
    // "Referred by <name>". Only students carry this field; no-op for staff.
    populate: [
      { path: 'sourceAttribution.referredBy', select: 'firstName lastName email' },
    ],
  }),
};
