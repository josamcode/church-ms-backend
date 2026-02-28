const mongoose = require('mongoose');
const ApiError = require('../../utils/ApiError');
const User = require('../users/user.model');
const ChurchPriest = require('./churchPriest.model');
const DivineLiturgyRecurring = require('./divineLiturgyRecurring.model');
const DivineLiturgyException = require('./divineLiturgyException.model');
const { SERVICE_TYPES, DAYS_OF_WEEK } = require('./divineLiturgyRecurring.model');

const DAY_ORDER = DAYS_OF_WEEK.reduce((acc, day, index) => {
  acc[day] = index;
  return acc;
}, {});

class DivineLiturgiesService {
  _toObjectId(id, fieldName = 'id') {
    if (!mongoose.Types.ObjectId.isValid(id)) {
      throw ApiError.badRequest(`Invalid ${fieldName}`, 'VALIDATION_ERROR');
    }
    return new mongoose.Types.ObjectId(id);
  }

  _toId(value) {
    if (!value) return null;
    if (typeof value === 'string') return value;
    if (value._id) return String(value._id);
    return String(value);
  }

  _normalizeText(value) {
    return String(value || '').trim();
  }

  _normalizeObjectIdStrings(values = [], fieldName = 'id') {
    const ids = [...new Set((values || []).map((value) => this._toId(value)).filter(Boolean))];
    ids.forEach((id) => {
      if (!mongoose.Types.ObjectId.isValid(id)) {
        throw ApiError.badRequest(`Invalid ${fieldName}`, 'VALIDATION_ERROR');
      }
    });
    return ids;
  }

  _parseTimeToMinutes(value, fieldName = 'time') {
    const normalized = this._normalizeText(value);
    const match = normalized.match(/^([01]\d|2[0-3]):([0-5]\d)$/);
    if (!match) {
      throw ApiError.badRequest(`Invalid ${fieldName}`, 'VALIDATION_ERROR');
    }
    const hours = parseInt(match[1], 10);
    const minutes = parseInt(match[2], 10);
    return hours * 60 + minutes;
  }

  _ensureValidTimeRange(startTime, endTime) {
    const startMinutes = this._parseTimeToMinutes(startTime, 'startTime');
    if (!endTime) return;
    const endMinutes = this._parseTimeToMinutes(endTime, 'endTime');
    if (endMinutes <= startMinutes) {
      throw ApiError.badRequest('End time must be later than start time', 'VALIDATION_ERROR');
    }
  }

