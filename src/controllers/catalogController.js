const asyncHandler = require('../utils/asyncHandler');
const createCrudController = require('./crudController');
const services = require('../services/catalogService');

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
};
