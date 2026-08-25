const nodemailer = require('nodemailer');
const Mailbox = require('../models/Mailbox');
const AppError = require('../utils/AppError');
const buildCrud = require('./commonCrud');
const { resetTransport } = require('./campaignSendService');

const mailboxCrud = buildCrud(Mailbox, {
  populate: ['createdBy'],
});

/**
 * Actually open an SMTP session and authenticate.
 *
 * `verify`/`connect` used to just stamp `healthStatus: 'healthy'` without talking
 * to the server at all, so a mailbox with a wrong app password read as healthy and
 * every campaign/sequence send failed later with no clue why. One-off (unpooled)
 * transport on purpose — a failed handshake must not leave a broken pooled
 * connection cached for the senders.
 */
const probeSmtp = async (mailbox) => {
  const transporter = nodemailer.createTransport({
    host: mailbox.smtpHost,
    port: mailbox.smtpPort || 587,
    secure: (mailbox.smtpPort || 587) === 465,
    auth: { user: mailbox.email, pass: mailbox.appPassword },
    connectionTimeout: 15000,
    greetingTimeout: 15000,
  });
  try {
    await transporter.verify();
    return { ok: true };
  } catch (err) {
    // Only a REJECTED SIGN-IN proves the mailbox is bad. A DNS hiccup or a timeout
    // says nothing about the credentials, and marking `unhealthy` on one of those
    // would stop every campaign and sequence that uses this mailbox until someone
    // noticed and re-verified.
    const authFailed = err.code === 'EAUTH' || Number(err.responseCode) === 535 || Number(err.responseCode) === 534;
    return { ok: false, authFailed, error: err.message || 'SMTP verification failed' };
  } finally {
    try { transporter.close(); } catch { /* already closed */ }
  }
};

const connect = async (data) => {
  // Refuse to store a mailbox we could not sign in to — saving one unverified is
  // exactly how a wrong app password used to sit there looking "healthy" while
  // every send failed. Adding a mailbox is a rare interactive action, so asking
  // for a retry on an unreachable server is the safer trade.
  const probe = await probeSmtp(data);
  if (!probe.ok) {
    throw new AppError(
      probe.authFailed
        ? `Could not sign in to ${data.email}: ${probe.error}. Check the app password.`
        : `Could not reach the mail server for ${data.email}: ${probe.error}. Check the host and port, then try again.`,
      400,
    );
  }

  const mailbox = await Mailbox.create({
    ...data,
    healthStatus: 'healthy',
    lastVerifiedAt: new Date(),
  });

  return Mailbox.findById(mailbox._id)
    .populate('createdBy')
    .lean();
};

const verify = async (id) => {
  const mailbox = await Mailbox.findById(id);
  if (!mailbox) throw new AppError('Mailbox not found', 404);

  resetTransport(mailbox._id); // credentials may have changed since the pool was cached
  const probe = await probeSmtp(mailbox);

  mailbox.lastVerifiedAt = new Date();
  if (probe.ok) {
    mailbox.healthStatus = 'healthy';
    mailbox.cooldownUntil = null; // a good handshake clears a throttle park
  } else if (probe.authFailed) {
    mailbox.healthStatus = 'unhealthy'; // credentials really are wrong — stop sending
  } // else: couldn't reach the server; leave the existing status alone.

  await mailbox.save();

  if (!probe.ok) {
    throw new AppError(
      probe.authFailed
        ? `Could not sign in to ${mailbox.email}: ${probe.error}`
        : `Could not reach the mail server for ${mailbox.email}: ${probe.error}. The mailbox was left as-is — try again.`,
      400,
    );
  }

  return Mailbox.findById(mailbox._id)
    .populate('createdBy')
    .lean();
};

const disconnect = async (id) => {
  const mailbox = await Mailbox.findById(id);
  if (!mailbox) throw new AppError('Mailbox not found', 404);

  mailbox.isActive = false;
  await mailbox.save();

  return Mailbox.findById(mailbox._id)
    .populate('createdBy')
    .lean();
};

const updateConfig = async (id, data) => {
  const mailbox = await Mailbox.findById(id);
  if (!mailbox) throw new AppError('Mailbox not found', 404);

  if (data.displayName !== undefined) mailbox.displayName = data.displayName;
  if (data.dailyLimit !== undefined) mailbox.quotaConfig.dailyLimit = data.dailyLimit;
  if (data.hourlyLimit !== undefined) mailbox.quotaConfig.hourlyLimit = data.hourlyLimit;
  // Credentials/host changes must invalidate the cached (pooled) transport, or the
  // senders keep authenticating with the old ones until the process restarts.
  let credsChanged = false;
  for (const key of ['smtpHost', 'smtpPort', 'appPassword']) {
    if (data[key] !== undefined && data[key] !== mailbox[key]) { mailbox[key] = data[key]; credsChanged = true; }
  }

  await mailbox.save();
  if (credsChanged) resetTransport(mailbox._id);

  return Mailbox.findById(mailbox._id)
    .populate('createdBy')
    .lean();
};

module.exports = {
  mailboxes: mailboxCrud,
  connect,
  verify,
  disconnect,
  updateConfig,
};
