const asyncHandler = require('../utils/asyncHandler');
const createCrudController = require('./crudController');
const service = require('../services/campaignService');
const sendService = require('../services/campaignSendService');
const bounceService = require('../services/campaignBounceService');
const audienceService = require('../services/audienceService');
const CampaignRecipient = require('../models/CampaignRecipient');

const campaigns = createCrudController(service.campaigns);

module.exports = {
  ...campaigns,

  createCampaign: asyncHandler(async (req, res) => {
    const result = await service.createCampaign({
      ...req.body,
      createdBy: req.user._id,
    });
    res.status(201).json({ item: result });
  }),

  // Preview count for the wizard's audience step. Runs the SAME resolver the send
  // uses (deduped one-per-student), so the estimate can't disagree with the send —
  // it previously counted applications off the generic list endpoint and over-counted
  // any student with more than one application.
  getAudienceCount: asyncHandler(async (req, res) => {
    const audienceConfig = req.body.audienceConfig || req.body || {};
    const result = await audienceService.countAudience(audienceConfig);
    res.status(200).json(result);
  }),

  send: asyncHandler(async (req, res) => {
    const result = await service.send(req.params.id);
    sendService.startCampaign(req.params.id); // kick the async send worker
    res.status(200).json({ item: result });
  }),

  // Queue for a future instant. `scheduledAt` is UTC — the wizard converts the
  // admin's AEST wall-clock before posting, same as a sequence step.
  schedule: asyncHandler(async (req, res) => {
    const result = await service.schedule(req.params.id, req.body.scheduledAt, req.user?._id);
    res.status(200).json({ item: result });
  }),

  cancelSchedule: asyncHandler(async (req, res) => {
    const result = await service.cancelSchedule(req.params.id);
    res.status(200).json({ item: result });
  }),

  pause: asyncHandler(async (req, res) => {
    const result = await service.pause(req.params.id);
    res.status(200).json({ item: result });
  }),

  resume: asyncHandler(async (req, res) => {
    const result = await service.resume(req.params.id);
    sendService.startCampaign(req.params.id); // resume the async send worker
    res.status(200).json({ item: result });
  }),

  getStats: asyncHandler(async (req, res) => {
    const result = await service.getStats();
    res.status(200).json(result);
  }),

  // Per-recipient rows (paginated) — powers the campaign detail table.
  getRecipients: asyncHandler(async (req, res) => {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(200, parseInt(req.query.limit, 10) || 50);
    const filter = { campaignId: req.params.id };
    if (req.query.status) filter.status = req.query.status;

    const [items, total] = await Promise.all([
      CampaignRecipient.find(filter)
        .select('email recipientName status sentAt bouncedAt bounceCheckedAt openedAt openCount failureReason failureCode')
        .sort({ createdAt: 1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      CampaignRecipient.countDocuments(filter),
    ]);
    res.status(200).json({ items, pagination: { page, limit, total, pages: Math.ceil(total / limit) } });
  }),

  // Manual "Check now" — polls the sending mailboxes over IMAP for bounce DSNs.
  checkBounces: asyncHandler(async (req, res) => {
    const result = await bounceService.pollAll();
    res.status(200).json(result);
  }),
};
