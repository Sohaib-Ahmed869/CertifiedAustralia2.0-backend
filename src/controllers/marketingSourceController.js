const asyncHandler = require('../utils/asyncHandler');
const service = require('../services/marketingSourceService');

module.exports = {
  /**
   * The whole registry. `includeInactive=false` narrows it to the sources that are
   * still offered for new use — the link cards and pickers pass that, the dashboards
   * deliberately do not (retired sources must keep labelling their history).
   */
  list: asyncHandler(async (req, res) => {
    const items = req.query.includeInactive === 'false'
      ? await service.listActive()
      : await service.listAll();
    res.status(200).json({ items });
  }),

  create: asyncHandler(async (req, res) => {
    const item = await service.create(req.body, req.user?._id);
    res.status(201).json({ item });
  }),

  update: asyncHandler(async (req, res) => {
    const item = await service.update(req.params.id, req.body);
    res.status(200).json({ item });
  }),

  remove: asyncHandler(async (req, res) => {
    const result = await service.remove(req.params.id);
    res.status(200).json(result);
  }),
};
