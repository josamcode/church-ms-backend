const mongoose = require('mongoose');
const User = require('./user.model');
const Meeting = require('../meetings/meeting.model');
const DivineLiturgyRecurring = require('../divineLiturgies/divineLiturgyRecurring.model');
const DivineLiturgyException = require('../divineLiturgies/divineLiturgyException.model');
const RelationRole = require('./relationRole.model');
const ApiError = require('../../utils/ApiError');
const redisClient = require('../../config/redis');
const { CACHE_KEYS, CACHE_TTL } = require('../../constants/cacheKeys');
const { filterAssignablePermissions } = require('../../constants/permissions');
const { buildPaginationMeta } = require('../../utils/pagination');
const { ROLES } = require('../../constants/roles');
const { SERVICE_TYPES } = require('../divineLiturgies/divineLiturgyRecurring.model');
const logger = require('../../utils/logger');
const cloudinary = require('../../config/cloudinary');
const {
  uploadBufferToCloudinary,
  validateImageUpload,
} = require('../../utils/fileUploads');

class UserService {
  _toComparableId(value) {
    if (!value) return null;
    if (typeof value === 'string' || typeof value === 'number') return String(value);
    if (typeof value === 'object') {
      if (value._id != null) return String(value._id);
      if (value.id != null) return String(value.id);
    }
    return String(value);
  }

  _normalizeDistinctStringValues(values = []) {
    return [...new Set((Array.isArray(values) ? values : [])
      .map((value) => (typeof value === 'string' ? value.trim() : ''))
      .filter(Boolean))]
      .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  }

  async _normalizeConfessionFatherFields(data = {}) {
    if (data.confessionFatherUserId === undefined && data.confessionFatherName === undefined) {
      return data;
    }

    const normalized = { ...data };
    const rawUserId = data.confessionFatherUserId;

    if (rawUserId !== undefined) {
      if (rawUserId === null || rawUserId === '') {
        normalized.confessionFatherUserId = null;
        normalized.confessionFatherName = null;
        return normalized;
      }

      if (!mongoose.Types.ObjectId.isValid(rawUserId)) {
        throw ApiError.badRequest('Invalid spiritual father user id', 'VALIDATION_ERROR');
      }

      const confessionFather = await User.findById(rawUserId).select('fullName').lean();
      if (!confessionFather) {
        throw ApiError.notFound('Spiritual father user not found', 'USER_NOT_FOUND');
      }

      normalized.confessionFatherUserId = confessionFather._id;
      normalized.confessionFatherName = confessionFather.fullName;
      return normalized;
    }

    const trimmedName =
      typeof data.confessionFatherName === 'string' ? data.confessionFatherName.trim() : '';

    normalized.confessionFatherName = trimmedName || null;
    normalized.confessionFatherUserId = null;
    return normalized;
  }

  _sanitizePermissionOverridesForRole(data = {}, role = ROLES.USER) {
    if (!data || typeof data !== 'object') {
      return data;
    }

    const normalized = { ...data };

    if (normalized.extraPermissions !== undefined) {
      normalized.extraPermissions = filterAssignablePermissions(role, normalized.extraPermissions);
    }

    if (normalized.deniedPermissions !== undefined) {
      normalized.deniedPermissions = filterAssignablePermissions(role, normalized.deniedPermissions);
    }

    return normalized;
  }

  _getRecurringDivineLiturgyDisplayName(service) {
    const serviceLabel =
      service?.serviceType === SERVICE_TYPES.DIVINE_LITURGY
        ? 'Divine Liturgy'
        : 'Vespers of the Divine Liturgy';
    return `${service?.dayOfWeek || ''} ${serviceLabel}`.trim() || serviceLabel;
  }

  _getExceptionDivineLiturgyDisplayName(service, dateIso) {
    return String(service?.name || '').trim() || `Exceptional Divine Liturgy (${dateIso || 'unknown date'})`;
  }

  _mapHydratedDivineLiturgyService(entryType, service) {
    if (!service) return null;

    if (entryType === 'recurring') {
      const displayName =
        String(service?.name || '').trim() || this._getRecurringDivineLiturgyDisplayName(service);
      return {
        id: this._toComparableId(service._id),
        entryType,
        serviceType: service?.serviceType || SERVICE_TYPES.DIVINE_LITURGY,
        name: String(service?.name || '').trim() || null,
        displayName,
        dayOfWeek: service?.dayOfWeek || null,
        date: null,
        startTime: service?.startTime || null,
        endTime: service?.endTime || null,
      };
    }

    const dateValue = service?.date instanceof Date ? service.date : new Date(service?.date);
    const dateIso =
      dateValue instanceof Date && !Number.isNaN(dateValue.getTime())
        ? dateValue.toISOString().slice(0, 10)
        : null;
    return {
      id: this._toComparableId(service._id),
      entryType,
      serviceType: SERVICE_TYPES.DIVINE_LITURGY,
      name: String(service?.name || '').trim() || null,
      displayName: this._getExceptionDivineLiturgyDisplayName(service, dateIso),
      dayOfWeek: null,
      date: dateIso,
      startTime: service?.startTime || null,
      endTime: service?.endTime || null,
    };
  }

