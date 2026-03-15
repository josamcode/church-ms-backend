const mongoose = require('mongoose');
const ApiError = require('../../utils/ApiError');
const redisClient = require('../../config/redis');
const { CACHE_KEYS } = require('../../constants/cacheKeys');
const { PERMISSIONS } = require('../../constants/permissions');
const User = require('../users/user.model');
const ChurchPriest = require('./churchPriest.model');
const DivineLiturgyAttendance = require('./divineLiturgyAttendance.model');
const DivineLiturgyRecurring = require('./divineLiturgyRecurring.model');
const DivineLiturgyException = require('./divineLiturgyException.model');
const {
  DIVINE_LITURGY_ATTENDANCE_ENTRY_TYPES,
} = require('./divineLiturgyAttendance.model');
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

  _buildLocalDateKey(date = new Date()) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  _normalizeAttendanceDate(rawDate) {
    const normalized = this._normalizeText(rawDate);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
      throw ApiError.badRequest('Attendance date is invalid', 'VALIDATION_ERROR');
    }

    const [year, month, day] = normalized.split('-').map((value) => parseInt(value, 10));
    const date = new Date(year, month - 1, day);
    if (
      Number.isNaN(date.getTime()) ||
      date.getFullYear() !== year ||
      date.getMonth() !== month - 1 ||
      date.getDate() !== day
    ) {
      throw ApiError.badRequest('Attendance date is invalid', 'VALIDATION_ERROR');
    }

    return {
      dateKey: normalized,
      dayOfWeek: date.getDay(),
    };
  }

  _getWeekdayIndex(day) {
    return DAY_ORDER[this._normalizeText(day)] ?? null;
  }

  _assertPastRecurringAttendanceDateAllowed(dayOfWeek, rawDate, label = 'Attendance date') {
    const { dateKey, dayOfWeek: selectedDayOfWeek } = this._normalizeAttendanceDate(rawDate);
    const expectedDayOfWeek = this._getWeekdayIndex(dayOfWeek);

    if (expectedDayOfWeek == null || expectedDayOfWeek !== selectedDayOfWeek) {
      throw ApiError.badRequest(`${label} must match the service day`, 'VALIDATION_ERROR');
    }

    if (dateKey >= this._buildLocalDateKey()) {
      throw ApiError.badRequest(`${label} must be a past service date`, 'VALIDATION_ERROR');
    }

    return dateKey;
  }

  _assertPastExceptionAttendanceDateAllowed(exceptionDate, rawDate, label = 'Attendance date') {
    const { dateKey } = this._normalizeAttendanceDate(rawDate);
    const expectedDate = this._normalizeText(exceptionDate);

    if (!expectedDate || dateKey !== expectedDate) {
      throw ApiError.badRequest(`${label} must match the exceptional service date`, 'VALIDATION_ERROR');
    }

    if (dateKey >= this._buildLocalDateKey()) {
      throw ApiError.badRequest(`${label} must be a past service date`, 'VALIDATION_ERROR');
    }

    return dateKey;
  }

  _normalizeAttendanceEntryType(entryType) {
    const normalizedEntryType = this._normalizeText(entryType).toLowerCase();
    if (!DIVINE_LITURGY_ATTENDANCE_ENTRY_TYPES.includes(normalizedEntryType)) {
      throw ApiError.badRequest('Attendance entry type is invalid', 'VALIDATION_ERROR');
    }
    return normalizedEntryType;
  }

  _hasPermission(permissions = [], permission) {
    return Array.isArray(permissions) && permissions.includes(permission);
  }

  _canManageAttendance(userPermissions = []) {
    return (
      this._hasPermission(userPermissions, PERMISSIONS.DIVINE_LITURGIES_ATTENDANCE_MANAGE) ||
      this._hasPermission(userPermissions, PERMISSIONS.DIVINE_LITURGIES_MANAGE)
    );
  }

  async _clearUserCaches(userIds = []) {
    const uniqueUserIds = [...new Set((userIds || []).map((value) => this._toId(value)).filter(Boolean))];
    if (uniqueUserIds.length === 0) return;

    await Promise.all(
      uniqueUserIds.map(async (userId) => {
        try {
          await redisClient.del(CACHE_KEYS.USER_PROFILE(userId));
          await redisClient.del(CACHE_KEYS.USER_PERMISSIONS(userId));
        } catch (_error) {
          // Cache misses should not block attendance updates.
        }
      })
    );
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

  _mapAttendanceService(entryType, entry) {
    if (entryType === 'recurring') {
      const mapped = this._mapRecurring(entry);
      return {
        id: mapped.id,
        entryType,
        serviceType: mapped.serviceType,
        dayOfWeek: mapped.dayOfWeek,
        date: null,
        startTime: mapped.startTime,
        endTime: mapped.endTime,
        name: mapped.name,
        displayName: mapped.displayName,
        createdAt: mapped.createdAt || null,
        updatedAt: mapped.updatedAt || null,
      };
    }

    const mapped = this._mapException(entry);
    return {
      id: mapped.id,
      entryType,
      serviceType: SERVICE_TYPES.DIVINE_LITURGY,
      dayOfWeek: DAYS_OF_WEEK[new Date(`${mapped.date}T00:00:00`).getDay()] || null,
      date: mapped.date,
      startTime: mapped.startTime,
      endTime: mapped.endTime,
      name: mapped.name,
      displayName: mapped.displayName,
      createdAt: mapped.createdAt || null,
      updatedAt: mapped.updatedAt || null,
    };
  }

  async _loadAttendanceService(entryType, id) {
    const normalizedEntryType = this._normalizeAttendanceEntryType(entryType);
    const serviceId = this._toObjectId(id, 'id');

    if (normalizedEntryType === 'recurring') {
      const recurring = await this._loadRecurringById(serviceId);
      if (!recurring) {
        throw ApiError.notFound('Recurring service was not found', 'RESOURCE_NOT_FOUND');
      }

      return {
        entryType: normalizedEntryType,
        serviceId,
        service: this._mapAttendanceService(normalizedEntryType, recurring),
      };
    }

    const exception = await this._loadExceptionById(serviceId);
    if (!exception) {
      throw ApiError.notFound('Exceptional service was not found', 'RESOURCE_NOT_FOUND');
    }

    return {
      entryType: normalizedEntryType,
      serviceId,
      service: this._mapAttendanceService(normalizedEntryType, exception),
    };
  }

  _extractAttendanceViewerAuditEntry(record, actorUserId) {
    const normalizedActorId = this._toId(actorUserId);
    if (!normalizedActorId) return null;

    return (
      [...(record?.auditLog || [])]
        .sort((a, b) => new Date(b?.createdAt || 0).getTime() - new Date(a?.createdAt || 0).getTime())
        .find((entry) => this._toId(entry?.actorUserId) === normalizedActorId) || null
    );
  }

  async _mapAttendanceRecord(record, attendanceDate, actorUserId) {
    const viewerAuditEntry = this._extractAttendanceViewerAuditEntry(record, actorUserId);
    const updatedById = this._toId(record?.updatedBy || record?.recordedBy);
    const viewerUpdatedById = this._toId(viewerAuditEntry?.actorUserId);
    const userIdsToLoad = [...new Set([updatedById, viewerUpdatedById].filter(Boolean))];
    const usersMap = userIdsToLoad.length > 0
      ? new Map(
        (await User.find({ _id: { $in: userIdsToLoad.map((id) => this._toObjectId(id)) } })
          .select('fullName')
          .lean())
          .map((user) => [this._toId(user._id), user])
      )
      : new Map();

    const updatedByUser = updatedById ? usersMap.get(updatedById) : null;
    const viewerUpdatedByUser = viewerUpdatedById ? usersMap.get(viewerUpdatedById) : null;

    return {
      attendanceDate,
      attendedUserIds: [...new Set((record?.attendedUserIds || []).map((value) => this._toId(value)).filter(Boolean))],
      updatedAt: record?.updatedAt || null,
      updatedBy: updatedById
        ? {
            id: updatedById,
            fullName: updatedByUser?.fullName || '',
          }
        : null,
      viewerUpdatedAt: viewerAuditEntry?.createdAt || null,
      viewerUpdatedBy: viewerUpdatedById
        ? {
            id: viewerUpdatedById,
            fullName: viewerUpdatedByUser?.fullName || '',
          }
        : null,
      canManageAttendance: true,
    };
  }

  async _assertAttendanceUsersExist(userIds = []) {
    if (!userIds.length) return;

    const users = await User.find({
      _id: { $in: userIds.map((id) => this._toObjectId(id, 'attendedUserIds')) },
      isDeleted: { $ne: true },
    })
      .select('_id')
      .lean();

    if (users.length !== userIds.length) {
      throw ApiError.badRequest('Some selected users were not found', 'VALIDATION_ERROR');
    }
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

  async getAttendanceContext(entryType, id, { userPermissions = [] } = {}) {
    if (!this._canManageAttendance(userPermissions)) {
      throw ApiError.forbidden('Missing permission for this process', 'PERMISSION_DENIED');
    }

    const attendanceService = await this._loadAttendanceService(entryType, id);
    const users = await User.find({ isDeleted: { $ne: true } })
      .select('fullName')
      .sort({ fullName: 1, _id: 1 })
      .lean();

    return {
      service: attendanceService.service,
      users: users.map((user) => ({
        id: this._toId(user._id),
        fullName: user.fullName || '',
      })),
      canManageAttendance: true,
    };
  }

  async getAttendance(
    entryType,
    id,
    attendanceDate,
    { actorUserId, userPermissions = [] } = {}
  ) {
    if (!this._canManageAttendance(userPermissions)) {
      throw ApiError.forbidden('Missing permission for this process', 'PERMISSION_DENIED');
    }

    const attendanceService = await this._loadAttendanceService(entryType, id);
    const normalizedAttendanceDate =
      attendanceService.entryType === 'recurring'
        ? this._assertPastRecurringAttendanceDateAllowed(
          attendanceService.service.dayOfWeek,
          attendanceDate
        )
        : this._assertPastExceptionAttendanceDateAllowed(
          attendanceService.service.date,
          attendanceDate
        );

    const record = await DivineLiturgyAttendance.findOne({
      entryType: attendanceService.entryType,
      serviceId: attendanceService.serviceId,
      attendanceDate: normalizedAttendanceDate,
    }).lean();

    if (!record) {
      return {
        attendanceDate: normalizedAttendanceDate,
        attendedUserIds: [],
        updatedAt: null,
        updatedBy: null,
        viewerUpdatedAt: null,
        viewerUpdatedBy: null,
        canManageAttendance: true,
      };
    }

    return this._mapAttendanceRecord(record, normalizedAttendanceDate, actorUserId);
  }

  async updateAttendance(
    entryType,
    id,
    attendanceDate,
    attendedUserIds = [],
    { actorUserId, userPermissions = [] } = {}
  ) {
    if (!this._canManageAttendance(userPermissions)) {
      throw ApiError.forbidden('Missing permission for this process', 'PERMISSION_DENIED');
    }

    const attendanceService = await this._loadAttendanceService(entryType, id);
    const normalizedAttendanceDate =
      attendanceService.entryType === 'recurring'
        ? this._assertPastRecurringAttendanceDateAllowed(
          attendanceService.service.dayOfWeek,
          attendanceDate
        )
        : this._assertPastExceptionAttendanceDateAllowed(
          attendanceService.service.date,
          attendanceDate
        );

    const normalizedAttendedUserIds = [...new Set(
      (attendedUserIds || [])
        .map((value) => this._toId(value))
        .filter(Boolean)
    )];

    await this._assertAttendanceUsersExist(normalizedAttendedUserIds);

    const actorObjectId = this._toObjectId(actorUserId, 'actorUserId');
    const now = new Date();
    let record = await DivineLiturgyAttendance.findOne({
      entryType: attendanceService.entryType,
      serviceId: attendanceService.serviceId,
      attendanceDate: normalizedAttendanceDate,
    });

    const previousAttendedUserIds = [...new Set(
      (record?.attendedUserIds || []).map((value) => this._toId(value)).filter(Boolean)
    )];

    if (!record) {
      record = new DivineLiturgyAttendance({
        entryType: attendanceService.entryType,
        serviceId: attendanceService.serviceId,
        serviceType: attendanceService.service.serviceType,
        attendanceDate: normalizedAttendanceDate,
        recordedBy: actorObjectId,
      });
    }

    record.serviceType = attendanceService.service.serviceType;
    record.attendedUserIds = normalizedAttendedUserIds.map((userId) =>
      this._toObjectId(userId, 'attendedUserIds')
    );
    record.updatedBy = actorObjectId;
    record.updatedAt = now;
    record.auditLog = record.auditLog || [];
    record.auditLog.push({
      actorUserId: actorObjectId,
      previousAttendedUserIds: previousAttendedUserIds.map((userId) =>
        this._toObjectId(userId, 'userId')
      ),
      attendedUserIds: normalizedAttendedUserIds.map((userId) =>
        this._toObjectId(userId, 'userId')
      ),
      action: 'attendance_check_in_saved',
      createdAt: now,
    });
    await record.save();

    const affectedUserIds = [...new Set([...previousAttendedUserIds, ...normalizedAttendedUserIds])];
    if (affectedUserIds.length > 0) {
      await User.updateMany(
        {
          _id: { $in: affectedUserIds.map((userId) => this._toObjectId(userId, 'userId')) },
          isDeleted: { $ne: true },
        },
        {
          $pull: {
            divineLiturgyAttendance: {
              entryType: attendanceService.entryType,
              serviceId: attendanceService.serviceId,
              attendanceDate: normalizedAttendanceDate,
            },
          },
          $set: {
            updatedBy: actorObjectId,
          },
        }
      );

      if (normalizedAttendedUserIds.length > 0) {
        await User.updateMany(
          {
            _id: { $in: normalizedAttendedUserIds.map((userId) => this._toObjectId(userId, 'userId')) },
            isDeleted: { $ne: true },
          },
          {
            $push: {
              divineLiturgyAttendance: {
                entryType: attendanceService.entryType,
                serviceId: attendanceService.serviceId,
                serviceType: attendanceService.service.serviceType,
                attendanceDate: normalizedAttendanceDate,
                recordedBy: actorObjectId,
                updatedBy: actorObjectId,
                updatedAt: now,
              },
            },
            $set: {
              updatedBy: actorObjectId,
            },
          }
        );
      }

      await this._clearUserCaches(affectedUserIds);
    }

    return this._mapAttendanceRecord(record.toObject(), normalizedAttendanceDate, actorUserId);
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
