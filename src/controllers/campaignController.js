const asyncHandler = require('../utils/asyncHandler');
const createCrudController = require('./crudController');
const service = require('../services/campaignService');

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
    res.status(200).json({ item: result });
  }),

  pause: asyncHandler(async (req, res) => {
    const result = await service.pause(req.params.id);
    res.status(200).json({ item: result });
  }),

  resume: asyncHandler(async (req, res) => {
    const result = await service.resume(req.params.id);
    res.status(200).json({ item: result });
  }),

  getStats: asyncHandler(async (req, res) => {
    const result = await service.getStats();
    res.status(200).json(result);
  }),
};