  /**
   * إنشاء مستخدم جديد (مع أو بدون تسجيل دخول)
   */
  async createUser(data, createdByUserId) {
    const normalizedData = await this._normalizeConfessionFatherFields(data);

    await this._assertRoleAndPermissionManagementAllowed({
      actorUserId: createdByUserId,
      targetUser: null,
      updateData: normalizedData,
    });

    const preparedData = this._sanitizePermissionOverridesForRole(
      normalizedData,
      normalizedData.role || ROLES.USER
    );

    const orConditions = [];
    if (preparedData.phonePrimary) orConditions.push({ phonePrimary: preparedData.phonePrimary });
    if (preparedData.email) orConditions.push({ email: preparedData.email });
    if (preparedData.nationalId) orConditions.push({ nationalId: preparedData.nationalId });

    const existing = orConditions.length > 0 ? await User.findOne({ $or: orConditions }).lean() : null;

    if (existing) {
      if (existing.phonePrimary === preparedData.phonePrimary) {
        throw ApiError.conflict('رقم الهاتف مسجل مسبقاً', 'DUPLICATE_PHONE');
      }
      if (preparedData.email && existing.email === preparedData.email) {
        throw ApiError.conflict('البريد الإلكتروني مسجل مسبقاً', 'DUPLICATE_EMAIL');
      }
      if (preparedData.nationalId && existing.nationalId === preparedData.nationalId) {
        throw ApiError.conflict('الرقم القومي مسجل مسبقاً', 'DUPLICATE_NATIONAL_ID');
      }
    }

    const userData = { ...preparedData, createdBy: createdByUserId };
    if (
      preparedData.avatar &&
      typeof preparedData.avatar === 'object' &&
      preparedData.avatar.url &&
      preparedData.avatar.publicId
    ) {
      userData.avatar = { url: preparedData.avatar.url, publicId: preparedData.avatar.publicId };
    }

    if (preparedData.password) {
      userData.hasLogin = true;
      userData.passwordHash = preparedData.password;
      userData.loginIdentifierType = preparedData.email ? 'email' : 'phone';
      delete userData.password;
    }

    const user = new User(userData);
    await user.save();

    return user.toSafeObject();
  }

  /**
   * جلب قائمة المستخدمين مع ترقيم المؤشر (Cursor Pagination)
   */
  async listUsers({ cursor, limit = 20, sort = 'createdAt', order = 'desc', filters = {} }) {
    const query = {};

    // Filters
    const namePhoneOrConditions = [];
    if (filters.fullName) {
      namePhoneOrConditions.push({ fullName: { $regex: filters.fullName, $options: 'i' } });
    }
    if (filters.phonePrimary) {
      namePhoneOrConditions.push({
        phonePrimary: { $regex: filters.phonePrimary, $options: 'i' },
      });
    }
    if (namePhoneOrConditions.length === 1) {
      Object.assign(query, namePhoneOrConditions[0]);
    } else if (namePhoneOrConditions.length > 1) {
      query.$or = namePhoneOrConditions;
    }
    if (filters.ageGroup) {
      query.ageGroup = filters.ageGroup;
    }
    if (filters.tags) {
      const tagsArray = Array.isArray(filters.tags) ? filters.tags : [filters.tags];
      if (tagsArray.length > 0) {
        query.tags = { $in: tagsArray };
      }
    }
    if (filters.role) {
      query.role = filters.role;
    }
    if (filters.familyName) {
      query.familyName = { $regex: filters.familyName, $options: 'i' };
    }
    if (filters.houseName) {
      query.houseName = { $regex: filters.houseName, $options: 'i' };
    }
    if (filters.gender) {
      query.gender = filters.gender;
    }
    if (filters.isLocked !== undefined) {
      query.isLocked = String(filters.isLocked) === 'true';
    }

    // Cursor-based pagination
    if (cursor) {
      const operator = order === 'desc' ? '$lt' : '$gt';

      if (sort === 'createdAt' || sort === 'updatedAt' || sort === 'birthDate') {
        query[sort] = { [operator]: new Date(cursor) };
      } else if (mongoose.Types.ObjectId.isValid(cursor)) {
        query._id = { [operator]: new mongoose.Types.ObjectId(cursor) };
      }
    }

    const sortDirection = order === 'desc' ? -1 : 1;

    const users = await User.find(query)
      .select('-changeLog -passwordHash -__v')
      .sort({ [sort]: sortDirection, _id: sortDirection })
      .limit(limit)
      .lean();

    const meta = buildPaginationMeta(users, limit, sort);

    return { users, meta };
  }

