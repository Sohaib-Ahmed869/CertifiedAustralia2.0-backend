const asyncHandler = require('../utils/asyncHandler');
const createCrudController = require('./crudController');
const service = require('../services/campaignService');
const sendService = require('../services/campaignSendService');
const bounceService = require('../services/campaignBounceService');
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

  send: asyncHandler(async (req, res) => {
    const result = await service.send(req.params.id);
    sendService.startCampaign(req.params.id); // kick the async send worker
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
