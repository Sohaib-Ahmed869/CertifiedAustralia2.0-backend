const asyncHandler = require('../utils/asyncHandler');
const createCrudController = require('./crudController');
const AppError = require('../utils/AppError');
const service = require('../services/rtoPartnerService');

const crud = createCrudController(service);

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// The whole point of this list is to hold a working submission address, so a malformed one
// is rejected at the edge rather than discovered when a package silently fails to send.
const validate = (body, { partial = false } = {}) => {
  const out = {};

  if (body.name !== undefined || !partial) {
    const name = String(body.name || '').trim();
    if (!name) throw new AppError('RTO name is required', 400);
    out.name = name;
  }

  if (body.email !== undefined || !partial) {
    const email = String(body.email || '').trim().toLowerCase();
    if (!email) throw new AppError('RTO email is required', 400);
    if (!EMAIL_RE.test(email)) throw new AppError(`"${email}" is not a valid email address`, 400);
    out.email = email;
  }

  if (body.isActive !== undefined) out.isActive = !!body.isActive;
  if (body.notes !== undefined) out.notes = String(body.notes || '').trim();

  return out;
};

const create = asyncHandler(async (req, res) => {
  const data = validate(req.body);
  const item = await service.create({ ...data, createdBy: req.user?._id });
  res.status(201).json({ item });
});

const update = asyncHandler(async (req, res) => {
  const data = validate(req.body, { partial: true });
  const item = await service.update(req.params.id, data);
  res.status(200).json({ item });
});

module.exports = {
  list: crud.list,
  getById: crud.getById,
  create,
  update,
  remove: crud.remove,
};