  /**
   * جلب قائمة مفاتيح التفاصيل المخصصة المستخدمة مسبقاً (لاقتراحها عند إنشاء مستخدم جديد)
   */
  async getCustomDetailKeys() {
    const result = await User.aggregate([
      { $match: { isDeleted: { $ne: true } } },
      { $project: { keys: { $objectToArray: { $ifNull: ['$customDetails', {}] } } } },
      { $unwind: '$keys' },
      { $group: { _id: '$keys.k' } },
      { $sort: { _id: 1 } },
      { $group: { _id: null, keys: { $push: '$_id' } } },
      { $project: { _id: 0, keys: 1 } },
    ]);
    const keys = result[0]?.keys ?? [];
    return keys;
  }

  /**
   * جلب قائمة أوصاف صلة القرابة (من DB للتوحيد). تُزرع القيم الافتراضية عند أول طلب إن لم توجد.
   */
  async getRelationRoles() {
    await RelationRole.seedDefaultRelationRoles();
    const roles = await RelationRole.find().sort({ order: 1, label: 1 }).lean();
    return roles.map((r) => ({ id: r._id, label: r.label, relation: r.relation }));
  }

  /**
   * إضافة وصف صلة قرابة جديد (يُخزن كـ other)
   */
  async createRelationRole(label) {
    const trimmed = (label || '').trim();
    if (!trimmed) throw ApiError.badRequest('وصف صلة القرابة مطلوب', 'VALIDATION_ERROR');
    const existing = await RelationRole.findOne({ label: trimmed });
    if (existing) return existing.toObject();
    const maxOrder = await RelationRole.findOne().sort({ order: -1 }).select('order').lean();
    const role = await RelationRole.create({
      label: trimmed,
      relation: 'other',
      order: (maxOrder?.order ?? 99) + 1,
    });
    return role.toObject();
  }

  /**
   * جلب قائمة أسماء العائلات المستخدمة مسبقاً (لاقتراحها عند إنشاء مستخدم جديد)
   */
  async getFamilyNames() {
    const result = await User.aggregate([
      { $match: { isDeleted: { $ne: true }, familyName: { $exists: true, $nin: [null, ''] } } },
      { $group: { _id: '$familyName' } },
      { $match: { _id: { $regex: /\S/ } } },
      { $sort: { _id: 1 } },
      { $group: { _id: null, names: { $push: '$_id' } } },
      { $project: { _id: 0, names: 1 } },
    ]);
    const names = (result[0]?.names ?? []).map((n) => (typeof n === 'string' ? n.trim() : n)).filter(Boolean);
    return [...new Set(names)].sort();
  }

  /**
   * جلب قائمة أسماء البيوت المستخدمة مسبقاً (لاقتراحها عند إنشاء مستخدم جديد)
   */
  async getHouseNames() {
    const result = await User.aggregate([
      { $match: { isDeleted: { $ne: true }, houseName: { $exists: true, $nin: [null, ''] } } },
      { $group: { _id: '$houseName' } },
      { $match: { _id: { $regex: /\S/ } } },
      { $sort: { _id: 1 } },
      { $group: { _id: null, names: { $push: '$_id' } } },
      { $project: { _id: 0, names: 1 } },
    ]);
    const names = (result[0]?.names ?? []).map((n) => (typeof n === 'string' ? n.trim() : n)).filter(Boolean);
    return [...new Set(names)].sort();
  }

  async getProfileOptionValues() {
    const baseFilter = { isDeleted: { $ne: true } };
    const [
      tags,
      incomeSources,
      jobTitles,
      employerNames,
      travelDestinations,
      travelReasons,
      healthConditions,
      fieldOfStudies,
      kindergartenNames,
      schoolNames,
      universityNames,
      facultyNames,
    ] = await Promise.all([
      User.distinct('tags', baseFilter),
      User.distinct('financial.source', baseFilter),
      User.distinct('employment.jobTitle', baseFilter),
      User.distinct('employment.employerName', baseFilter),
      User.distinct('presence.travelDestination', baseFilter),
      User.distinct('presence.travelReason', baseFilter),
      User.distinct('health.conditions.name', baseFilter),
      User.distinct('education.fieldOfStudy', baseFilter),
      User.distinct('education.kindergartenName', baseFilter),
      User.distinct('education.schoolName', baseFilter),
      User.distinct('education.universityName', baseFilter),
      User.distinct('education.facultyName', baseFilter),
    ]);

    return {
      tags: this._normalizeDistinctStringValues(tags),
      incomeSources: this._normalizeDistinctStringValues(incomeSources),
      jobTitles: this._normalizeDistinctStringValues(jobTitles),
      employerNames: this._normalizeDistinctStringValues(employerNames),
      travelDestinations: this._normalizeDistinctStringValues(travelDestinations),
      travelReasons: this._normalizeDistinctStringValues(travelReasons),
      healthConditions: this._normalizeDistinctStringValues(healthConditions),
      fieldOfStudies: this._normalizeDistinctStringValues(fieldOfStudies),
      kindergartenNames: this._normalizeDistinctStringValues(kindergartenNames),
      schoolNames: this._normalizeDistinctStringValues(schoolNames),
      universityNames: this._normalizeDistinctStringValues(universityNames),
      facultyNames: this._normalizeDistinctStringValues(facultyNames),
    };
  }

