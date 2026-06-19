const Mailbox = require('../models/Mailbox');
const AppError = require('../utils/AppError');
const buildCrud = require('./commonCrud');

const mailboxCrud = buildCrud(Mailbox, {
  populate: ['createdBy'],
});

const connect = async (data) => {
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

  mailbox.lastVerifiedAt = new Date();
  mailbox.healthStatus = 'healthy';
  await mailbox.save();

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

  await mailbox.save();

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
