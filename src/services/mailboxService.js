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
    return { ok: false, error: err.message || 'SMTP verification failed' };
  } finally {
    try { transporter.close(); } catch { /* already closed */ }
  }
};

const connect = async (data) => {
  const probe = await probeSmtp(data);
  if (!probe.ok) {
    throw new AppError(`Could not sign in to ${data.email}: ${probe.error}`, 400);
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
  mailbox.healthStatus = probe.ok ? 'healthy' : 'unhealthy';
  if (probe.ok) mailbox.cooldownUntil = null; // a good handshake clears a throttle park

  await mailbox.save();

  if (!probe.ok) throw new AppError(`Could not sign in to ${mailbox.email}: ${probe.error}`, 400);

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