  async _hydrateMeetingAttendanceEntries(entries = []) {
    const attendanceEntries = Array.isArray(entries) ? entries : [];
    if (!attendanceEntries.length) return [];

    const meetingIds = [...new Set(
      attendanceEntries
        .map((entry) => this._toComparableId(entry?.meetingId))
        .filter(Boolean)
    )];
    const actorIds = [...new Set(
      attendanceEntries
        .flatMap((entry) => [
          this._toComparableId(entry?.recordedBy),
          this._toComparableId(entry?.updatedBy),
        ])
        .filter(Boolean)
    )];

    const [meetings, actors] = await Promise.all([
      meetingIds.length
        ? Meeting.find({
          _id: { $in: meetingIds },
          isDeleted: { $ne: true },
        })
          .select('name day time')
          .lean()
        : [],
      actorIds.length
        ? User.find({
          _id: { $in: actorIds },
          isDeleted: { $ne: true },
        })
          .select('fullName')
          .lean()
        : [],
    ]);

    const meetingMap = new Map(
      meetings.map((meeting) => [this._toComparableId(meeting._id), meeting])
    );
    const actorMap = new Map(
      actors.map((actor) => [this._toComparableId(actor._id), actor])
    );

    return attendanceEntries
      .map((entry) => {
        const meetingId = this._toComparableId(entry?.meetingId);
        const recordedById = this._toComparableId(entry?.recordedBy);
        const updatedById = this._toComparableId(entry?.updatedBy);
        const meeting = meetingId ? meetingMap.get(meetingId) : null;
        const recordedBy = recordedById ? actorMap.get(recordedById) : null;
        const updatedBy = updatedById ? actorMap.get(updatedById) : null;

        return {
          ...entry,
          meetingId,
          meeting: meeting
            ? {
              id: meetingId,
              name: meeting.name || '',
              day: meeting.day || '',
              time: meeting.time || '',
            }
            : null,
          recordedBy: recordedById
            ? {
              id: recordedById,
              fullName: recordedBy?.fullName || '',
            }
            : null,
          updatedBy: updatedById
            ? {
              id: updatedById,
              fullName: updatedBy?.fullName || '',
            }
            : null,
        };
      })
      .sort((a, b) => {
        const dateCompare = String(b?.attendanceDate || '').localeCompare(String(a?.attendanceDate || ''));
        if (dateCompare !== 0) return dateCompare;
        return new Date(b?.updatedAt || 0).getTime() - new Date(a?.updatedAt || 0).getTime();
      });
  }

