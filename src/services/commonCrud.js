const AppError = require('../utils/AppError');

const buildCrud = (Model, options = {}) => {
  const populate = options.populate || [];

  const applyPopulate = (query) => {
    if (!populate.length) {
      return query;
    }

    return populate.reduce((accumulator, item) => accumulator.populate(item), query);
  };

  return {
    async list(query = {}) {
      const page = Number(query.page || 1);
      const limit = Number(query.limit || 20);
      const sort = query.sort || '-createdAt';
      const filter = { ...query };

      delete filter.page;
      delete filter.limit;
      delete filter.sort;
      delete filter.populate;

      // Handle comma-separated status filter → $in query
      if (filter.status && typeof filter.status === 'string' && filter.status.includes(',')) {
        filter.status = { $in: filter.status.split(',').map((s) => s.trim()) };
      }

      // Handle excludeStatus — exclude specific status(es) from results
      if (filter.excludeStatus) {
        const excluded = filter.excludeStatus.includes(',')
          ? filter.excludeStatus.split(',').map((s) => s.trim())
          : [filter.excludeStatus];
        filter.status = filter.status
          ? { ...filter.status, $nin: excluded }
          : { $nin: excluded };
        delete filter.excludeStatus;
      }

      // Handle excludeRole — exclude specific role(s) from results (e.g. staff-only lists)
      if (filter.excludeRole) {
        const excluded = filter.excludeRole.includes(',')
          ? filter.excludeRole.split(',').map((s) => s.trim())
          : [filter.excludeRole];
        filter.role = filter.role
          ? { ...filter.role, $nin: excluded }
          : { $nin: excluded };
        delete filter.excludeRole;
      }

      // Handle callAttempts filter (contactAttempts on Application model)
      if (filter.callAttempts !== undefined) {
        const val = filter.callAttempts;
        delete filter.callAttempts;
        if (val === '5+') {
          filter.contactAttempts = { $gte: 5 };
        } else {
          filter.contactAttempts = Number(val);
        }
      }

      // Handle dateFrom/dateTo → createdAt range filter
      if (filter.dateFrom || filter.dateTo) {
        const dateRange = {};
        if (filter.dateFrom) {
          const d = new Date(filter.dateFrom);
          if (!isNaN(d.getTime())) dateRange.$gte = d;
        }
        if (filter.dateTo) {
          const d = new Date(filter.dateTo);
          if (!isNaN(d.getTime())) {
            d.setHours(23, 59, 59, 999);
            dateRange.$lte = d;
          }
        }
        if (Object.keys(dateRange).length) filter.createdAt = dateRange;
        delete filter.dateFrom;
        delete filter.dateTo;
      }

      // Handle period preset → createdAt range filter
      if (filter.period) {
        const now = new Date();
        let from = null;
        switch (filter.period) {
          case '7d':  from = new Date(now.getTime() - 7 * 86400000); break;
          case '15d': from = new Date(now.getTime() - 15 * 86400000); break;
          case '1m':  from = new Date(now); from.setMonth(from.getMonth() - 1); break;
          case '3m':  from = new Date(now); from.setMonth(from.getMonth() - 3); break;
          case '6m':  from = new Date(now); from.setMonth(from.getMonth() - 6); break;
          case '1y':  from = new Date(now); from.setFullYear(from.getFullYear() - 1); break;
          default: break; // 'all' or unknown — no filter
        }
        if (from) {
          filter.createdAt = { ...(filter.createdAt || {}), $gte: from };
        }
        delete filter.period;
      }

      // Strip state filter — not a direct field on Application (handled via ScreeningForm)
      delete filter.state;

      // Handle text search — convert `search` param to a regex on name/email/title fields
      const searchTerm = filter.search;
      delete filter.search;
      if (searchTerm) {
        const regex = { $regex: searchTerm, $options: 'i' };
        const orConditions = [
          { name: regex },
          { title: regex },
          { email: regex },
          { firstName: regex },
          { lastName: regex },
          { applicationId: regex },
        ];

        // For models with studentId field: also search by student name/email
        if (Model.schema.path('studentId')) {
          try {
            const User = require('../models/User');
            const matchingUsers = await User.find({
              $or: [{ firstName: regex }, { lastName: regex }, { email: regex }],
            }).select('_id').lean();
            if (matchingUsers.length > 0) {
              orConditions.push({ studentId: { $in: matchingUsers.map((u) => u._id) } });
            }
          } catch { /* ignore */ }
        }

        filter.$or = orConditions;
      }

      const mongoQuery = applyPopulate(Model.find(filter).sort(sort))
        .skip((page - 1) * limit)
        .limit(limit);

      const [items, total] = await Promise.all([
        mongoQuery.lean(),
        Model.countDocuments(filter),
      ]);

      return {
        items,
        pagination: {
          page,
          limit,
          total,
          pages: Math.ceil(total / limit),
        },
      };
    },

    async getById(id) {
      const query = applyPopulate(Model.findById(id));
      const item = await query.lean();

      if (!item) {
        throw new AppError('Resource not found', 404);
      }

      return item;
    },

    async create(data) {
      const item = await Model.create(data);
      return item.toObject();
    },

    async update(id, data) {
      const item = await Model.findByIdAndUpdate(id, data, {
        new: true,
        runValidators: true,
      });

      if (!item) {
        throw new AppError('Resource not found', 404);
      }

      return item.toObject();
    },

    async remove(id) {
      const item = await Model.findByIdAndDelete(id);

      if (!item) {
        throw new AppError('Resource not found', 404);
      }

      return item.toObject();
    },
  };
};

module.exports = buildCrud;
