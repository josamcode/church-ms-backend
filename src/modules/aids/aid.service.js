const Aid = require('./aid.model');

class AidService {
  async createBulkAids(houseNames, aidData, recordedBy) {
    const payloads = houseNames.map((houseName) => ({
      houseName,
      category: aidData.category,
      occurrence: aidData.occurrence,
      description: aidData.description,
      notes: aidData.notes || null,
      date: new Date(aidData.date),
      recordedBy,
    }));

    if (payloads.length === 0) return [];

    const result = await Aid.insertMany(payloads);
    return result;
  }

  async getAidOptions() {
    const pipeline = [
      {
        $group: {
          _id: null,
          categories: { $addToSet: '$category' },
          occurrences: { $addToSet: '$occurrence' },
          descriptions: { $addToSet: '$description' },
        },
      },
      {
        $project: {
          _id: 0,
          categories: 1,
          occurrences: 1,
          descriptions: 1,
        },
      },
    ];

    const results = await Aid.aggregate(pipeline).exec();
    if (!results || results.length === 0) {
      return {
        categories: [],
        occurrences: [],
        descriptions: [],
      };
    }

    return results[0];
  }
  async getDisbursedAids({ page = 1, limit = 20, search, category }) {
    const skip = (page - 1) * limit;

    const pipeline = [];

    // Optional filtering match stage
    const matchFilters = {};
    if (search) {
      matchFilters.description = { $regex: search, $options: 'i' };
    }
    if (category) {
      matchFilters.category = category;
    }

    if (Object.keys(matchFilters).length > 0) {
      pipeline.push({ $match: matchFilters });
    }

    pipeline.push(
      {
        $group: {
          _id: {
            date: '$date',
            category: '$category',
            occurrence: '$occurrence',
            description: '$description',
          },
          beneficiariesCount: { $sum: 1 },
        },
      },
      {
        $project: {
          _id: 0,
          date: '$_id.date',
          category: '$_id.category',
          occurrence: '$_id.occurrence',
          description: '$_id.description',
          beneficiariesCount: 1,
        },
      },
      {
        $sort: { date: -1, category: 1, description: 1 },
      },
      {
        $facet: {
          metadata: [{ $count: 'total' }],
          data: [{ $skip: skip }, { $limit: limit }],
        },
      },
    );

    const results = await Aid.aggregate(pipeline).exec();
    const total = results[0]?.metadata[0]?.total || 0;
    const items = results[0]?.data || [];

    return {
      items,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  async getAidDetails({ date, category, occurrence, description }) {
    const exactDate = new Date(date);
    const aids = await Aid.find({
      date: exactDate,
      category,
      occurrence,
      description,
    })
      .sort({ houseName: 1 })
      .lean();

    return aids;
  }

  async updateFullAidGroup(originalGroup, updatedData, houseNames, recordedBy) {
    const { date, category, occurrence, description } = originalGroup;

    // 1. Delete all old records matching the exact original dimensions
    await Aid.deleteMany({
      date: new Date(date),
      category,
      occurrence,
      description,
    });

    // 2. Prepare new records using the updated dimensions and the fresh list of beneficiaries
    const payloads = houseNames.map((houseName) => ({
      houseName,
      category: updatedData.category,
      occurrence: updatedData.occurrence,
      description: updatedData.description,
      notes: updatedData.notes || null,
      date: new Date(updatedData.date),
      recordedBy,
    }));

    if (payloads.length === 0) return [];

    // 3. Insert the new set of records
    const result = await Aid.insertMany(payloads);
    return result;
  }
}

module.exports = new AidService();