  async _hydrateDivineLiturgyAttendanceEntries(entries = []) {
    const attendanceEntries = Array.isArray(entries) ? entries : [];
    if (!attendanceEntries.length) return [];

    const recurringServiceIds = [...new Set(
      attendanceEntries
        .filter((entry) => String(entry?.entryType || '').trim().toLowerCase() === 'recurring')
        .map((entry) => this._toComparableId(entry?.serviceId))
        .filter(Boolean)
    )];
    const exceptionServiceIds = [...new Set(
      attendanceEntries
        .filter((entry) => String(entry?.entryType || '').trim().toLowerCase() === 'exception')
        .map((entry) => this._toComparableId(entry?.serviceId))
        .filter(Boolean)
    )];
    const actorIds = [...new Set(
      attendanceEntries
        .flatMap((entry) => [
          this._toComparableId(entry?.recordedBy),
          this._toComparableId(entry?.updatedBy),
        ])
        .filter(Boolean)
    )];

    const [recurringServices, exceptionServices, actors] = await Promise.all([
      recurringServiceIds.length
        ? DivineLiturgyRecurring.find({
          _id: { $in: recurringServiceIds },
        })
          .select('serviceType dayOfWeek startTime endTime name')
          .lean()
        : [],
      exceptionServiceIds.length
        ? DivineLiturgyException.find({
          _id: { $in: exceptionServiceIds },
        })
          .select('date startTime endTime name')
          .lean()
        : [],
      actorIds.length
        ? User.find({
          _id: { $in: actorIds },
          isDeleted: { $ne: true },
        })
          .select('fullName')
          .lean()
        : [],
    ]);

    const recurringMap = new Map(
      recurringServices.map((service) => [this._toComparableId(service._id), service])
    );
    const exceptionMap = new Map(
      exceptionServices.map((service) => [this._toComparableId(service._id), service])
    );
    const actorMap = new Map(
      actors.map((actor) => [this._toComparableId(actor._id), actor])
    );

    return attendanceEntries
      .map((entry) => {
        const normalizedEntryType = String(entry?.entryType || '').trim().toLowerCase();
        const serviceId = this._toComparableId(entry?.serviceId);
        const recordedById = this._toComparableId(entry?.recordedBy);
        const updatedById = this._toComparableId(entry?.updatedBy);
        const service =
          normalizedEntryType === 'exception'
            ? this._mapHydratedDivineLiturgyService('exception', serviceId ? exceptionMap.get(serviceId) : null)
            : this._mapHydratedDivineLiturgyService('recurring', serviceId ? recurringMap.get(serviceId) : null);
        const recordedBy = recordedById ? actorMap.get(recordedById) : null;
        const updatedBy = updatedById ? actorMap.get(updatedById) : null;

        return {
          ...entry,
          entryType: normalizedEntryType || 'recurring',
          serviceId,
          service,
          recordedBy: recordedById
            ? {
              id: recordedById,
              fullName: recordedBy?.fullName || '',
            }
            : null,
          updatedBy: updatedById
            ? {
              id: updatedById,
              fullName: updatedBy?.fullName || '',
            }
            : null,
        };
      })
      .sort((a, b) => {
        const dateCompare = String(b?.attendanceDate || '').localeCompare(String(a?.attendanceDate || ''));
        if (dateCompare !== 0) return dateCompare;
        return new Date(b?.updatedAt || 0).getTime() - new Date(a?.updatedAt || 0).getTime();
      });
  }

  /**
   * جلب العلاقات العكسية: مستخدمون أضافوا هذا المستخدم في عائلتهم (أب، أم، زوج، إلخ)
   * يُستخدم لعرض "من يرتبط بي من جهة الآخرين" دون تخزين في الكاش
   */
  async getInverseFamily(userId) {
    const id =
      typeof userId === 'string' && mongoose.Types.ObjectId.isValid(userId)
        ? new mongoose.Types.ObjectId(userId)
        : userId;
    const users = await User.find({
      $or: [
        { 'father.userId': id },
        { 'mother.userId': id },
        { 'spouse.userId': id },
        { 'siblings.userId': id },
        { 'children.userId': id },
        { 'familyMembers.userId': id },
      ],
      isDeleted: { $ne: true },
    })
      .select('fullName phonePrimary gender father mother spouse siblings children familyMembers')
      .lean();

    const result = [];
    const uidStr = id.toString();

    for (const u of users) {
      let linkType = null;
      let notes = '';
      let relationRoleFromOther = '';

      if (u.father?.userId?.toString() === uidStr) {
        linkType = 'father';
        notes = u.father.notes || '';
      } else if (u.mother?.userId?.toString() === uidStr) {
        linkType = 'mother';
        notes = u.mother.notes || '';
      } else if (u.spouse?.userId?.toString() === uidStr) {
        linkType = 'spouse';
        notes = u.spouse.notes || '';
      } else if (u.siblings?.length) {
        const s = u.siblings.find((s) => s.userId?.toString() === uidStr);
        if (s) {
          linkType = 'sibling';
          notes = s.notes || '';
        }
      }
      if (!linkType && u.children?.length) {
        const c = u.children.find((c) => c.userId?.toString() === uidStr);
        if (c) {
          linkType = 'child';
          notes = c.notes || '';
        }
      }
      if (!linkType && u.familyMembers?.length) {
        const m = u.familyMembers.find((m) => m.userId?.toString() === uidStr);
        if (m) {
          linkType = 'other';
          notes = m.notes || '';
          relationRoleFromOther = (m.relationRole || '').trim();
        }
      }

      if (!linkType) continue;

      const isMale = u.gender === 'male';
      const isFemale = u.gender === 'female';
      let relationRole;
      if (linkType === 'father' || linkType === 'mother') {
        relationRole = isMale ? 'الابن' : isFemale ? 'البنت' : 'الابن';
      } else if (linkType === 'spouse') {
        relationRole = isMale ? 'الزوج' : isFemale ? 'الزوجة' : 'الزوج';
      } else if (linkType === 'sibling') {
        relationRole = isMale ? 'الأخ' : isFemale ? 'الأخت' : 'الأخ';
      } else if (linkType === 'child') {
        relationRole = isMale ? 'الأب' : isFemale ? 'الأم' : 'الوالد';
      } else {
        relationRole = relationRoleFromOther || 'آخر';
      }

      result.push({
        userId: u._id,
        name: u.fullName,
        relationRole,
        notes,
        _inverse: true,
      });
    }
    return result;
  }

