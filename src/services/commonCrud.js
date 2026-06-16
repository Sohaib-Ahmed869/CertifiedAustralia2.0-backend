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

      // Handle text search — convert `search` param to a regex on name/email/title fields
      const searchTerm = filter.search;
      delete filter.search;
      if (searchTerm) {
        const regex = { $regex: searchTerm, $options: 'i' };
        filter.$or = [
          { name: regex },
          { title: regex },
          { email: regex },
          { firstName: regex },
          { lastName: regex },
          { applicationId: regex },
        ];
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
