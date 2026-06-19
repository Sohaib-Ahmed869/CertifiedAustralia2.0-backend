const Campaign = require('../models/Campaign');
const AppError = require('../utils/AppError');
const buildCrud = require('./commonCrud');

const campaignCrud = buildCrud(Campaign, {
  populate: ['templateId', 'createdBy'],
});

const generateCampaignId = async () => {
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const suffix = String(10000 + Math.floor(Math.random() * 90000));
    const campaignId = `CMP${suffix}`;
    const existing = await Campaign.exists({ campaignId });
    if (!existing) return campaignId;
  }
  throw new AppError('Unable to generate campaign ID', 500);
};

const createCampaign = async (data) => {
  const campaignId = await generateCampaignId();

  const campaign = await Campaign.create({
    ...data,
    campaignId,
    status: 'draft',
  });

  return Campaign.findById(campaign._id)
    .populate('templateId createdBy')
    .lean();
};

const send = async (campaignId) => {
  const campaign = await Campaign.findById(campaignId);
  if (!campaign) throw new AppError('Campaign not found', 404);

  if (campaign.status !== 'draft' && campaign.status !== 'paused') {
    throw new AppError('Campaign can only be sent from draft or paused status', 400);
  }

  campaign.status = 'sending';
  campaign.sendStartedAt = new Date();
  await campaign.save();

  return Campaign.findById(campaign._id)
    .populate('templateId createdBy')
    .lean();
};

const pause = async (campaignId) => {
  const campaign = await Campaign.findById(campaignId);
  if (!campaign) throw new AppError('Campaign not found', 404);

  if (campaign.status !== 'sending') {
    throw new AppError('Only a sending campaign can be paused', 400);
  }

  campaign.status = 'paused';
  await campaign.save();

  return Campaign.findById(campaign._id)
    .populate('templateId createdBy')
    .lean();
};

const resume = async (campaignId) => {
  const campaign = await Campaign.findById(campaignId);
  if (!campaign) throw new AppError('Campaign not found', 404);

  if (campaign.status !== 'paused') {
    throw new AppError('Only a paused campaign can be resumed', 400);
  }

  campaign.status = 'sending';
  await campaign.save();

  return Campaign.findById(campaign._id)
    .populate('templateId createdBy')
    .lean();
};

const getStats = async () => {
  const [result] = await Campaign.aggregate([
    {
      $facet: {
        byStatus: [{ $group: { _id: '$status', count: { $sum: 1 } } }],
        totalSent: [
          {
            $group: {
              _id: null,
              sent: { $sum: '$stats.sent' },
              failed: { $sum: '$stats.failed' },
              opened: { $sum: '$stats.opened' },
              totalRecipients: { $sum: '$stats.totalRecipients' },
            },
          },
        ],
      },
    },
  ]);

  const statusMap = {};
  (result.byStatus || []).forEach(({ _id, count }) => {
    statusMap[_id] = count;
  });

  const totals = result.totalSent?.[0] || {};

  return {
    byStatus: statusMap,
    total: Object.values(statusMap).reduce((sum, c) => sum + c, 0),
    totalSent: totals.sent || 0,
    totalFailed: totals.failed || 0,
    totalOpened: totals.opened || 0,
    totalRecipients: totals.totalRecipients || 0,
  };
};

module.exports = {
  campaigns: campaignCrud,
  createCampaign,
  send,
  pause,
  resume,
  getStats,
};