  /**
   * جلب مستخدم بالمعرف (مع العلاقات العكسية دون تخزينها في الكاش)
   */
  async getUserById(userId) {
    let user;
    try {
      const cached = await redisClient.get(CACHE_KEYS.USER_PROFILE(userId));
      user = cached ? JSON.parse(cached) : null;
    } catch (err) {
      // Cache miss
    }

    if (!user) {
      user = await User.findById(userId)
        .select('-changeLog -passwordHash -__v')
        .lean();
      if (!user) {
        throw ApiError.notFound('المستخدم غير موجود', 'USER_NOT_FOUND');
      }
      try {
        await redisClient.setex(
          CACHE_KEYS.USER_PROFILE(userId),
          CACHE_TTL.USER_PROFILE,
          JSON.stringify(user)
        );
      } catch (err) {
        // Non-fatal
      }
    }

    const [inverseFamily, meetingAttendance, divineLiturgyAttendance] = await Promise.all([
      this.getInverseFamily(user._id || user.id || userId),
      this._hydrateMeetingAttendanceEntries(user.meetingAttendance),
      this._hydrateDivineLiturgyAttendanceEntries(user.divineLiturgyAttendance),
    ]);
    let householdClassificationSummary = null;
    try {
      const householdClassificationService = require('../householdClassifications/householdClassification.service');
      householdClassificationSummary =
        await householdClassificationService.getHouseholdSummaryForUser(user);
    } catch (_error) {
      householdClassificationSummary = null;
    }

    return {
      ...user,
      inverseFamily,
      meetingAttendance,
      divineLiturgyAttendance,
      householdClassificationSummary,
    };
  }

  /**
   * تحديث بيانات المستخدم
   */
  async updateUser(userId, data, updatedByUserId) {
    const normalizedData = await this._normalizeConfessionFatherFields(data);
    const user = await User.findById(userId);
    if (!user) {
      throw ApiError.notFound('المستخدم غير موجود', 'USER_NOT_FOUND');
    }

    await this._assertRoleAndPermissionManagementAllowed({
      actorUserId: updatedByUserId,
      targetUser: user,
      updateData: normalizedData,
    });

    const preparedData = this._sanitizePermissionOverridesForRole(
      normalizedData,
      normalizedData.role || user.role || ROLES.USER
    );

    const allowedFields = [
      'fullName', 'gender', 'birthDate', 'nationalId', 'notes',
      'phonePrimary', 'phoneSecondary', 'whatsappNumber', 'email',
      'address', 'financial', 'employment', 'presence', 'education', 'health',
      'tags', 'familyName', 'houseName', 'role', 'hasLogin', 'extraPermissions',
      'deniedPermissions', 'confessionFatherName', 'confessionFatherUserId',
      'avatar', 'customDetails',
      'father', 'mother', 'spouse', 'siblings', 'children', 'familyMembers',
    ];

    const changes = [];
    let shouldInvalidateSessions = false;
    const authSensitiveFields = new Set(['role', 'hasLogin', 'extraPermissions', 'deniedPermissions']);

    for (const field of allowedFields) {
      if (preparedData[field] !== undefined) {
        const oldVal = user[field];
        const newVal = preparedData[field];

        if (JSON.stringify(oldVal) !== JSON.stringify(newVal)) {
          changes.push({
            field,
            from: oldVal,
            to: newVal,
          });
          user[field] = newVal;
          if (authSensitiveFields.has(field)) {
            shouldInvalidateSessions = true;
          }
        }
      }
    }

    if (preparedData.password !== undefined && preparedData.hasLogin !== false) {
      const nextPassword = typeof preparedData.password === 'string' ? preparedData.password.trim() : '';
      if (nextPassword) {
        if (!user.hasLogin) {
          changes.push({
            field: 'hasLogin',
            from: false,
            to: true,
          });
          user.hasLogin = true;
        }

        const nextLoginIdentifierType =
          preparedData.email !== undefined
            ? (preparedData.email ? 'email' : 'phone')
            : (user.email ? 'email' : 'phone');

        if (user.loginIdentifierType !== nextLoginIdentifierType) {
          changes.push({
            field: 'loginIdentifierType',
            from: user.loginIdentifierType,
            to: nextLoginIdentifierType,
          });
          user.loginIdentifierType = nextLoginIdentifierType;
        }

        changes.push({
          field: 'passwordHash',
          from: '[SECURED]',
          to: '[SECURED]',
        });
        user.passwordHash = nextPassword;
        shouldInvalidateSessions = true;
      }
    }

    if (changes.length === 0) {
      return user.toSafeObject();
    }

    user.updatedBy = updatedByUserId;
    if (shouldInvalidateSessions) {
      user.authVersion = Number(user.authVersion || 0) + 1;
    }
    user.changeLog.push({
      by: updatedByUserId,
      action: 'تحديث بيانات المستخدم',
      changes,
    });

    await user.save();

    // Clear caches
    await this._clearUserCache(userId);

    return user.toSafeObject();
  }

