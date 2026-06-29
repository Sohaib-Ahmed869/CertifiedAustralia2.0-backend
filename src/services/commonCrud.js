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
