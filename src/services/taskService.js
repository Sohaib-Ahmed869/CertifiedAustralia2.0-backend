const buildCrud = require('./commonCrud');
const Task = require('../models/Task');
const Application = require('../models/Application');
const User = require('../models/User');
const { notifyWithEmail } = require('./notificationService');

const taskCrud = buildCrud(Task, {
  populate: [
    { path: 'assignedTo', select: 'firstName lastName email' },
    { path: 'createdBy', select: 'firstName lastName' },
    { path: 'applicationId', select: 'applicationId studentId status', populate: { path: 'studentId', select: 'firstName lastName' } },
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

  // Auto-sync deadline to connected calendars if task has a due date
  if (data.dueDate && data.assignedTo) {
    try {
      const { syncDeadline } = require('./calendarService');
      await syncDeadline(data.assignedTo, {
        title: data.title,
        description: data.description || '',
        dueDate: data.dueDate,
      });
    } catch {
      // Non-fatal — calendar sync failure shouldn't block task creation
    }
  }

  return populated;
};

/**
 * Update a task. If the status changed, notify relevant parties:
 * - Agent updates status → notify the task creator (admin/CEO)
 * - Admin/CEO updates status → notify the assignee
 */
const updateTask = async (id, data, currentUser) => {
  const before = await Task.findById(id).lean();
  if (!before) return null;

  const oldStatus = before.status;
  const updated = await Task.findByIdAndUpdate(id, data, { new: true })
    .populate('assignedTo', 'firstName lastName email')
    .populate('createdBy', 'firstName lastName email role')
    .populate({
      path: 'applicationId',
      select: 'applicationId studentId qualificationId',
      populate: [
        { path: 'studentId', select: 'firstName lastName' },
        { path: 'qualificationId', select: 'name' },
      ],
    })
    .lean();

  // Only send notifications when status actually changed
  if (data.status && data.status !== oldStatus) {
    const statusLabels = { todo: 'To Do', in_progress: 'In Progress', done: 'Completed' };
    const newLabel = statusLabels[data.status] || data.status;
    const updaterName = `${currentUser.firstName} ${currentUser.lastName}`;

    const app = updated.applicationId;
    const studentName = app?.studentId
      ? `${app.studentId.firstName} ${app.studentId.lastName}`
      : null;
    const contextParts = [studentName, app?.applicationId].filter(Boolean);
    const context = contextParts.length > 0 ? ` (${contextParts.join(' — ')})` : '';

    // Notify the task creator when assignee updates status
    if (updated.createdBy && String(updated.createdBy._id) !== String(currentUser._id)) {
      await notifyWithEmail(
        updated.createdBy._id,
        {
          type: 'task_status_updated',
          title: `Task ${newLabel}: ${updated.title}`,
          message: `${updaterName} moved "${updated.title}" to ${newLabel}${context}`,
          link: app?.studentId ? `/admin/students/${app.studentId._id}` : '/admin/tasks',
          relatedId: updated._id,
        },
        {
          subject: `Task ${newLabel}: ${updated.title}`,
          ctaText: 'View Task',
        }
      );
    }

    // Notify the assignee when someone else (admin/CEO) updates status
    if (updated.assignedTo && String(updated.assignedTo._id) !== String(currentUser._id)
        && String(updated.assignedTo._id) !== String(updated.createdBy?._id)) {
      await notifyWithEmail(
        updated.assignedTo._id,
        {
          type: 'task_status_updated',
          title: `Task ${newLabel}: ${updated.title}`,
          message: `${updaterName} moved "${updated.title}" to ${newLabel}${context}`,
          link: app?.studentId ? `/admin/students/${app.studentId._id}` : '/admin/tasks',
          relatedId: updated._id,
        },
        {
          subject: `Task ${newLabel}: ${updated.title}`,
          ctaText: 'View Task',
        }
      );
    }
  }

  return updated;
};

module.exports = {
  tasks: taskCrud,
  createTask,
  updateTask,
};
