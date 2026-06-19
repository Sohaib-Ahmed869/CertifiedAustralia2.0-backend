const asyncHandler = require('../utils/asyncHandler');
const createCrudController = require('./crudController');
const service = require('../services/mailboxService');

const mailboxes = createCrudController(service.mailboxes);

module.exports = {
  ...mailboxes,

  connect: asyncHandler(async (req, res) => {
    const result = await service.connect({
      ...req.body,
      createdBy: req.user._id,
    });
    res.status(201).json({ item: result });
  }),

  verify: asyncHandler(async (req, res) => {
    const result = await service.verify(req.params.id);
    res.status(200).json({ item: result });
  }),

  disconnect: asyncHandler(async (req, res) => {
    const result = await service.disconnect(req.params.id);
    res.status(200).json({ item: result });
  }),

  updateConfig: asyncHandler(async (req, res) => {
    const result = await service.updateConfig(req.params.id, req.body);
    res.status(200).json({ item: result });
  }),
};
