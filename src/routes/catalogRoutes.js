const express = require('express');
const controller = require('../controllers/catalogController');
const upload = require('../middleware/upload');
const { protect, authorize } = require('../middleware/auth');

const router = express.Router();

// Industries & qualifications LISTS are intentionally public — the unauthenticated
// registration page needs them to populate its dropdowns. All mutations, and all
// reads of internal catalog data (checklists, reference-letter templates), require auth.
const requireStaff = [protect, authorize('Admin', 'CEOReportingManager', 'Agent', 'Marketing')];

router.route('/industries')
  .get(controller.industries.list)
  .post(requireStaff, controller.createIndustry);

router.route('/industries/:id')
  .get(controller.industries.getById)
  .patch(requireStaff, controller.updateIndustry)
  .delete(requireStaff, controller.deleteIndustry);

router.route('/qualifications')
  .get(controller.qualifications.list)
  .post(requireStaff, controller.createQualification);

router.route('/qualifications/:id')
  .get(controller.qualifications.getById)
  .patch(requireStaff, controller.updateQualification)
  .delete(requireStaff, controller.deleteQualification);

// Custom checklist endpoints — declared before /:id to avoid param collision
router.get('/checklists/by-qualification/:qualificationId', protect, controller.getChecklistByQualification);
router.put('/checklists/by-qualification/:qualificationId', requireStaff, controller.upsertChecklist);

router.route('/checklists')
  .get(protect, controller.checklists.list)
  .post(requireStaff, controller.createChecklist);

router.route('/checklists/:id')
  .get(protect, controller.checklists.getById)
  .patch(requireStaff, controller.updateChecklist)
  .delete(requireStaff, controller.deleteChecklist);

// Custom reference letter template endpoints — declared before /:id
router.get('/reference-letter-templates/by-qualification/:qualificationId', protect, controller.getTemplateByQualification);
router.post('/reference-letter-templates/upload', requireStaff, upload.single('file'), controller.uploadTemplate);

router.route('/reference-letter-templates')
  .get(protect, controller.referenceLetterTemplates.list)
  .post(requireStaff, controller.createReferenceLetterTemplate);

router.route('/reference-letter-templates/:id')
  .get(protect, controller.referenceLetterTemplates.getById)
  .patch(requireStaff, controller.updateReferenceLetterTemplate)
  .delete(requireStaff, controller.deleteReferenceLetterTemplate);

// Custom employment letter template endpoints — declared before /:id
router.get('/employment-letter-templates/by-qualification/:qualificationId', protect, controller.getEmploymentTemplateByQualification);
router.post('/employment-letter-templates/upload', requireStaff, upload.single('file'), controller.uploadEmploymentTemplate);

router.route('/employment-letter-templates')
  .get(protect, controller.employmentLetterTemplates.list)
  .post(requireStaff, controller.createEmploymentLetterTemplate);

router.route('/employment-letter-templates/:id')
  .get(protect, controller.employmentLetterTemplates.getById)
  .patch(requireStaff, controller.updateEmploymentLetterTemplate)
  .delete(requireStaff, controller.deleteEmploymentLetterTemplate);

module.exports = router;
