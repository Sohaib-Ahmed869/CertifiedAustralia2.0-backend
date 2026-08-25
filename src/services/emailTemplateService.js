const buildCrud = require('./commonCrud');
const EmailTemplate = require('../models/EmailTemplate');
const { sendTemplatedEmail } = require('./emailService');
const AppError = require('../utils/AppError');

// Standard CRUD operations
const templates = buildCrud(EmailTemplate);

/**
 * The template builder's merge-variable picker inserts each token inside a green
 * monospace "chip" span so it stands out WHILE EDITING. That styling is design-time
 * decoration — but it is part of the saved HTML, so it used to survive substitution
 * and the student received "Hi `Asad`" with the name set in a green code pill, and
 * "your `CPC30220 Certificate III in Carpentry` through …" mid-sentence.
 *
 * Unwrapping the chip (before substituting) makes a resolved value inherit the
 * surrounding paragraph's font, size and colour, which is what staff expect from a
 * merge field. Matched on the SPAN CONTENTS, not the attributes, so templates saved
 * by the old builder are fixed without anyone re-editing them. The trailing
 * `&nbsp;` the picker adds goes too — it was the extra gap after each chip.
 */
const MERGE_CHIP_RE = /<span\b[^>]*>\s*(\{\{\s*\w+\s*\}\})\s*<\/span>(?:&nbsp;| )?/gi;

const unwrapMergeChips = (html) => String(html || '').replace(MERGE_CHIP_RE, '$1');

/**
 * Replace {{placeholder}} tokens in a string with the supplied variable values.
 * Unknown tokens are left as-is so a typo is visible rather than silently blank.
 *
 * @param {string} text
 * @param {object} variables - key/value map, e.g. { firstName: 'Jane' }
 * @returns {string}
 */
const interpolate = (text, variables = {}) =>
  unwrapMergeChips(text).replace(/\{\{\s*(\w+)\s*\}\}/g, (match, key) =>
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
  interpolate,
  unwrapMergeChips,
};
