const asyncHandler = require('../utils/asyncHandler');
const Application = require('../models/Application');
const User = require('../models/User');
const Task = require('../models/Task');
const Ticket = require('../models/Ticket');
const Payment = require('../models/Payment');

module.exports = {
  globalSearch: asyncHandler(async (req, res) => {
    const { q } = req.query;
    if (!q || q.trim().length < 2) {
      return res.status(200).json({ results: [] });
    }

    const term = q.trim();
    const regex = { $regex: term, $options: 'i' };
    const limit = 5; // per category

    // Run all searches in parallel
    const [applications, students, tasks, tickets, payments] = await Promise.all([
      // Applications — search by applicationId or status
      Application.find({
        $or: [
          { applicationId: regex },
          { status: regex },
        ],
      })
        .populate('studentId', 'firstName lastName email')
        .populate('qualificationId', 'name')
        .populate('industryId', 'name')
        .select('applicationId status studentId qualificationId industryId createdAt')
        .sort('-createdAt')
        .limit(limit)
        .lean(),

      // Students — search by name, email, phone
      User.find({
        $or: [
          { firstName: regex },
          { lastName: regex },
          { email: regex },
          { phone: regex },
        ],
      })
        .select('firstName lastName email phone role userType isActive createdAt')
        .sort('-createdAt')
        .limit(limit)
        .lean(),

      // Tasks — search by title
      Task.find({ title: regex })
        .populate('assignedTo', 'firstName lastName')
        .populate('applicationId', 'applicationId')
        .select('title status priority assignedTo applicationId dueDate createdAt')
        .sort('-createdAt')
        .limit(limit)
        .lean(),

      // Tickets — search by title or ticketId
      Ticket.find({
        $or: [
          { title: regex },
          { ticketId: regex },
        ],
      })
        .populate('requesterId', 'firstName lastName')
        .select('ticketId title status priority requesterId createdAt')
        .sort('-createdAt')
        .limit(limit)
        .lean(),

      // Payments — search by type or notes
      Payment.find({
        $or: [
          { type: regex },
          { notes: regex },
        ],
      })
        .populate('studentId', 'firstName lastName')
        .populate('applicationId', 'applicationId')
        .select('type amount status studentId applicationId notes createdAt')
        .sort('-createdAt')
        .limit(limit)
        .lean(),
    ]);

    // Also search applications by student name (separate query since it needs user lookup)
    let appsByStudent = [];
    if (students.length > 0) {
      const studentIds = students.map((s) => s._id);
      appsByStudent = await Application.find({ studentId: { $in: studentIds } })
        .populate('studentId', 'firstName lastName email')
        .populate('qualificationId', 'name')
        .populate('industryId', 'name')
        .select('applicationId status studentId qualificationId industryId createdAt')
        .sort('-createdAt')
        .limit(limit)
        .lean();
    }

    // Merge and deduplicate applications
    const appMap = new Map();
    [...applications, ...appsByStudent].forEach((a) => appMap.set(a._id.toString(), a));
    const mergedApps = [...appMap.values()].slice(0, limit);

    res.status(200).json({
      results: {
        applications: mergedApps,
        students,
        tasks,
        tickets,
        payments,
      },
      query: term,
    });
  }),
};
