const Aid = require('./aid.model');
const aidReminderService = require('./aidReminder.service');
const Notification = require('../notifications/notification.model');
const ApiError = require('../../utils/ApiError');
const {
  getAidOccurrenceFrequency,
  normalizeAidOccurrence,
  normalizeAidOccurrenceOptions,
  isSameUtcDay,
  toUtcDate,
} = require('./aidOccurrence.utils');

class AidService {
  async createBulkAids(houseNames, aidData, recordedBy) {
    const normalizedOccurrence = normalizeAidOccurrence(aidData.occurrence);
    const aidDate = new Date(aidData.date);
    const payloads = houseNames.map((houseName) => ({
      houseName,
      category: aidData.category,
      occurrence: normalizedOccurrence,
      description: aidData.description,
      notes: aidData.notes || null,
      date: aidDate,
      recordedBy,
      recurrenceAnchorDate: aidDate,
    }));

    if (payloads.length === 0) return [];

    const result = await Aid.insertMany(payloads);
    await aidReminderService.syncDueReminderForGroup({
      date: aidData.date,
      category: aidData.category,
      occurrence: normalizedOccurrence,
      description: aidData.description,
      notes: aidData.notes || null,
      recordedBy,
      beneficiariesCount: payloads.length,
    });
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
        occurrences: normalizeAidOccurrenceOptions(),
        descriptions: [],
      };
    }

    return {
      ...results[0],
      occurrences: normalizeAidOccurrenceOptions(results[0].occurrences),
    };
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
    const normalizedOccurrence = normalizeAidOccurrence(updatedData.occurrence);
    const updatedDate = new Date(updatedData.date);

    // 1. Delete all old records matching the exact original dimensions
    await Aid.deleteMany({
      date: new Date(date),
      category,
      occurrence,
      description,
    });
    await aidReminderService.deleteRemindersForGroup(originalGroup);

    // 2. Prepare new records using the updated dimensions and the fresh list of beneficiaries
    const payloads = houseNames.map((houseName) => ({
      houseName,
      category: updatedData.category,
      occurrence: normalizedOccurrence,
      description: updatedData.description,
      notes: updatedData.notes || null,
      date: updatedDate,
      recordedBy,
      recurrenceAnchorDate: updatedDate,
    }));

    if (payloads.length === 0) return [];

    // 3. Insert the new set of records
    const result = await Aid.insertMany(payloads);
    await aidReminderService.syncDueReminderForGroup({
      date: updatedData.date,
      category: updatedData.category,
      occurrence: normalizedOccurrence,
      description: updatedData.description,
      notes: updatedData.notes || null,
      recordedBy,
      beneficiariesCount: payloads.length,
    });
    return result;
  }

  async approveAidReminder(notificationId, recordedBy) {
    const notification = await Notification.findById(notificationId);
    if (!notification) {
      throw ApiError.notFound('Aid reminder not found', 'RESOURCE_NOT_FOUND');
    }

    if (notification.sourceType !== 'aid_recurring') {
      throw ApiError.badRequest('Notification is not an aid reminder', 'VALIDATION_ERROR');
    }

    const reminderData = notification.sourceData || {};
    const normalizedOccurrence = normalizeAidOccurrence(reminderData.occurrence);
    const dueDate = toUtcDate(reminderData.dueDate || notification.eventDate);
    const originalDate = toUtcDate(reminderData.originalDate);
    const today = toUtcDate(new Date());

    if (!dueDate || !originalDate) {
      throw ApiError.badRequest('Aid reminder is missing recurrence data', 'VALIDATION_ERROR');
    }

    if (!isSameUtcDay(dueDate, today)) {
      throw ApiError.badRequest('This aid reminder can only be approved on its due date', 'VALIDATION_ERROR');
    }

    if (!getAidOccurrenceFrequency(normalizedOccurrence)) {
      throw ApiError.badRequest('Only recurring aid reminders can be approved', 'VALIDATION_ERROR');
    }

    const alreadyRecorded = await Aid.exists({ reminderNotificationId: notification._id });
    if (alreadyRecorded) {
      throw ApiError.conflict('This aid reminder was already approved', 'DUPLICATE_VALUE');
    }

    let houseNames = Array.isArray(reminderData.houseNames)
      ? reminderData.houseNames.map((houseName) => String(houseName || '').trim()).filter(Boolean)
      : [];

    if (houseNames.length === 0) {
      houseNames = await Aid.find({
        date: originalDate,
        category: reminderData.category,
        occurrence: normalizedOccurrence,
        description: reminderData.description,
      }).distinct('houseName');
    }

    if (houseNames.length === 0) {
      throw ApiError.badRequest('No households were found for this recurring aid', 'VALIDATION_ERROR');
    }

    const payloads = houseNames.map((houseName) => ({
      houseName,
      category: reminderData.category,
      occurrence: normalizedOccurrence,
      description: reminderData.description,
      notes: reminderData.notes || null,
      date: dueDate,
      recordedBy,
      isRecurringSource: false,
      recurrenceAnchorDate: originalDate,
      reminderNotificationId: notification._id,
    }));

    const created = await Aid.insertMany(payloads);

    notification.isActive = false;
    notification.updatedBy = recordedBy;
    notification.sourceData = {
      ...reminderData,
      approvedAt: new Date().toISOString(),
      approvedDate: dueDate.toISOString().slice(0, 10),
      approvedBeneficiariesCount: created.length,
    };
    await notification.save();

    return {
      count: created.length,
      group: {
        date: dueDate.toISOString(),
        category: reminderData.category,
        occurrence: normalizedOccurrence,
        description: reminderData.description,
      },
    };
  }
}

module.exports = new AidService();