  /**
   * حذف ناعم للمستخدم
   */
  async deleteUser(userId, deletedByUserId) {
    const user = await User.findById(userId);
    if (!user) {
      throw ApiError.notFound('المستخدم غير موجود', 'USER_NOT_FOUND');
    }

    user.isDeleted = true;
    user.deletedAt = new Date();
    user.deletedBy = deletedByUserId;
    user.updatedBy = deletedByUserId;
    user.authVersion = Number(user.authVersion || 0) + 1;
    user.changeLog.push({
      by: deletedByUserId,
      action: 'حذف المستخدم',
      changes: [{ field: 'isDeleted', from: false, to: true }],
    });

    await user.save();
    await this._clearUserCache(userId);
  }

  /**
   * رفع صورة إلى Cloudinary فقط (بدون ربط بمستخدم) - للاستخدام عند إنشاء مستخدم جديد
   */
  async uploadImageToCloudinary(file) {
    validateImageUpload(file, { emptyLabel: 'image' });

    const result = await uploadBufferToCloudinary(
      file,
      {
        folder: 'church/avatars',
        resource_type: 'image',
        transformation: [
          { width: 400, height: 400, crop: 'fill', gravity: 'face' },
          { quality: 'auto', fetch_format: 'auto' },
        ],
      },
      'Failed to upload avatar image'
    );

    return { url: result.secure_url, publicId: result.public_id };
  }

  /**
   * رفع الصورة الشخصية إلى Cloudinary وربطها بمستخدم
   */
  async uploadAvatar(userId, file, updatedByUserId) {
    const { url, publicId } = await this.uploadImageToCloudinary(file);

    const user = await User.findById(userId);
    if (!user) {
      throw ApiError.notFound('المستخدم غير موجود', 'USER_NOT_FOUND');
    }

    // Delete old avatar if exists
    if (user.avatar && user.avatar.publicId) {
      try {
        await cloudinary.uploader.destroy(user.avatar.publicId);
      } catch (err) {
        logger.warn(`فشل حذف الصورة القديمة: ${err.message}`);
      }
    }

    const oldAvatar = user.avatar
      ? { url: user.avatar.url, publicId: user.avatar.publicId }
      : null;

    user.avatar = { url, publicId };
    user.updatedBy = updatedByUserId;
    user.changeLog.push({
      by: updatedByUserId,
      action: 'تحديث الصورة الشخصية',
      changes: [{ field: 'avatar', from: oldAvatar, to: user.avatar }],
    });

    await user.save();
    await this._clearUserCache(userId);

    return user.avatar;
  }

  /**
   * قفل حساب المستخدم
   */
  async lockUser(userId, lockReason, lockedByUserId) {
    const user = await User.findById(userId);
    if (!user) {
      throw ApiError.notFound('المستخدم غير موجود', 'USER_NOT_FOUND');
    }

    if (user.isLocked) {
      throw ApiError.badRequest('الحساب مغلق بالفعل', 'VALIDATION_ERROR');
    }

    user.isLocked = true;
    user.lockReason = lockReason;
    user.lockedAt = new Date();
    user.updatedBy = lockedByUserId;
    user.authVersion = Number(user.authVersion || 0) + 1;
    user.changeLog.push({
      by: lockedByUserId,
      action: 'قفل الحساب',
      changes: [
        { field: 'isLocked', from: false, to: true },
        { field: 'lockReason', from: null, to: lockReason },
      ],
    });

    await user.save();
    await this._clearUserCache(userId);

    return user.toSafeObject();
  }

  /**
   * فتح حساب المستخدم
   */
  async unlockUser(userId, unlockedByUserId) {
    const user = await User.findById(userId);
    if (!user) {
      throw ApiError.notFound('المستخدم غير موجود', 'USER_NOT_FOUND');
    }

    if (!user.isLocked) {
      throw ApiError.badRequest('الحساب غير مغلق', 'VALIDATION_ERROR');
    }

    const oldReason = user.lockReason;
    user.isLocked = false;
    user.lockReason = undefined;
    user.lockedAt = undefined;
    user.updatedBy = unlockedByUserId;
    user.authVersion = Number(user.authVersion || 0) + 1;
    user.changeLog.push({
      by: unlockedByUserId,
      action: 'فتح الحساب',
      changes: [
        { field: 'isLocked', from: true, to: false },
        { field: 'lockReason', from: oldReason, to: null },
      ],
    });

    await user.save();
    await this._clearUserCache(userId);

    return user.toSafeObject();
  }

