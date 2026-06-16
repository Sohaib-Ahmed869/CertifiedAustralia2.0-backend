const DynamicForm = require('../models/DynamicForm');
const FormSubmission = require('../models/FormSubmission');
const buildCrud = require('./commonCrud');
const AppError = require('../utils/AppError');

const forms = buildCrud(DynamicForm, {
  populate: [
    { path: 'qualificationIds', select: 'name' },
    { path: 'industryIds', select: 'name' },
    { path: 'createdBy', select: 'firstName lastName email' },
  ],
});

const submissions = buildCrud(FormSubmission, {
  populate: [
    { path: 'formId', select: 'name description fields version' },
    { path: 'applicationId', select: 'applicationId status' },
    { path: 'submittedBy', select: 'firstName lastName email' },
    { path: 'reviewedBy', select: 'firstName lastName email' },
  ],
});

/**
 * Duplicate a form — creates a copy with incremented version and draft status.
 */
const duplicateForm = async (id) => {
  const original = await DynamicForm.findById(id);
  if (!original) throw new AppError('Form not found', 404);

  const copy = original.toObject();
  delete copy._id;
  delete copy.createdAt;
  delete copy.updatedAt;
  copy.name = `${copy.name} (Copy)`;
  copy.status = 'draft';
  copy.version = (copy.version || 1) + 1;

  const created = await DynamicForm.create(copy);
  return created.toObject();
};

/**
 * Assign a form to one or more qualifications.
 */
const assignToQualifications = async (id, qualificationIds) => {
  const form = await DynamicForm.findByIdAndUpdate(
    id,
    { $addToSet: { qualificationIds: { $each: qualificationIds } } },
    { new: true, runValidators: true }
  ).populate('qualificationIds', 'name');

  if (!form) throw new AppError('Form not found', 404);
  return form.toObject();
};

/**
 * Detach a form from a qualification.
 */
const detachFromQualification = async (id, qualificationId) => {
  const form = await DynamicForm.findByIdAndUpdate(
    id,
    { $pull: { qualificationIds: qualificationId } },
    { new: true, runValidators: true }
  ).populate('qualificationIds', 'name');

  if (!form) throw new AppError('Form not found', 404);
  return form.toObject();
};

/**
 * List forms assigned to a specific qualification.
 */
const listByQualification = async (qualificationId) => {
  const items = await DynamicForm.find({
    qualificationIds: qualificationId,
    status: 'active',
  })
    .sort('displayOrder')
    .populate('qualificationIds', 'name')
    .lean();

  return { items };
};

/**
 * List submissions for a specific application.
 */
const listSubmissionsByApplication = async (applicationId) => {
  const items = await FormSubmission.find({ applicationId })
    .sort('-createdAt')
    .populate('formId', 'name description fields version')
    .populate('submittedBy', 'firstName lastName email')
    .populate('reviewedBy', 'firstName lastName email')
    .lean();

  return { items };
};

/**
 * Review a submission (approve/reject).
 */
const reviewSubmission = async (id, reviewData) => {
  const submission = await FormSubmission.findByIdAndUpdate(
    id,
    {
      status: reviewData.status,
      reviewedBy: reviewData.reviewedBy,
      reviewedAt: new Date(),
      reviewNotes: reviewData.reviewNotes || '',
    },
    { new: true, runValidators: true }
  )
    .populate('formId', 'name description fields version')
    .populate('submittedBy', 'firstName lastName email')
    .populate('reviewedBy', 'firstName lastName email');

  if (!submission) throw new AppError('Submission not found', 404);
  return submission.toObject();
};

module.exports = {
  forms,
  submissions,
  duplicateForm,
  assignToQualifications,
  detachFromQualification,
  listByQualification,
  listSubmissionsByApplication,
  reviewSubmission,
};
