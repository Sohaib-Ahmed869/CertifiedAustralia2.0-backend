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

  // Create a submission (with field validation)
  createSubmission: asyncHandler(async (req, res) => {
    const DynamicForm = require('../models/DynamicForm');
    const { formId, data, status } = req.body;

    // Only validate on final submit, not drafts
    if (status === 'submitted' && formId && data) {
      const form = await DynamicForm.findById(formId).lean();
      if (form?.fields) {
        const errors = [];
        for (const f of form.fields) {
          if (f.type === 'heading' || f.type === 'paragraph') continue;
          const val = data[f.fieldId];
          const v = f.validations || {};
          if (f.required && (val == null || val === '' || (Array.isArray(val) && val.length === 0))) {
            errors.push(`${f.label} is required`);
            continue;
          }
          if (!val) continue;
          const str = typeof val === 'string' ? val : '';
          if (v.minLength && str.length < v.minLength) errors.push(`${f.label}: min ${v.minLength} chars`);
          if (v.maxLength && str.length > v.maxLength) errors.push(`${f.label}: max ${v.maxLength} chars`);
          if (f.type === 'number' && v.min != null && Number(val) < v.min) errors.push(`${f.label}: min ${v.min}`);
          if (f.type === 'number' && v.max != null && Number(val) > v.max) errors.push(`${f.label}: max ${v.max}`);
          if (v.pattern && str && !new RegExp(v.pattern).test(str)) errors.push(`${f.label}: invalid format`);
        }
        if (errors.length > 0) {
          return res.status(400).json({ message: `Validation failed: ${errors[0]}`, errors });
        }
      }
    }
    const result = await service.submissions.create(req.body);
    res.status(201).json({ item: result });
  }),

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

  // Third-party form access
  setupThirdPartyAccess: asyncHandler(async (req, res) => {
    const results = await service.setupThirdPartyAccess({
      applicationId: req.body.applicationId,
      formId: req.body.formId,
      recipients: req.body.recipients,
      createdBy: req.user._id,
    });
    res.status(201).json({ items: results });
  }),
  validateThirdPartyToken: asyncHandler(async (req, res) => {
    const access = await service.validateThirdPartyToken(req.params.token);
    res.status(200).json({ access });
  }),
  submitThirdPartyForm: asyncHandler(async (req, res) => {
    const result = await service.submitThirdPartyForm(req.params.token, req.body.data);
    res.status(201).json({ item: result });
  }),
  listThirdPartyAccess: asyncHandler(async (req, res) => {
    const result = await service.listThirdPartyAccess(req.params.appId);
    res.status(200).json(result);
  }),

  // Email submissions to RTO
  emailToRTO: asyncHandler(async (req, res) => {
    const result = await service.emailSubmissionsToRTO(req.params.appId, {
      rtoEmail: req.body.rtoEmail,
      rtoName: req.body.rtoName,
      subject: req.body.subject,
      message: req.body.message,
    });
    res.status(200).json(result);
  }),

  // Draft operations
  getDraft: asyncHandler(async (req, res) => {
    const draft = await service.getDraft(req.params.appId, req.params.formId);
    res.status(200).json({ item: draft });
  }),
  saveDraft: asyncHandler(async (req, res) => {
    const result = await service.saveDraft(
      req.params.appId, req.params.formId,
      req.user._id, req.body.data
    );
    res.status(200).json({ item: result });
  }),
  deleteDraft: asyncHandler(async (req, res) => {
    await service.deleteDraft(req.params.appId, req.params.formId);
    res.status(200).json({ message: 'Draft deleted' });
  }),
};