  /**
   * إدارة الوسوم (إضافة / إزالة)
   */
  async manageTags(userId, { add = [], remove = [] }, updatedByUserId) {
    const user = await User.findById(userId);
    if (!user) {
      throw ApiError.notFound('المستخدم غير موجود', 'USER_NOT_FOUND');
    }

    const oldTags = [...user.tags];

    if (add.length > 0) {
      const newTags = add.filter((t) => !user.tags.includes(t));
      user.tags.push(...newTags);
    }

    if (remove.length > 0) {
      user.tags = user.tags.filter((t) => !remove.includes(t));
    }

    user.updatedBy = updatedByUserId;
    user.changeLog.push({
      by: updatedByUserId,
      action: 'تعديل الوسوم',
      changes: [{ field: 'tags', from: oldTags, to: [...user.tags] }],
    });

    await user.save();
    await this._clearUserCache(userId);

    return user.tags;
  }

  /**
   * ربط فرد عائلة
   * يبحث عن المستخدم المستهدف بالهاتف أو الرقم القومي أو الاسم + تاريخ الميلاد
   * إذا وُجد يربط بالـ userId، وإلا يخزن الاسم فقط
   */
  async linkFamilyMember(userId, data, linkedByUserId) {
    const {
      relation,
      targetPhone,
      targetNationalId,
      targetFullName,
      targetBirthDate,
      name,
      relationRole,
      notes,
    } = data;

    const user = await User.findById(userId);
    if (!user) {
      throw ApiError.notFound('المستخدم غير موجود', 'USER_NOT_FOUND');
    }

    // Search for existing user
    let targetUser = null;
    const searchConditions = [];

    if (targetPhone) searchConditions.push({ phonePrimary: targetPhone });
    if (targetNationalId) searchConditions.push({ nationalId: targetNationalId });
    if (targetFullName && targetBirthDate) {
      searchConditions.push({
        fullName: targetFullName,
        birthDate: new Date(targetBirthDate),
      });
    }

    if (searchConditions.length > 0) {
      targetUser = await User.findOne({ $or: searchConditions }).lean();
    }

    const memberData = {
      userId: targetUser ? targetUser._id : undefined,
      name: targetUser ? targetUser.fullName : name || targetFullName,
      relationRole,
      notes,
    };

    const validSingleRelations = ['father', 'mother', 'spouse'];
    const validArrayRelations = ['sibling', 'child', 'other'];

    if (!validSingleRelations.includes(relation) && !validArrayRelations.includes(relation)) {
      throw ApiError.badRequest('نوع العلاقة غير صالح', 'VALIDATION_ERROR');
    }

    if (validSingleRelations.includes(relation)) {
      user[relation] = memberData;
    } else if (relation === 'sibling') {
      user.siblings.push(memberData);
    } else if (relation === 'child') {
      user.children.push(memberData);
    } else {
      user.familyMembers.push(memberData);
    }

    user.updatedBy = linkedByUserId;
    user.changeLog.push({
      by: linkedByUserId,
      action: 'ربط فرد عائلة',
      changes: [
        {
          field: `family.${relation}`,
          from: null,
          to: { ...memberData, userId: memberData.userId ? String(memberData.userId) : null },
        },
      ],
    });

    await user.save();
    await this._clearUserCache(userId);

    return user.toSafeObject();
  }

  _isChangingPermissionOverrides(updateData = {}) {
    return updateData.extraPermissions !== undefined || updateData.deniedPermissions !== undefined;
  }

  async _assertRoleAndPermissionManagementAllowed({ actorUserId, targetUser, updateData }) {
    const isChangingOverrides = this._isChangingPermissionOverrides(updateData);
    const isTargetSuperAdmin = targetUser?.role === ROLES.SUPER_ADMIN;
    const isPromotingToSuperAdmin = updateData?.role === ROLES.SUPER_ADMIN;

    const touchesSensitiveAuthFields =
      isChangingOverrides || isTargetSuperAdmin || isPromotingToSuperAdmin;

    if (!touchesSensitiveAuthFields) return;

    const actor = await User.findById(actorUserId).select('role').lean();
    if (!actor || actor.role !== ROLES.SUPER_ADMIN) {
      throw ApiError.forbidden(
        'فقط مدير النظام يمكنه تعديل الصلاحيات أو أدوار مدير النظام',
        'PERMISSION_DENIED'
      );
    }
  }

  /**
   * مسح ذاكرة التخزين المؤقت للمستخدم
   */
  async _clearUserCache(userId) {
    try {
      await redisClient.del(CACHE_KEYS.USER_PROFILE(userId));
      await redisClient.del(CACHE_KEYS.USER_PERMISSIONS(userId));
    } catch (err) {
      logger.warn(`فشل مسح ذاكرة التخزين المؤقت للمستخدم ${userId}: ${err.message}`);
    }
  }
}

module.exports = new UserService();
