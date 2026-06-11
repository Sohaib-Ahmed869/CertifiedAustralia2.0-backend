const buildCrud = require('./commonCrud');
const EmailTemplate = require('../models/EmailTemplate');
const { sendTemplatedEmail } = require('./emailService');
const AppError = require('../utils/AppError');

// Standard CRUD operations
const templates = buildCrud(EmailTemplate);

/**
 * Replace {{placeholder}} tokens in a string with the supplied variable values.
 *
 * @param {string} text
 * @param {object} variables - key/value map, e.g. { firstName: 'Jane' }
 * @returns {string}
 */
const interpolate = (text, variables = {}) =>
  text.replace(/\{\{(\w+)\}\}/g, (match, key) =>
    variables[key] !== undefined ? String(variables[key]) : match,
  );

/**
 * Fetch a template by ID, interpolate variables, and send to a single recipient.
 *
 * @param {string} templateId  - Mongoose ObjectId
 * @param {string} recipientEmail
 * @param {object} variables   - key/value map for placeholder replacement
 * @returns {Promise<{success: boolean, messageId?: string}>}
 */
const sendTemplate = async (templateId, recipientEmail, variables = {}) => {
  const template = await EmailTemplate.findById(templateId).lean();
  if (!template) throw new AppError('Email template not found', 404);
  if (!template.active) throw new AppError('Email template is inactive', 400);

  const subject = interpolate(template.subject, variables);
  const body = interpolate(template.body, variables);

  return sendTemplatedEmail({
    to: recipientEmail,
    subject,
    templateContent: body,
  });
};

/**
 * Send a template to multiple recipients, each with their own variable values.
 *
 * @param {string} templateId
 * @param {Array<{email: string, variables: object}>} recipients
 * @returns {Promise<{total: number, sent: number, failed: number, results: Array}>}
 */
const sendBulk = async (templateId, recipients = []) => {
  const template = await EmailTemplate.findById(templateId).lean();
  if (!template) throw new AppError('Email template not found', 404);
  if (!template.active) throw new AppError('Email template is inactive', 400);

  const results = [];
  let sent = 0;
  let failed = 0;

  for (const recipient of recipients) {
    const subject = interpolate(template.subject, recipient.variables || {});
    const body = interpolate(template.body, recipient.variables || {});

    const result = await sendTemplatedEmail({
      to: recipient.email,
      subject,
      templateContent: body,
    });

    if (result.success) {
      sent++;
    } else {
      failed++;
    }

    results.push({
      email: recipient.email,
      success: result.success,
      messageId: result.messageId,
    });
  }

  return { total: recipients.length, sent, failed, results };
};

module.exports = {
  templates,
  sendTemplate,
  sendBulk,
};
