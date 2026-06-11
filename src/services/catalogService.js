const buildCrud = require('./commonCrud');
const Industry = require('../models/Industry');
const Qualification = require('../models/Qualification');
const Checklist = require('../models/Checklist');
const ReferenceLetterTemplate = require('../models/ReferenceLetterTemplate');

module.exports = {
  industries: buildCrud(Industry),
  qualifications: buildCrud(Qualification, {
    populate: ['industryId', 'checklistId', 'referenceLetterTemplateId'],
  }),
  checklists: buildCrud(Checklist, {
    populate: ['qualificationId'],
  }),
  referenceLetterTemplates: buildCrud(ReferenceLetterTemplate, {
    populate: ['qualificationId'],
  }),
};
