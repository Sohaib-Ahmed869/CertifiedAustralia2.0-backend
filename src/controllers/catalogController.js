const fs = require('fs');
const crypto = require('crypto');
const asyncHandler = require('../utils/asyncHandler');
const createCrudController = require('./crudController');
const AppError = require('../utils/AppError');
const services = require('../services/catalogService');
const Checklist = require('../models/Checklist');
const Qualification = require('../models/Qualification');
const ReferenceLetterTemplate = require('../models/ReferenceLetterTemplate');
const EmploymentLetterTemplate = require('../models/EmploymentLetterTemplate');
const driveService = require('../services/googleDriveService');
const {
  sanitizeFloor,
  sanitizeSweetSpot,
  assertThresholdsCoherent,
  assertCaPriceAllowed,
} = require('../services/priceFloorService');

const cleanupFile = (filePath) => {
  fs.unlink(filePath, () => {});
};

/* ── Custom checklist endpoints ── */

const getChecklistByQualification = asyncHandler(async (req, res) => {
  const checklist = await Checklist.findOne({
    qualificationId: req.params.qualificationId,
  }).lean();
  res.status(200).json({ item: checklist || null });
});

const upsertChecklist = asyncHandler(async (req, res) => {
  const { qualificationId } = req.params;
  const { rawText, units } = req.body;

  let checklist = await Checklist.findOne({ qualificationId });

  if (checklist) {
    checklist.rawText = rawText || '';
    checklist.units = units || [];
    checklist.updatedAt = new Date();
    await checklist.save();
  } else {
    checklist = await Checklist.create({
      qualificationId,
      rawText: rawText || '',
      units: units || [],
    });

    // Link checklist to qualification
    await Qualification.findByIdAndUpdate(qualificationId, {
      checklistId: checklist._id,
    });
  }

  res.status(200).json({ item: checklist });
});

/* ── Per-qualification letter templates (reference + employment) ──
   Both kinds behave identically — one file per qualification, versioned on
   replace, stored on Drive, linked back onto the Qualification. They differ
   only by model, Drive filename prefix, and which Qualification field points
   at them, so the handlers are generated rather than duplicated. */

const buildTemplateHandlers = ({ Model, drivePrefix, qualificationField }) => ({
  getByQualification: asyncHandler(async (req, res) => {
    const template = await Model.findOne({
      qualificationId: req.params.qualificationId,
    }).lean();
    res.status(200).json({ item: template || null });
  }),

  upload: asyncHandler(async (req, res) => {
    const { qualificationId } = req.body;
    if (!req.file) throw new AppError('No file provided', 400);
    if (!qualificationId) {
      cleanupFile(req.file.path);
      throw new AppError('qualificationId is required', 400);
    }

    const file = req.file;
    const ext = file.originalname.split('.').pop().toLowerCase();
    if (!['pdf', 'doc', 'docx'].includes(ext)) {
      cleanupFile(file.path);
      throw new AppError('Only PDF, DOC, and DOCX files are allowed', 400);
    }

    // Upload to Google Drive
    const driveName = `${drivePrefix}_${crypto.randomUUID()}_${file.originalname}`;
    const driveFile = await driveService.uploadFileFromDisk({
      filePath: file.path,
      fileName: driveName,
      mimeType: file.mimetype,
    });

    cleanupFile(file.path);

    // Upsert the template record
    let template = await Model.findOne({ qualificationId });

    if (template) {
      template.fileName = file.originalname;
      template.fileType = ext;
      template.googleDriveFileId = driveFile.id;
      template.googleDriveLink = driveFile.webViewLink;
      template.version = (template.version || 0) + 1;
      template.uploadedBy = req.user?._id;
      template.uploadedAt = new Date();
      template.updatedAt = new Date();
      await template.save();
    } else {
      template = await Model.create({
        qualificationId,
        fileName: file.originalname,
        fileType: ext,
        googleDriveFileId: driveFile.id,
        googleDriveLink: driveFile.webViewLink,
        uploadedBy: req.user?._id,
      });

      // Link template to qualification
      await Qualification.findByIdAndUpdate(qualificationId, {
        [qualificationField]: template._id,
      });
    }

    res.status(201).json({ item: template });
  }),
});

const refLetterHandlers = buildTemplateHandlers({
  Model: ReferenceLetterTemplate,
  drivePrefix: 'ref_template',
  qualificationField: 'referenceLetterTemplateId',
});

const empLetterHandlers = buildTemplateHandlers({
  Model: EmploymentLetterTemplate,
  drivePrefix: 'emp_template',
  qualificationField: 'employmentLetterTemplateId',
});

/* ── Qualification price thresholds (floor + sweet spot) ──────────
 * Qualification writes go through the generic CRUD factory, so the threshold
 * rules are enforced in these two thin wrappers around it — the ONE gate every
 * catalog edit passes. Both strip `priceFloor`, `sweetSpot` and their audit
 * fields from the payload: a floor writable by the request it constrains would
 * not be a restriction at all, and the sweet spot rides the same endpoint
 * because it shares the floor's invariant. Both are set only by setPriceFloor
 * below (Admin/CEO + feature_set_price_floor).
 *
 * `updateQualification` also refuses a `caPrice` under either threshold —
 * otherwise the discount cap would be sidestepped by simply re-pricing the
 * catalog. `bulkAdjustPrices` applies the same rule per row, but skips rather
 * than throws so one blocked row can't strand a whole run.
 */
