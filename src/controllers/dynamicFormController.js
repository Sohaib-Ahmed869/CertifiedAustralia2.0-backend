const asyncHandler = require('../utils/asyncHandler');
const createCrudController = require('./crudController');
const service = require('../services/dynamicFormService');

const forms = createCrudController(service.forms);
const submissions = createCrudController(service.submissions);

module.exports = {
  // CRUD for dynamic forms
  ...forms,

  // Duplicate a form
  duplicateForm: asyncHandler(async (req, res) => {
    const result = await service.duplicateForm(req.params.id);
    res.status(201).json({ item: result });
  }),

  // Assign form to qualifications
  assignToQualifications: asyncHandler(async (req, res) => {
    const result = await service.assignToQualifications(
      req.params.id,
      req.body.qualificationIds
    );
    res.status(200).json({ item: result });
  }),

  // Detach form from a qualification
  detachFromQualification: asyncHandler(async (req, res) => {
    const result = await service.detachFromQualification(
      req.params.id,
      req.params.qualId
    );
    res.status(200).json({ item: result });
  }),

  // List forms for a specific qualification
  listByQualification: asyncHandler(async (req, res) => {
    const result = await service.listByQualification(req.params.qualId);
    res.status(200).json(result);
  }),

  // --- Form Submissions ---

  // List all submissions
  listSubmissions: submissions.list,
  getSubmission: submissions.getById,

  // Create a submission
  createSubmission: submissions.create,

  // Update a submission
  updateSubmission: submissions.update,

  // Delete a submission
  removeSubmission: submissions.remove,

  // List submissions for a specific application
  listSubmissionsByApplication: asyncHandler(async (req, res) => {
    const result = await service.listSubmissionsByApplication(req.params.appId);
    res.status(200).json(result);
  }),

  // Review a submission (approve/reject)
  reviewSubmission: asyncHandler(async (req, res) => {
    const result = await service.reviewSubmission(req.params.id, {
      ...req.body,
      reviewedBy: req.user._id,
    });
    res.status(200).json({ item: result });
  }),
};
