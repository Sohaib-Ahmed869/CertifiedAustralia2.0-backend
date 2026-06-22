const buildCrud = require('./commonCrud');
const Task = require('../models/Task');
const Application = require('../models/Application');
const User = require('../models/User');
const { notifyWithEmail } = require('./notificationService');

const taskCrud = buildCrud(Task, {
  populate: [
    { path: 'assignedTo', select: 'firstName lastName email' },
    { path: 'createdBy', select: 'firstName lastName' },
    { path: 'applicationId', select: 'applicationId studentId status' },
  ],
});

/**
 * Create a task and notify the assignee (in-portal + email).
 * Enriches notification with student name + qualification.
 */
const createTask = async (data) => {
  const task = await Task.create(data);

  const populated = await Task.findById(task._id)
    .populate('assignedTo', 'firstName lastName email')
    .populate('createdBy', 'firstName lastName')
    .populate({
      path: 'applicationId',
      select: 'applicationId studentId qualificationId',
      populate: [
        { path: 'studentId', select: 'firstName lastName' },
        { path: 'qualificationId', select: 'name' },
      ],
    })
    .lean();

  // Send notification to assignee
  if (data.assignedTo && String(data.assignedTo) !== String(data.createdBy)) {
    const app = populated.applicationId;
    const studentName = app?.studentId
      ? `${app.studentId.firstName} ${app.studentId.lastName}`
      : null;
    const qualName = app?.qualificationId?.name;
    const appId = app?.applicationId;

    const contextParts = [studentName, qualName, appId].filter(Boolean);
    const context = contextParts.length > 0 ? ` (${contextParts.join(' — ')})` : '';

    const creatorName = populated.createdBy
      ? `${populated.createdBy.firstName} ${populated.createdBy.lastName}`
      : 'Someone';

    const link = app?.studentId
      ? `/admin/students/${app.studentId._id}`
      : '/admin/tasks';

    await notifyWithEmail(
      data.assignedTo,
      {
        type: 'task_assigned',
        title: `New Task: ${data.title}`,
        message: `${creatorName} assigned you a task${context}`,
        link,
        relatedId: task._id,
      },
      {
        subject: `Task Assigned: ${data.title}`,
        ctaText: 'View Task',
      }
    );
  }

  return populated;
};

module.exports = {
  tasks: taskCrud,
  createTask,
};