const qualificationCrud = createCrudController(services.qualifications);

const stripThresholdFields = (body) => {
  delete body.priceFloor;
  delete body.priceFloorSetBy;
  delete body.priceFloorSetAt;
  delete body.sweetSpot;
  delete body.sweetSpotSetBy;
  delete body.sweetSpotSetAt;
};

const createQualification = asyncHandler(async (req, res, next) => {
  stripThresholdFields(req.body);
  return qualificationCrud.create(req, res, next);
});

const updateQualification = asyncHandler(async (req, res, next) => {
  stripThresholdFields(req.body);
  if (req.body.caPrice !== undefined) {
    const existing = await Qualification.findById(req.params.id)
      .select('caPrice priceFloor sweetSpot')
      .lean();
    assertCaPriceAllowed(existing, req.body.caPrice);
  }
  return qualificationCrud.update(req, res, next);
});

/**
 * Write the executive price thresholds — floor and sweet spot — for one
 * qualification. They share an endpoint because they share an invariant
 * (`floor <= sweetSpot <= caPrice`): saving them separately would mean either
 * order could transit through an incoherent state and be refused for it.
 *
 * Each field is optional in the payload; an omitted one keeps its stored value,
 * and an explicit `null`/`''` clears it.
 */
const setPriceFloor = asyncHandler(async (req, res) => {
  const qualification = await Qualification.findById(req.params.id);
  if (!qualification) {
    throw new AppError('Qualification not found', 404);
  }

  const floor = 'priceFloor' in (req.body || {})
    ? sanitizeFloor(req.body.priceFloor)
    : (qualification.priceFloor ?? null);
  const sweetSpot = 'sweetSpot' in (req.body || {})
    ? sanitizeSweetSpot(req.body.sweetSpot)
    : (qualification.sweetSpot ?? null);

  assertThresholdsCoherent({ caPrice: qualification.caPrice, priceFloor: floor, sweetSpot });

  const now = new Date();
  // Audit stamps only move when the value itself moved, so re-saving one
  // threshold doesn't rewrite the other's "set by / set at".
  if (floor !== (qualification.priceFloor ?? null)) {
    qualification.priceFloor = floor;
    qualification.priceFloorSetBy = floor === null ? undefined : req.user?._id;
    qualification.priceFloorSetAt = floor === null ? undefined : now;
  }
  if (sweetSpot !== (qualification.sweetSpot ?? null)) {
    qualification.sweetSpot = sweetSpot;
    qualification.sweetSpotSetBy = sweetSpot === null ? undefined : req.user?._id;
    qualification.sweetSpotSetAt = sweetSpot === null ? undefined : now;
  }
  qualification.updatedAt = now;
  await qualification.save();
  res.json({ item: qualification });
});

/**
 * Shift the LIST price of many qualifications at once (Pricing Controls'
 * +$500 / −$500 buttons). Rows blocked by their own floor/sweet spot are
 * skipped and reported — see the service for why partial is the right shape.
 */
const bulkAdjustPrices = asyncHandler(async (req, res) => {
  const result = await services.bulkAdjustQualificationPrices({
    qualificationIds: req.body?.qualificationIds,
    amount: req.body?.amount,
  });
  res.json(result);
});

module.exports = {
  industries: createCrudController(services.industries),
  qualifications: createCrudController(services.qualifications),
  checklists: createCrudController(services.checklists),
  referenceLetterTemplates: createCrudController(services.referenceLetterTemplates),
  employmentLetterTemplates: createCrudController(services.employmentLetterTemplates),
  createIndustry: createCrudController(services.industries).create,
  updateIndustry: createCrudController(services.industries).update,
  deleteIndustry: createCrudController(services.industries).remove,
  createQualification,
  updateQualification,
  setPriceFloor,
  bulkAdjustPrices,
  deleteQualification: createCrudController(services.qualifications).remove,
  createChecklist: createCrudController(services.checklists).create,
  updateChecklist: createCrudController(services.checklists).update,
  deleteChecklist: createCrudController(services.checklists).remove,
  createReferenceLetterTemplate: createCrudController(services.referenceLetterTemplates).create,
  updateReferenceLetterTemplate: createCrudController(services.referenceLetterTemplates).update,
  deleteReferenceLetterTemplate: createCrudController(services.referenceLetterTemplates).remove,
  createEmploymentLetterTemplate: createCrudController(services.employmentLetterTemplates).create,
  updateEmploymentLetterTemplate: createCrudController(services.employmentLetterTemplates).update,
  deleteEmploymentLetterTemplate: createCrudController(services.employmentLetterTemplates).remove,
  // Custom endpoints
  getChecklistByQualification,
  upsertChecklist,
  getTemplateByQualification: refLetterHandlers.getByQualification,
  uploadTemplate: refLetterHandlers.upload,
  getEmploymentTemplateByQualification: empLetterHandlers.getByQualification,
  uploadEmploymentTemplate: empLetterHandlers.upload,
};
