const asyncHandler = require('../utils/asyncHandler');
const createCrudController = require('./crudController');
const service = require('../services/emailTemplateService');

const crud = createCrudController(service.templates);

module.exports = {
  ...crud,

  duplicate: asyncHandler(async (req, res) => {
    const result = await service.duplicateTemplate(req.params.id);
    res.status(201).json({ item: result });
  }),

  sendTemplate: asyncHandler(async (req, res) => {
    const { email, variables } = req.body;
    const result = await service.sendTemplate(req.params.id, email, variables);
    res.status(200).json(result);
  }),

  sendBulk: asyncHandler(async (req, res) => {
    const { recipients } = req.body;
    const result = await service.sendBulk(req.params.id, recipients);
    res.status(200).json(result);
  }),
};
