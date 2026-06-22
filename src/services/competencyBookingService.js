const CompetencyBooking = require('../models/CompetencyBooking');
const AppError = require('../utils/AppError');

const POPULATE = [
  { path: 'applicationId', select: 'applicationId' },
  { path: 'studentId', select: 'firstName lastName' },
  { path: 'assessorId', select: 'firstName lastName email' },
  { path: 'rescheduledBy', select: 'firstName lastName' },
  { path: 'createdBy', select: 'firstName lastName' },
];

/**
 * Create a competency conversation booking.
 */
const create = async (data) => {
  // Check for overlapping bookings for this assessor
  const overlap = await checkOverlap(data.assessorId, data.scheduledAt, data.durationMinutes || 30);
  if (overlap) {
    throw new AppError('This time overlaps with an existing booking for this assessor', 409);
  }

  const booking = await CompetencyBooking.create(data);
  return CompetencyBooking.findById(booking._id).populate(POPULATE).lean();
};

/**
 * Assessor-initiated reschedule.
 */
const reschedule = async (id, { scheduledAt, reason, rescheduledBy }) => {
  const booking = await CompetencyBooking.findById(id);
  if (!booking) throw new AppError('Booking not found', 404);
  if (booking.status === 'completed' || booking.status === 'cancelled') {
    throw new AppError('Cannot reschedule a completed or cancelled booking', 400);
  }

  // Check overlaps at new time
  const overlap = await checkOverlap(booking.assessorId, scheduledAt, booking.durationMinutes, id);
  if (overlap) {
    throw new AppError('New time overlaps with another booking', 409);
  }

  booking.rescheduledFrom = booking.scheduledAt;
  booking.scheduledAt = new Date(scheduledAt);
  booking.rescheduledBy = rescheduledBy;
  booking.rescheduledAt = new Date();
  booking.rescheduleReason = reason || '';
  booking.status = 'rescheduled';
  booking.updatedAt = new Date();
  await booking.save();

  return CompetencyBooking.findById(id).populate(POPULATE).lean();
};

/**
 * Check for overlapping bookings for an assessor at a given time.
 * @param {string} assessorId
 * @param {Date} scheduledAt
 * @param {number} durationMinutes
 * @param {string} [excludeId] — booking ID to exclude (for rescheduling)
 * @returns {boolean} true if overlap exists
 */
const checkOverlap = async (assessorId, scheduledAt, durationMinutes = 30, excludeId = null) => {
  const start = new Date(scheduledAt);
  const end = new Date(start.getTime() + durationMinutes * 60 * 1000);

  const filter = {
    assessorId,
    status: { $in: ['scheduled', 'rescheduled'] },
    $or: [
      // New booking starts during existing
      { scheduledAt: { $lt: end, $gte: start } },
      // New booking ends during existing (existing starts before new ends)
      {
        $expr: {
          $lt: [
            '$scheduledAt',
            end,
          ],
        },
      },
    ],
  };

  // Simpler overlap check: any booking within the same time window
  const conflicting = await CompetencyBooking.find({
    assessorId,
    status: { $in: ['scheduled', 'rescheduled'] },
    scheduledAt: {
      $gte: new Date(start.getTime() - durationMinutes * 60 * 1000),
      $lt: end,
    },
    ...(excludeId ? { _id: { $ne: excludeId } } : {}),
  }).lean();

  return conflicting.length > 0;
};

/**
 * Get assessor availability — list bookings for a date range.
 */
const getAssessorBookings = async (assessorId, dateFrom, dateTo) => {
  return CompetencyBooking.find({
    assessorId,
    scheduledAt: {
      $gte: new Date(dateFrom),
      $lte: new Date(dateTo),
    },
    status: { $in: ['scheduled', 'rescheduled'] },
  })
    .populate(POPULATE)
    .sort({ scheduledAt: 1 })
    .lean();
};

/**
 * List all bookings with optional filters.
 */
const list = async (query = {}) => {
  const filter = {};
  if (query.assessorId) filter.assessorId = query.assessorId;
  if (query.studentId) filter.studentId = query.studentId;
  if (query.applicationId) filter.applicationId = query.applicationId;
  if (query.status) filter.status = query.status;

  if (query.dateFrom || query.dateTo) {
    filter.scheduledAt = {};
    if (query.dateFrom) filter.scheduledAt.$gte = new Date(query.dateFrom);
    if (query.dateTo) filter.scheduledAt.$lte = new Date(query.dateTo);
  }

  const page = parseInt(query.page, 10) || 1;
  const limit = parseInt(query.limit, 10) || 50;

  const [items, total] = await Promise.all([
    CompetencyBooking.find(filter)
      .populate(POPULATE)
      .sort({ scheduledAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    CompetencyBooking.countDocuments(filter),
  ]);

  return { items, pagination: { page, limit, total, pages: Math.ceil(total / limit) } };
};

/**
 * Complete a booking.
 */
const complete = async (id, { outcome, notes }) => {
  const booking = await CompetencyBooking.findById(id);
  if (!booking) throw new AppError('Booking not found', 404);

  booking.status = 'completed';
  booking.completedAt = new Date();
  booking.outcome = outcome || '';
  booking.notes = notes || '';
  booking.updatedAt = new Date();
  await booking.save();

  return CompetencyBooking.findById(id).populate(POPULATE).lean();
};

/**
 * Cancel a booking.
 */
const cancel = async (id) => {
  const booking = await CompetencyBooking.findById(id);
  if (!booking) throw new AppError('Booking not found', 404);

  booking.status = 'cancelled';
  booking.updatedAt = new Date();
  await booking.save();

  return CompetencyBooking.findById(id).populate(POPULATE).lean();
};

module.exports = { create, reschedule, checkOverlap, getAssessorBookings, list, complete, cancel };
