const Campaign = require('../models/Campaign');
const AppError = require('../utils/AppError');
const buildCrud = require('./commonCrud');
const { normalizeApplicationIds } = require('../utils/applicationIds');

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

/**
 * Normalise an incoming audienceConfig:
 *  - display ids (APP95959) from the recipient picker → Application _ids
 *  - a top-level `filters` (the shape the campaign wizard sent before filters were
 *    stored) folded into audienceConfig.filters, where buildFilter reads them.
 */
const normalizeAudienceConfig = async (data) => {
  const cfg = { ...(data.audienceConfig || {}) };
  cfg.includeApplicationIds = await normalizeApplicationIds(cfg.includeApplicationIds);
  if (data.filters && !cfg.filters) cfg.filters = data.filters;
  return cfg;
};

const createCampaign = async (data) => {
  const campaignId = await generateCampaignId();
  const { filters, ...rest } = data; // `filters` lives inside audienceConfig

  const campaign = await Campaign.create({
    ...rest,
    audienceConfig: await normalizeAudienceConfig(data),
    campaignId,
    status: 'draft',
  });

  return Campaign.findById(campaign._id)
    .populate('templateId createdBy')
    .lean();
};

/**
 * Start sending NOW.
 *
 * `scheduled` is accepted as a start state so "Send now" on a scheduled campaign
 * works, and so the due-campaign cron can promote one without a second write path.
 * Clearing `scheduledAt` on the way through matters: leaving it set would let the
 * cron pick the same campaign up again on its next pass.
 */
const send = async (campaignId) => {
  const campaign = await Campaign.findById(campaignId);
  if (!campaign) throw new AppError('Campaign not found', 404);

  if (!['draft', 'scheduled', 'paused'].includes(campaign.status)) {
    throw new AppError('Campaign can only be sent from draft, scheduled or paused status', 400);
  }

  campaign.status = 'sending';
  campaign.sendStartedAt = new Date();
  campaign.scheduledAt = null;
  await campaign.save();

  return Campaign.findById(campaign._id)
    .populate('templateId createdBy')
    .lean();
};

/**
 * Queue a campaign for a future instant.
 *
 * `scheduledAt` is a UTC instant — the wizard converts the admin's AEST wall-clock
 * with `aestWallToUtcISO` before sending it, the same conversion a sequence step's
 * `sendAt` goes through, so "11:30" means 11:30 in Sydney regardless of where the
 * person setting it up (or the server) happens to be.
 */
const schedule = async (campaignId, scheduledAt, userId) => {
  const campaign = await Campaign.findById(campaignId);
  if (!campaign) throw new AppError('Campaign not found', 404);

  if (!['draft', 'scheduled'].includes(campaign.status)) {
    throw new AppError('Only a draft or already-scheduled campaign can be scheduled', 400);
  }

  const when = new Date(scheduledAt);
  if (Number.isNaN(when.getTime())) throw new AppError('A valid send time is required', 400);
  // A minute of slack absorbs the round trip from a clock that is slightly behind;
  // anything genuinely in the past is a mistake worth surfacing rather than sending
  // immediately, which is the behaviour this whole feature exists to stop.
  if (when.getTime() < Date.now() - 60 * 1000) {
    throw new AppError('That send time is in the past — pick a future time, or use Send Now', 400);
  }

  campaign.status = 'scheduled';
  campaign.scheduledAt = when;
  campaign.scheduledBy = userId || campaign.scheduledBy;
  campaign.lastError = undefined;
  await campaign.save();

  return Campaign.findById(campaign._id)
    .populate('templateId createdBy')
    .lean();
};

/** Pull a scheduled campaign back to draft. Nothing has been sent, so this is clean. */
const cancelSchedule = async (campaignId) => {
  const campaign = await Campaign.findById(campaignId);
  if (!campaign) throw new AppError('Campaign not found', 404);
  if (campaign.status !== 'scheduled') {
    throw new AppError('Only a scheduled campaign can be unscheduled', 400);
  }

  campaign.status = 'draft';
  campaign.scheduledAt = null;
  await campaign.save();

  return Campaign.findById(campaign._id)
    .populate('templateId createdBy')
    .lean();
};

/**
 * Promote every scheduled campaign whose instant has passed. Driven by the cron in
 * `schedulerService` and also swept once at boot, so a campaign whose time came
 * while the process was down still goes out (late) instead of being stranded
 * `scheduled` forever.
 *
 * The status flip is an ATOMIC findOneAndUpdate filtered on `status: 'scheduled'`.
 * Crons run in-process, so two backend instances would otherwise both read the same
 * due campaign and both start a worker for it — the whole audience mailed twice.
 * Only the instance that wins the flip dispatches. Same claim pattern as
 * `sequenceService.claimStep`.
 */
const runDueCampaigns = async () => {
  const due = await Campaign.find({ status: 'scheduled', scheduledAt: { $lte: new Date() } })
    .select('_id campaignId name')
    .lean();
  if (!due.length) return { started: 0 };

  const sendService = require('./campaignSendService');
  let started = 0;

  for (const row of due) {
    const claimed = await Campaign.findOneAndUpdate(
      { _id: row._id, status: 'scheduled' },
      { $set: { status: 'sending', sendStartedAt: new Date(), scheduledAt: null } },
      { new: true },
    );
    if (!claimed) continue; // another runner got there first

    console.log(`[Scheduler] Campaign ${row.campaignId} (${row.name}) reached its send time — starting`);
    started += 1;
    // Fire-and-forget: the worker is long-running and reports through its own
    // socket/status writes. Never awaited, or one big campaign blocks the rest.
    sendService.startCampaign(String(row._id));
  }

  return { started };
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
  schedule,
  cancelSchedule,
  runDueCampaigns,
  pause,
  resume,
  getStats,
};
