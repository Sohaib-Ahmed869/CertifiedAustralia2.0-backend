const asyncHandler = require('../utils/asyncHandler');

const createCrudController = (service) => ({
  list: asyncHandler(async (req, res) => {
    const result = await service.list(req.query);
    res.status(200).json(result);
  }),

  getById: asyncHandler(async (req, res) => {
    const result = await service.getById(req.params.id);
    res.status(200).json({ item: result });
  }),

  create: asyncHandler(async (req, res) => {
    const result = await service.create(req.body);
    res.status(201).json({ item: result });
  }),

  update: asyncHandler(async (req, res) => {
    const result = await service.update(req.params.id, req.body);
    res.status(200).json({ item: result });
  }),

  remove: asyncHandler(async (req, res) => {
    const result = await service.remove(req.params.id);
    res.status(200).json({ item: result });
  }),
});

module.exports = createCrudController;
