const fs = require('fs');
const crypto = require('crypto');
const asyncHandler = require('../utils/asyncHandler');
const createCrudController = require('./crudController');
const AppError = require('../utils/AppError');
const services = require('../services/catalogService');
const Checklist = require('../models/Checklist');
const Qualification = require('../models/Qualification');
const ReferenceLetterTemplate = require('../models/ReferenceLetterTemplate');
const driveService = require('../services/googleDriveService');

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

/* ── Custom reference letter template endpoints ── */

const getTemplateByQualification = asyncHandler(async (req, res) => {
  const template = await ReferenceLetterTemplate.findOne({
    qualificationId: req.params.qualificationId,
  }).lean();
  res.status(200).json({ item: template || null });
});

const uploadTemplate = asyncHandler(async (req, res) => {
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
  const driveName = `ref_template_${crypto.randomUUID()}_${file.originalname}`;
  const driveFile = await driveService.uploadFileFromDisk({
    filePath: file.path,
    fileName: driveName,
    mimeType: file.mimetype,
  });

  cleanupFile(file.path);

  // Upsert the template record
  let template = await ReferenceLetterTemplate.findOne({ qualificationId });

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
    template = await ReferenceLetterTemplate.create({
      qualificationId,
      fileName: file.originalname,
      fileType: ext,
      googleDriveFileId: driveFile.id,
      googleDriveLink: driveFile.webViewLink,
      uploadedBy: req.user?._id,
    });

    // Link template to qualification
    await Qualification.findByIdAndUpdate(qualificationId, {
      referenceLetterTemplateId: template._id,
    });
  }

  res.status(201).json({ item: template });
});

module.exports = {
  industries: createCrudController(services.industries),
  qualifications: createCrudController(services.qualifications),
  checklists: createCrudController(services.checklists),
  referenceLetterTemplates: createCrudController(services.referenceLetterTemplates),
  createIndustry: createCrudController(services.industries).create,
  updateIndustry: createCrudController(services.industries).update,
  deleteIndustry: createCrudController(services.industries).remove,
  createQualification: createCrudController(services.qualifications).create,
  updateQualification: createCrudController(services.qualifications).update,
  deleteQualification: createCrudController(services.qualifications).remove,
  createChecklist: createCrudController(services.checklists).create,
  updateChecklist: createCrudController(services.checklists).update,
  deleteChecklist: createCrudController(services.checklists).remove,
  createReferenceLetterTemplate: createCrudController(services.referenceLetterTemplates).create,
  updateReferenceLetterTemplate: createCrudController(services.referenceLetterTemplates).update,
  deleteReferenceLetterTemplate: createCrudController(services.referenceLetterTemplates).remove,
  // Custom endpoints
  getChecklistByQualification,
  upsertChecklist,
  getTemplateByQualification,
  uploadTemplate,
};
