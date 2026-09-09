const buildCrud = require('./commonCrud');
const Industry = require('../models/Industry');
const Qualification = require('../models/Qualification');
const Checklist = require('../models/Checklist');
const ReferenceLetterTemplate = require('../models/ReferenceLetterTemplate');
const EmploymentLetterTemplate = require('../models/EmploymentLetterTemplate');
const AppError = require('../utils/AppError');
const { caPriceChangeBlockedBecause } = require('./priceFloorService');

/** Hard ceiling on one bulk run — a runaway selection shouldn't reprice the catalog. */
const BULK_ADJUST_MAX = 500;

/**
 * Shift `caPrice` by `amount` across many qualifications in one call — the
 * Pricing Controls "+$500 / −$500 to selected" action.
 *
 * PARTIAL BY DESIGN. A decrease that would take a qualification under its own
 * price floor or sweet spot is SKIPPED, not applied and not fatal, and comes
 * back in `skipped[]` with the reason. Failing the whole run because one of
 * forty rows has a floor in the way would make the feature unusable; silently
 * applying it would let a bulk button do what the single-edit gate refuses.
 *
 * Returns `{ amount, applied[], skipped[], summary }` — every requested id is
 * accounted for in exactly one of the two lists.
 */
async function bulkAdjustQualificationPrices({ qualificationIds, amount }) {
  const delta = Number(amount);
  if (!Number.isFinite(delta) || delta === 0) {
    throw new AppError('Provide a non-zero amount to adjust prices by', 400);
  }
  const ids = [...new Set((qualificationIds || []).map(String).filter(Boolean))];
  if (!ids.length) {
    throw new AppError('Select at least one qualification to adjust', 400);
  }
  if (ids.length > BULK_ADJUST_MAX) {
    throw new AppError(`Too many qualifications in one adjustment (limit ${BULK_ADJUST_MAX})`, 400);
  }

  const quals = await Qualification.find({ _id: { $in: ids } })
    .select('name caPrice priceFloor sweetSpot')
    .lean();

  const applied = [];
  const skipped = [];

  for (const qual of quals) {
    const from = Number(qual.caPrice || 0);
    const to = from + delta;
    if (to < 0) {
      skipped.push({ _id: qual._id, name: qual.name, caPrice: from, reason: 'That decrease would take the price below $0.' });
      continue;
    }
    const blocked = caPriceChangeBlockedBecause(qual, to);
    if (blocked) {
      skipped.push({ _id: qual._id, name: qual.name, caPrice: from, reason: blocked });
      continue;
    }
    applied.push({ _id: qual._id, name: qual.name, from, to });
  }

  // Ids that matched nothing are reported too, so the caller's counts always
  // add up to what it asked for.
  const seen = new Set(quals.map((q) => String(q._id)));
  for (const id of ids) {
    if (!seen.has(id)) skipped.push({ _id: id, name: 'Unknown qualification', reason: 'No longer exists.' });
  }

  if (applied.length) {
    const now = new Date();
    await Qualification.bulkWrite(
      applied.map((row) => ({
        updateOne: {
          filter: { _id: row._id },
          update: { $set: { caPrice: row.to, updatedAt: now } },
        },
      })),
    );
  }

  return {
    amount: delta,
    applied,
    skipped,
    summary: { requested: ids.length, applied: applied.length, skipped: skipped.length },
  };
}

module.exports = {
  bulkAdjustQualificationPrices,
  industries: buildCrud(Industry),
  qualifications: buildCrud(Qualification, {
    populate: ['industryId', 'checklistId', 'referenceLetterTemplateId', 'employmentLetterTemplateId'],
  }),
  checklists: buildCrud(Checklist, {
    populate: ['qualificationId'],
  }),
  referenceLetterTemplates: buildCrud(ReferenceLetterTemplate, {
    populate: ['qualificationId'],
  }),
  employmentLetterTemplates: buildCrud(EmploymentLetterTemplate, {
    populate: ['qualificationId'],
  }),
};
