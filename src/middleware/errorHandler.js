/**
 * Every controller throws through here. Mongoose errors arrive as plain Errors
 * with no `statusCode`, so without this mapping a duplicate name or a bad id came
 * back as a 500 carrying a raw driver string ("E11000 duplicate key error
 * collection: …", "Cast to [ObjectId] failed for value …") — which the UI shows
 * verbatim to staff, who can only report it as "it won't save".
 */
const FIELD_LABELS = {
  name: 'name',
  email: 'email address',
  applicationId: 'application ID',
  sequenceId: 'sequence ID',
  campaignId: 'campaign ID',
  trackingToken: 'tracking token',
};

const duplicateMessage = (err) => {
  const key = Object.keys(err.keyPattern || err.keyValue || {})[0];
  const value = err.keyValue?.[key];
  const label = FIELD_LABELS[key] || key || 'value';
  return value
    ? `That ${label} is already in use ("${value}"). Choose a different one.`
    : `That ${label} is already in use. Choose a different one.`;
};

const errorHandler = (err, req, res, next) => { // eslint-disable-line no-unused-vars
  let statusCode = err.statusCode || 500;
  let message = err.message || 'Server Error';

  if (!err.statusCode) {
    if (err.name === 'ValidationError' && err.errors) {
      statusCode = 400;
      message = Object.values(err.errors).map((e) => e.message).join(' ');
    } else if (err.name === 'CastError') {
      // e.g. an APP-style display id sent where an ObjectId is expected.
      statusCode = 400;
      message = `Invalid value for "${err.path}".`;
    } else if (err.code === 11000) {
      statusCode = 409;
      message = duplicateMessage(err);
    }
  }

  if (statusCode >= 500) console.error('[error]', req.method, req.originalUrl, '→', err.stack || err.message);

  res.status(statusCode).json({
    message,
    status: err.status || (statusCode < 500 ? 'fail' : 'error'),
    stack: process.env.NODE_ENV === 'production' ? undefined : err.stack,
  });
};

module.exports = errorHandler;