  _toDateOnly(value, fieldName = 'date') {
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      throw ApiError.badRequest(`Invalid ${fieldName}`, 'VALIDATION_ERROR');
    }
    parsed.setUTCHours(0, 0, 0, 0);
    return parsed;
  }

  _mapUser(userLike) {
    const id = this._toId(userLike);
    if (!id) return null;

    const avatar =
      userLike?.avatar && typeof userLike.avatar === 'object' && userLike.avatar.url
        ? {
            url: userLike.avatar.url,
            publicId: userLike.avatar.publicId || null,
          }
        : null;

    return {
      id,
      fullName: userLike?.fullName || null,
      phonePrimary: userLike?.phonePrimary || null,
      avatar,
    };
  }

  _mapChurchPriest(priest) {
    const user = priest?.userId && typeof priest.userId === 'object'
      ? this._mapUser(priest.userId)
      : priest?.userId
        ? { id: this._toId(priest.userId), fullName: null, phonePrimary: null, avatar: null }
        : null;

    return {
      id: this._toId(priest?._id),
      user,
      createdAt: priest?.createdAt || null,
      updatedAt: priest?.updatedAt || null,
    };
  }

  _getRecurringDefaultName(entry) {
    const serviceLabel =
      entry.serviceType === SERVICE_TYPES.DIVINE_LITURGY
        ? 'Divine Liturgy'
        : 'Vespers of the Divine Liturgy';
    return `${entry.dayOfWeek} ${serviceLabel}`;
  }

  _mapRecurring(entry) {
    const priests = (entry.priestUserIds || []).map((userLike) => this._mapUser(userLike)).filter(Boolean);
    const normalizedName = this._normalizeText(entry.name);
    return {
      id: this._toId(entry._id),
      serviceType: entry.serviceType,
      dayOfWeek: entry.dayOfWeek,
      startTime: entry.startTime,
      endTime: entry.endTime || null,
      name: normalizedName || null,
      displayName: normalizedName || this._getRecurringDefaultName(entry),
      priests,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
    };
  }

  _mapException(entry) {
    const priests = (entry.priestUserIds || []).map((userLike) => this._mapUser(userLike)).filter(Boolean);
    const dateIso = entry.date instanceof Date
      ? entry.date.toISOString().slice(0, 10)
      : new Date(entry.date).toISOString().slice(0, 10);
    const normalizedName = this._normalizeText(entry.name);

    return {
      id: this._toId(entry._id),
      date: dateIso,
      startTime: entry.startTime,
      endTime: entry.endTime || null,
      name: normalizedName || null,
      displayName: normalizedName || `Exceptional Divine Liturgy (${dateIso})`,
      priests,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
    };
  }

  _sortRecurring(entries = []) {
    return [...entries].sort((a, b) => {
      const dayDiff = (DAY_ORDER[a.dayOfWeek] ?? 99) - (DAY_ORDER[b.dayOfWeek] ?? 99);
      if (dayDiff !== 0) return dayDiff;
      const startDiff = String(a.startTime || '').localeCompare(String(b.startTime || ''));
      if (startDiff !== 0) return startDiff;
      return String(a._id).localeCompare(String(b._id));
    });
  }

  _sortExceptions(entries = []) {
    return [...entries].sort((a, b) => {
      const aDate = new Date(a.date).getTime();
      const bDate = new Date(b.date).getTime();
      if (aDate !== bDate) return aDate - bDate;
      const startDiff = String(a.startTime || '').localeCompare(String(b.startTime || ''));
      if (startDiff !== 0) return startDiff;
      return String(a._id).localeCompare(String(b._id));
    });
  }

  async _validatePriestAssignments(priestUserIds = []) {
    const normalizedIds = this._normalizeObjectIdStrings(priestUserIds, 'priestUserIds');
    if (!normalizedIds.length) return [];

    const allowedDocs = await ChurchPriest.find({})
      .select('userId')
      .lean();
    const allowedSet = new Set(allowedDocs.map((entry) => this._toId(entry.userId)).filter(Boolean));

    const invalidIds = normalizedIds.filter((id) => !allowedSet.has(id));
    if (invalidIds.length > 0) {
      throw ApiError.badRequest(
        'All assigned priests must exist in church priests list',
        'VALIDATION_ERROR'
      );
    }

    return normalizedIds;
  }

  async _assertUsersExist(userIds = []) {
    if (!userIds.length) return;
    const users = await User.find({
      _id: { $in: userIds.map((id) => this._toObjectId(id, 'priestUserIds')) },
      isDeleted: { $ne: true },
    })
      .select('_id')
      .lean();

    if (users.length !== userIds.length) {
      throw ApiError.badRequest('Some priest users were not found', 'VALIDATION_ERROR');
    }
  }

  async _loadRecurringById(id) {
    return DivineLiturgyRecurring.findById(id)
      .populate('priestUserIds', 'fullName phonePrimary avatar')
      .lean();
  }

  async _loadExceptionById(id) {
    return DivineLiturgyException.findById(id)
      .populate('priestUserIds', 'fullName phonePrimary avatar')
      .lean();
  }

  async getOverview() {
    const [priests, recurring, exceptions] = await Promise.all([
      ChurchPriest.find({})
        .sort({ createdAt: 1, _id: 1 })
        .populate('userId', 'fullName phonePrimary avatar')
        .lean(),
      DivineLiturgyRecurring.find({})
        .populate('priestUserIds', 'fullName phonePrimary avatar')
        .lean(),
      DivineLiturgyException.find({})
        .populate('priestUserIds', 'fullName phonePrimary avatar')
        .lean(),
    ]);

    const mappedPriests = priests
      .map((entry) => this._mapChurchPriest(entry))
      .filter((entry) => entry.user?.id);

    const recurringDivineLiturgies = this._sortRecurring(
      recurring.filter((entry) => entry.serviceType === SERVICE_TYPES.DIVINE_LITURGY)
    ).map((entry) => this._mapRecurring(entry));

    const recurringVespers = this._sortRecurring(
      recurring.filter((entry) => entry.serviceType === SERVICE_TYPES.VESPERS)
    ).map((entry) => this._mapRecurring(entry));

    const exceptionalDivineLiturgies = this._sortExceptions(exceptions).map((entry) =>
      this._mapException(entry)
    );

    return {
      churchPriests: mappedPriests,
      recurringDivineLiturgies,
      recurringVespers,
      exceptionalDivineLiturgies,
    };
  }

  async createRecurring(payload, actorUserId) {
    const normalizedEndTime = this._normalizeText(payload.endTime) || undefined;
    this._ensureValidTimeRange(payload.startTime, normalizedEndTime);

    const priestUserIds =
      payload.serviceType === SERVICE_TYPES.DIVINE_LITURGY
        ? await this._validatePriestAssignments(payload.priestUserIds || [])
        : [];

    const recurring = await DivineLiturgyRecurring.create({
      serviceType: payload.serviceType,
      dayOfWeek: payload.dayOfWeek,
      startTime: payload.startTime,
      endTime: normalizedEndTime,
      name: this._normalizeText(payload.name) || undefined,
      priestUserIds,
      createdBy: actorUserId,
      updatedBy: actorUserId,
    });

    const loaded = await this._loadRecurringById(recurring._id);
    return this._mapRecurring(loaded);
  }

  async updateRecurring(id, payload, actorUserId) {
    const recurring = await DivineLiturgyRecurring.findById(this._toObjectId(id));
    if (!recurring) {
      throw ApiError.notFound('Recurring record was not found', 'RESOURCE_NOT_FOUND');
    }

    const nextServiceType = payload.serviceType || recurring.serviceType;
    const nextStartTime = payload.startTime || recurring.startTime;
    const nextEndTime =
      payload.endTime !== undefined
        ? this._normalizeText(payload.endTime) || undefined
        : recurring.endTime || undefined;

    this._ensureValidTimeRange(nextStartTime, nextEndTime);

    if (payload.serviceType !== undefined) recurring.serviceType = payload.serviceType;
    if (payload.dayOfWeek !== undefined) recurring.dayOfWeek = payload.dayOfWeek;
    if (payload.startTime !== undefined) recurring.startTime = payload.startTime;
    if (payload.endTime !== undefined) recurring.endTime = nextEndTime;
    if (payload.name !== undefined) recurring.name = this._normalizeText(payload.name) || undefined;

    if (nextServiceType === SERVICE_TYPES.VESPERS) {
      recurring.priestUserIds = [];
    } else if (payload.priestUserIds !== undefined) {
      recurring.priestUserIds = await this._validatePriestAssignments(payload.priestUserIds);
    }

    recurring.updatedBy = actorUserId;
    await recurring.save();

    const loaded = await this._loadRecurringById(recurring._id);
    return this._mapRecurring(loaded);
  }

  async deleteRecurring(id) {
    const deleted = await DivineLiturgyRecurring.findByIdAndDelete(this._toObjectId(id));
    if (!deleted) {
      throw ApiError.notFound('Recurring record was not found', 'RESOURCE_NOT_FOUND');
    }
  }

  async createException(payload, actorUserId) {
    const normalizedEndTime = this._normalizeText(payload.endTime) || undefined;
    this._ensureValidTimeRange(payload.startTime, normalizedEndTime);

    const priestUserIds = await this._validatePriestAssignments(payload.priestUserIds || []);

    const exception = await DivineLiturgyException.create({
      date: this._toDateOnly(payload.date),
      startTime: payload.startTime,
      endTime: normalizedEndTime,
      name: this._normalizeText(payload.name) || undefined,
      priestUserIds,
      createdBy: actorUserId,
      updatedBy: actorUserId,
    });

    const loaded = await this._loadExceptionById(exception._id);
    return this._mapException(loaded);
  }

  async updateException(id, payload, actorUserId) {
    const exception = await DivineLiturgyException.findById(this._toObjectId(id));
    if (!exception) {
      throw ApiError.notFound('Exception record was not found', 'RESOURCE_NOT_FOUND');
    }

    const nextStartTime = payload.startTime || exception.startTime;
    const nextEndTime =
      payload.endTime !== undefined
        ? this._normalizeText(payload.endTime) || undefined
        : exception.endTime || undefined;
    this._ensureValidTimeRange(nextStartTime, nextEndTime);

    if (payload.date !== undefined) exception.date = this._toDateOnly(payload.date);
    if (payload.startTime !== undefined) exception.startTime = payload.startTime;
    if (payload.endTime !== undefined) exception.endTime = nextEndTime;
    if (payload.name !== undefined) exception.name = this._normalizeText(payload.name) || undefined;
    if (payload.priestUserIds !== undefined) {
      exception.priestUserIds = await this._validatePriestAssignments(payload.priestUserIds);
    }

    exception.updatedBy = actorUserId;
    await exception.save();

    const loaded = await this._loadExceptionById(exception._id);
    return this._mapException(loaded);
  }

  async deleteException(id) {
    const deleted = await DivineLiturgyException.findByIdAndDelete(this._toObjectId(id));
    if (!deleted) {
      throw ApiError.notFound('Exception record was not found', 'RESOURCE_NOT_FOUND');
    }
  }

  async setChurchPriests(priestUserIds, actorUserId) {
    const nextIds = this._normalizeObjectIdStrings(priestUserIds, 'priestUserIds');
    await this._assertUsersExist(nextIds);

    const existingPriests = await ChurchPriest.find({})
      .select('userId')
      .lean();

    const existingSet = new Set(existingPriests.map((entry) => this._toId(entry.userId)).filter(Boolean));
    const nextSet = new Set(nextIds);
    const removedIds = [...existingSet].filter((id) => !nextSet.has(id));

    if (nextIds.length === 0) {
      await ChurchPriest.deleteMany({});
    } else {
      await ChurchPriest.deleteMany({ userId: { $nin: nextIds.map((id) => this._toObjectId(id)) } });
      await Promise.all(
        nextIds.map((userId) =>
          ChurchPriest.findOneAndUpdate(
            { userId: this._toObjectId(userId) },
            {
              $set: { updatedBy: this._toObjectId(actorUserId, 'actorUserId') },
              $setOnInsert: {
                userId: this._toObjectId(userId),
                createdBy: this._toObjectId(actorUserId, 'actorUserId'),
              },
            },
            { upsert: true, new: true, setDefaultsOnInsert: true }
          )
        )
      );
    }

    if (removedIds.length > 0) {
      await Promise.all([
        DivineLiturgyRecurring.updateMany(
          {},
          { $pull: { priestUserIds: { $in: removedIds.map((id) => this._toObjectId(id)) } } }
        ),
        DivineLiturgyException.updateMany(
          {},
          { $pull: { priestUserIds: { $in: removedIds.map((id) => this._toObjectId(id)) } } }
        ),
      ]);
    }

    return this.getOverview();
  }
}

module.exports = new DivineLiturgiesService();
