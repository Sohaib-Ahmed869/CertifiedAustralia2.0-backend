const express = require('express');
const controller = require('../controllers/catalogController');
const upload = require('../middleware/upload');

const router = express.Router();

router.route('/industries')
  .get(controller.industries.list)
  .post(controller.createIndustry);

router.route('/industries/:id')
  .get(controller.industries.getById)
  .patch(controller.updateIndustry)
  .delete(controller.deleteIndustry);

router.route('/qualifications')
  .get(controller.qualifications.list)
  .post(controller.createQualification);

router.route('/qualifications/:id')
  .get(controller.qualifications.getById)
  .patch(controller.updateQualification)
  .delete(controller.deleteQualification);

// Custom checklist endpoints — declared before /:id to avoid param collision
router.get('/checklists/by-qualification/:qualificationId', controller.getChecklistByQualification);
router.put('/checklists/by-qualification/:qualificationId', controller.upsertChecklist);

router.route('/checklists')
  .get(controller.checklists.list)
  .post(controller.createChecklist);

router.route('/checklists/:id')
  .get(controller.checklists.getById)
  .patch(controller.updateChecklist)
  .delete(controller.deleteChecklist);

// Custom reference letter template endpoints — declared before /:id
router.get('/reference-letter-templates/by-qualification/:qualificationId', controller.getTemplateByQualification);
router.post('/reference-letter-templates/upload', upload.single('file'), controller.uploadTemplate);

router.route('/reference-letter-templates')
  .get(controller.referenceLetterTemplates.list)
  .post(controller.createReferenceLetterTemplate);

router.route('/reference-letter-templates/:id')
  .get(controller.referenceLetterTemplates.getById)
  .patch(controller.updateReferenceLetterTemplate)
  .delete(controller.deleteReferenceLetterTemplate);

module.exports = router;
