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

  /**
   * `{ key, label, hearAbout }` for every source, unauthenticated.
   *
   * The public RegisterPage is the caller: it needs to know, before the student ever
   * reaches the screening step, whether the link they arrived on already answers
   * "How did you hear about us?". No PII, no counts — just the label registry.
   *
   * `HEAR_ABOUT_OPTIONS` rides along so the register page can be told what a value
   * means without a second round trip.
   */
  publicList: asyncHandler(async (req, res) => {
    const items = await service.listPublic();
    res.status(200).json({ items, hearAboutOptions: service.HEAR_ABOUT_OPTIONS });
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
