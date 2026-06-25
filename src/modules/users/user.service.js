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
const { ACCOUNT_STATUSES } = require('../../constants/accountStatuses');
const { SERVICE_TYPES } = require('../divineLiturgies/divineLiturgyRecurring.model');
const logger = require('../../utils/logger');
const { validateImageUpload } = require('../../utils/fileUploads');
const storageService = require('../../services/storage/storage.service');

const LIST_USER_SELECT = [
  '_id',
  'fullName',
  'gender',
  'birthDate',
  'avatar',
  'phonePrimary',
  'phoneSecondary',
  'whatsappNumber',
  'email',
  'nationalId',
  'familyName',
  'houseName',
  'ageGroup',
  'role',
  'accountStatus',
  'hasLogin',
  'loginIdentifierType',
  'lastLoginAt',
  'isLocked',
  'lockReason',
  'createdAt',
  'updatedAt',
  'tags',
  'address.governorate',
  'address.city',
  'address.street',
  'employment.status',
  'education.stage',
  'presence.status',
  'confessionFatherName',
  'confessionFatherUserId',
].join(' ');

const EXPLORER_USER_PROJECT = {
  _id: 1,
  fullName: 1,
  gender: 1,
  birthDate: 1,
  avatar: 1,
  phonePrimary: 1,
  phoneSecondary: 1,
  whatsappNumber: 1,
  email: 1,
  nationalId: 1,
  address: 1,
  tags: 1,
  customDetails: 1,
  financial: 1,
  employment: 1,
  presence: 1,
  education: 1,
  health: 1,
  notes: 1,
  familyName: 1,
  houseName: 1,
  ageGroup: 1,
  role: 1,
  extraPermissions: 1,
  deniedPermissions: 1,
  accountStatus: 1,
  hasLogin: 1,
  loginIdentifierType: 1,
  lastLoginAt: 1,
  isLocked: 1,
  createdAt: 1,
  updatedAt: 1,
  confessionFatherName: 1,
  confessionFatherUserId: 1,
  hasFather: { $ne: ['$father', null] },
  hasMother: { $ne: ['$mother', null] },
  hasSpouse: { $ne: ['$spouse', null] },
  siblingCount: { $size: { $ifNull: ['$siblings', []] } },
  childrenCount: { $size: { $ifNull: ['$children', []] } },
  otherFamilyCount: { $size: { $ifNull: ['$familyMembers', []] } },
  meetingIdsCount: { $size: { $ifNull: ['$meetingIds', []] } },
  meetingAttendanceCount: { $size: { $ifNull: ['$meetingAttendance', []] } },
  divineAttendanceCount: { $size: { $ifNull: ['$divineLiturgyAttendance', []] } },
  confessionSessionCount: { $size: { $ifNull: ['$confessionSessionIds', []] } },
  lastMeetingAttendanceDate: { $max: '$meetingAttendance.attendanceDate' },
  lastDivineAttendanceDate: { $max: '$divineLiturgyAttendance.attendanceDate' },
  familyConnectionsCount: {
    $add: [
      { $cond: [{ $ne: ['$father', null] }, 1, 0] },
      { $cond: [{ $ne: ['$mother', null] }, 1, 0] },
      { $cond: [{ $ne: ['$spouse', null] }, 1, 0] },
      { $size: { $ifNull: ['$siblings', []] } },
      { $size: { $ifNull: ['$children', []] } },
      { $size: { $ifNull: ['$familyMembers', []] } },
    ],
  },
};

const LIST_SORTS = new Set(['createdAt', 'updatedAt', 'fullName', 'birthDate']);
const LIST_FIELDS = new Set(['list', 'explorer']);
const MAX_LIST_LIMIT = 100;
const ARABIC_DIACRITICS_PATTERN = /[ً-ٰٟـ]/g;
const ARABIC_DIACRITICS_REGEX_FRAGMENT = '[ً-ٰٟـ]*';
const ARABIC_TITLE_WORDS = new Set([
  'القس',
  'قس',
  'القمص',
  'قمص',
  'ابونا',
  'الاب',
  'اب',
]);

function escapeRegex(value = '') {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function compactString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeArabicSearchText(value = '') {
  return compactString(value)
    .replace(ARABIC_DIACRITICS_PATTERN, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildArabicFlexibleRegex(value, { prefix = false } = {}) {
  const normalized = normalizeArabicSearchText(value);
  if (!normalized) return null;

  const chars = Array.from(normalized);
  let pattern = prefix ? '^' : '';

  chars.forEach((char) => {
    if (/\s/.test(char)) {
      pattern += '\\s*';
      return;
    }

    if (char === 'ا') {
      pattern += '[اأإآٱ]';
    } else if (char === 'ي') {
      pattern += '[يىئ]';
    } else if (char === 'و') {
      pattern += '[وؤ]';
    } else if (char === 'ه') {
      pattern += '[هة]';
    } else {
      pattern += escapeRegex(char);
    }

    pattern += ARABIC_DIACRITICS_REGEX_FRAGMENT;
  });

  return new RegExp(pattern, 'i');
}

function getNameSearchTokens(value = '') {
  const normalized = normalizeArabicSearchText(value).replace(/(^|\s)عبد(?=\S)/g, '$1عبد ');
  if (!normalized) return [];

  return normalized
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token && !ARABIC_TITLE_WORDS.has(token));
}

function buildNameSearchCondition(value = '') {
  const tokens = getNameSearchTokens(value);

  if (tokens.length > 0) {
    const tokenConditions = tokens
      .map((token) => buildArabicFlexibleRegex(token))
      .filter(Boolean)
      .map((regex) => ({ fullName: regex }));

    if (tokenConditions.length === 1) return tokenConditions[0];
    if (tokenConditions.length > 1) return { $and: tokenConditions };
  }

  const fallbackRegex = buildSafeRegex(value);
  return fallbackRegex ? { fullName: fallbackRegex } : null;
}

function buildSafeRegex(value, { prefix = false } = {}) {
  const term = compactString(value);
  if (!term) return null;
  return new RegExp(`${prefix ? '^' : ''}${escapeRegex(term)}`, 'i');
}

function normalizePositiveInt(value, fallback, max = Number.MAX_SAFE_INTEGER) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, max);
}

function normalizeAggregateBuckets(items = []) {
  return (Array.isArray(items) ? items : [])
    .map((item) => ({
      name: item?._id == null ? '' : String(item._id).trim(),
      count: Number(item?.count || 0),
    }))
    .filter((item) => item.name && item.count > 0);
}

function normalizeRankBuckets(items = []) {
  return (Array.isArray(items) ? items : [])
    .map((item) => ({
      name: item?._id == null ? '' : String(item._id).trim(),
      count: Number(item?.count || 0),
      lockedCount: Number(item?.lockedCount || 0),
      loginEnabledCount: Number(item?.loginEnabledCount || 0),
      familyCount: Number(item?.familyCount || 0),
      houseCount: Number(item?.houseCount || 0),
      averageAge: item?.averageAge == null ? null : Math.round(Number(item.averageAge)),
    }))
    .filter((item) => item.name && item.count > 0);
}

function formatYearMonth(year, month) {
  if (!year || !month) return '';
  return `${year}-${String(month).padStart(2, '0')}`;
}

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

  _getLoginIdentifierType(data = {}) {
    if (data.email) return 'email';
    if (data.phonePrimary) return 'phone';
    if (data.nationalId) return 'nationalId';
    return 'phone';
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
    if (!userData.accountStatus) {
      userData.accountStatus = ACCOUNT_STATUSES.APPROVED;
    }
    if (
      preparedData.avatar &&
      typeof preparedData.avatar === 'object' &&
      preparedData.avatar.url &&
      preparedData.avatar.storageKey
    ) {
      userData.avatar = {
        url: preparedData.avatar.url,
        storageKey: preparedData.avatar.storageKey,
        provider: preparedData.avatar.provider || 'r2',
        mimeType: preparedData.avatar.mimeType || '',
        size: Number(preparedData.avatar.size) || 0,
      };
    }

    if (preparedData.password) {
      userData.hasLogin = true;
      userData.passwordHash = preparedData.password;
      userData.loginIdentifierType = this._getLoginIdentifierType(preparedData);
      delete userData.password;
    }

    const user = new User(userData);
    await user.save();

    return user.toSafeObject();
  }

  /**
   * جلب قائمة المستخدمين مع ترقيم المؤشر (Cursor Pagination)
   */
  async listUsers({
    cursor,
    page = 1,
    limit = 20,
    sort = 'createdAt',
    order = 'desc',
    fields = 'list',
    filters = {},
  }) {
    const safeLimit = normalizePositiveInt(limit, 20, MAX_LIST_LIMIT);
    const safePage = normalizePositiveInt(page, 1);
    const safeSort = LIST_SORTS.has(sort) ? sort : 'createdAt';
    const safeOrder = order === 'asc' ? 'asc' : 'desc';
    const safeFields = LIST_FIELDS.has(fields) ? fields : 'list';
    const sortDirection = safeOrder === 'desc' ? -1 : 1;

    const baseQuery = { isDeleted: { $ne: true } };

    const namePhoneOrConditions = [];
    const searchTerm = compactString(
      filters.search || filters.q || filters.keyword || filters.name || filters.displayName
    );
    if (searchTerm) {
      const identifierRegex = buildSafeRegex(searchTerm, { prefix: true });
      const nameCondition = buildNameSearchCondition(searchTerm);
      if (nameCondition) {
        namePhoneOrConditions.push(nameCondition);
      }
      namePhoneOrConditions.push(
        { phonePrimary: identifierRegex },
        { phoneSecondary: identifierRegex },
        { whatsappNumber: identifierRegex },
        { email: identifierRegex },
        { nationalId: identifierRegex },
        { familyName: buildArabicFlexibleRegex(searchTerm) || buildSafeRegex(searchTerm) },
        { houseName: buildArabicFlexibleRegex(searchTerm) || buildSafeRegex(searchTerm) }
      );
    } else {
      const fullNameCondition = buildNameSearchCondition(filters.fullName);
      const phoneRegex = buildSafeRegex(filters.phonePrimary, { prefix: true });
      if (fullNameCondition) namePhoneOrConditions.push(fullNameCondition);
      if (phoneRegex) namePhoneOrConditions.push({ phonePrimary: phoneRegex });
    }

    if (namePhoneOrConditions.length === 1) {
      Object.assign(baseQuery, namePhoneOrConditions[0]);
    } else if (namePhoneOrConditions.length > 1) {
      baseQuery.$or = namePhoneOrConditions;
    }
    if (filters.ageGroup) {
      baseQuery.ageGroup = filters.ageGroup;
    }
    if (filters.tags) {
      const tagsArray = (Array.isArray(filters.tags) ? filters.tags : [filters.tags])
        .map((tag) => compactString(tag))
        .filter(Boolean);
      if (tagsArray.length > 0) {
        baseQuery.tags = { $in: tagsArray };
      }
    }
    if (filters.role) {
      baseQuery.role = filters.role;
    }
    if (filters.accountStatus) {
      baseQuery.accountStatus = filters.accountStatus;
    }
    const familyNameRegex = buildSafeRegex(filters.familyName, { prefix: true });
    if (familyNameRegex) {
      baseQuery.familyName = familyNameRegex;
    }
    const houseNameRegex = buildSafeRegex(filters.houseName, { prefix: true });
    if (houseNameRegex) {
      baseQuery.houseName = houseNameRegex;
    }
    if (filters.gender) {
      baseQuery.gender = filters.gender;
    }
    if (filters.isLocked !== undefined) {
      baseQuery.isLocked = String(filters.isLocked) === 'true';
    }

    const query = { ...baseQuery };

    if (cursor) {
      const operator = safeOrder === 'desc' ? '$lt' : '$gt';

      if (safeSort === 'createdAt' || safeSort === 'updatedAt' || safeSort === 'birthDate') {
        const cursorDate = new Date(cursor);
        if (!Number.isNaN(cursorDate.getTime())) {
          query[safeSort] = { [operator]: cursorDate };
        }
      } else if (mongoose.Types.ObjectId.isValid(cursor)) {
        query._id = { [operator]: new mongoose.Types.ObjectId(cursor) };
      }
    }

    const sortSpec = { [safeSort]: sortDirection, _id: sortDirection };
    const skip = cursor ? 0 : (safePage - 1) * safeLimit;
    const fetchLimit = safeLimit + 1;

    const usersQuery =
      safeFields === 'explorer'
        ? User.aggregate([
            { $match: query },
            { $sort: sortSpec },
            ...(skip > 0 ? [{ $skip: skip }] : []),
            { $limit: fetchLimit },
            { $project: EXPLORER_USER_PROJECT },
          ])
        : User.find(query)
            .select(LIST_USER_SELECT)
            .sort(sortSpec)
            .skip(skip)
            .limit(fetchLimit)
            .lean();

    const [total, fetchedUsers] = await Promise.all([
      User.countDocuments(baseQuery),
      usersQuery,
    ]);

    const hasMore = fetchedUsers.length > safeLimit;
    const users = hasMore ? fetchedUsers.slice(0, safeLimit) : fetchedUsers;
    const totalPages = Math.max(1, Math.ceil(total / safeLimit));
    const nextCursorMeta = buildPaginationMeta(users, safeLimit, safeSort);
    const nextCursor = hasMore ? nextCursorMeta.nextCursor : null;
    const repeatedCursor = Boolean(cursor && nextCursor && nextCursor === cursor);
    const hasNextPage = !repeatedCursor && (cursor ? hasMore : safePage < totalPages);

    const meta = {
      page: safePage,
      limit: safeLimit,
      total,
      totalCount: total,
      totalPages,
      hasNextPage,
      hasPrevPage: cursor ? Boolean(cursor) : safePage > 1,
      hasMore,
      nextCursor: repeatedCursor ? null : nextCursor,
      count: users.length,
      sort: safeSort,
      order: safeOrder,
      fields: safeFields,
    };

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
  async getFamilyHouseAnalytics() {
    const [result = {}] = await User.aggregate([
      { $match: { isDeleted: { $ne: true } } },
      {
        $project: {
          gender: 1,
          birthDate: 1,
          ageGroup: 1,
          role: 1,
          accountStatus: 1,
          hasLogin: 1,
          isLocked: 1,
          familyName: { $trim: { input: { $ifNull: ['$familyName', ''] } } },
          houseName: { $trim: { input: { $ifNull: ['$houseName', ''] } } },
          city: { $trim: { input: { $ifNull: ['$address.city', ''] } } },
          governorate: { $trim: { input: { $ifNull: ['$address.governorate', ''] } } },
          presenceStatus: '$presence.status',
          employmentStatus: '$employment.status',
          createdAt: 1,
          createdYear: { $year: '$createdAt' },
          createdMonth: { $month: '$createdAt' },
        },
      },
      {
        $addFields: {
          hasFamilyName: { $gt: [{ $strLenCP: '$familyName' }, 0] },
          hasHouseName: { $gt: [{ $strLenCP: '$houseName' }, 0] },
          age: {
            $cond: [
              { $ifNull: ['$birthDate', false] },
              { $dateDiff: { startDate: '$birthDate', endDate: '$$NOW', unit: 'year' } },
              null,
            ],
          },
        },
      },
      {
        $facet: {
          totals: [
            {
              $group: {
                _id: null,
                totalMembers: { $sum: 1 },
                lockedMembers: { $sum: { $cond: ['$isLocked', 1, 0] } },
                loginEnabledMembers: { $sum: { $cond: ['$hasLogin', 1, 0] } },
                membersWithFamilyName: { $sum: { $cond: ['$hasFamilyName', 1, 0] } },
                membersWithHouseName: { $sum: { $cond: ['$hasHouseName', 1, 0] } },
                averageAge: { $avg: '$age' },
              },
            },
          ],
          familyRanks: [
            { $match: { hasFamilyName: true } },
            {
              $group: {
                _id: '$familyName',
                count: { $sum: 1 },
                lockedCount: { $sum: { $cond: ['$isLocked', 1, 0] } },
                loginEnabledCount: { $sum: { $cond: ['$hasLogin', 1, 0] } },
                houseNames: { $addToSet: '$houseName' },
                averageAge: { $avg: '$age' },
              },
            },
            {
              $project: {
                count: 1,
                lockedCount: 1,
                loginEnabledCount: 1,
                averageAge: 1,
                houseCount: {
                  $size: {
                    $filter: {
                      input: '$houseNames',
                      as: 'name',
                      cond: { $gt: [{ $strLenCP: '$$name' }, 0] },
                    },
                  },
                },
              },
            },
            { $sort: { count: -1, _id: 1 } },
            { $limit: 12 },
          ],
          familyTotals: [
            { $match: { hasFamilyName: true } },
            { $group: { _id: '$familyName' } },
            { $count: 'count' },
          ],
          houseRanks: [
            { $match: { hasHouseName: true } },
            {
              $group: {
                _id: '$houseName',
                count: { $sum: 1 },
                lockedCount: { $sum: { $cond: ['$isLocked', 1, 0] } },
                loginEnabledCount: { $sum: { $cond: ['$hasLogin', 1, 0] } },
                familyNames: { $addToSet: '$familyName' },
                averageAge: { $avg: '$age' },
              },
            },
            {
              $project: {
                count: 1,
                lockedCount: 1,
                loginEnabledCount: 1,
                averageAge: 1,
                familyCount: {
                  $size: {
                    $filter: {
                      input: '$familyNames',
                      as: 'name',
                      cond: { $gt: [{ $strLenCP: '$$name' }, 0] },
                    },
                  },
                },
              },
            },
            { $sort: { count: -1, _id: 1 } },
            { $limit: 12 },
          ],
          houseTotals: [
            { $match: { hasHouseName: true } },
            { $group: { _id: '$houseName' } },
            { $count: 'count' },
          ],
          ageGroups: [
            { $match: { ageGroup: { $exists: true, $nin: [null, ''] } } },
            { $group: { _id: '$ageGroup', count: { $sum: 1 } } },
            { $sort: { count: -1, _id: 1 } },
          ],
          genders: [
            { $match: { gender: { $exists: true, $nin: [null, ''] } } },
            { $group: { _id: '$gender', count: { $sum: 1 } } },
            { $sort: { count: -1, _id: 1 } },
          ],
          accountStatuses: [
            { $match: { accountStatus: { $exists: true, $nin: [null, ''] } } },
            { $group: { _id: '$accountStatus', count: { $sum: 1 } } },
            { $sort: { count: -1, _id: 1 } },
          ],
          roles: [
            { $match: { role: { $exists: true, $nin: [null, ''] } } },
            { $group: { _id: '$role', count: { $sum: 1 } } },
            { $sort: { count: -1, _id: 1 } },
          ],
          presenceStatuses: [
            { $match: { presenceStatus: { $exists: true, $nin: [null, ''] } } },
            { $group: { _id: '$presenceStatus', count: { $sum: 1 } } },
            { $sort: { count: -1, _id: 1 } },
          ],
          employmentStatuses: [
            { $match: { employmentStatus: { $exists: true, $nin: [null, ''] } } },
            { $group: { _id: '$employmentStatus', count: { $sum: 1 } } },
            { $sort: { count: -1, _id: 1 } },
          ],
          cityRanks: [
            { $match: { city: { $ne: '' } } },
            { $group: { _id: '$city', count: { $sum: 1 } } },
            { $sort: { count: -1, _id: 1 } },
            { $limit: 10 },
          ],
          governorateRanks: [
            { $match: { governorate: { $ne: '' } } },
            { $group: { _id: '$governorate', count: { $sum: 1 } } },
            { $sort: { count: -1, _id: 1 } },
            { $limit: 10 },
          ],
          monthlyTrend: [
            { $match: { createdAt: { $type: 'date' } } },
            { $group: { _id: { year: '$createdYear', month: '$createdMonth' }, count: { $sum: 1 } } },
            { $sort: { '_id.year': -1, '_id.month': -1 } },
            { $limit: 12 },
            { $sort: { '_id.year': 1, '_id.month': 1 } },
          ],
        },
      },
    ]);

    const totals = result.totals?.[0] || {};
    const totalMembers = Number(totals.totalMembers || 0);
    const membersWithFamilyName = Number(totals.membersWithFamilyName || 0);
    const membersWithHouseName = Number(totals.membersWithHouseName || 0);
    const familyRanks = normalizeRankBuckets(result.familyRanks);
    const houseRanks = normalizeRankBuckets(result.houseRanks);

    return {
      summary: {
        totalMembers,
        totalFamilies: Number(result.familyTotals?.[0]?.count || 0),
        totalHouses: Number(result.houseTotals?.[0]?.count || 0),
        lockedMembers: Number(totals.lockedMembers || 0),
        loginEnabledMembers: Number(totals.loginEnabledMembers || 0),
        membersWithFamilyName,
        membersWithHouseName,
        familyCoveragePct: totalMembers ? Math.round((membersWithFamilyName / totalMembers) * 100) : 0,
        houseCoveragePct: totalMembers ? Math.round((membersWithHouseName / totalMembers) * 100) : 0,
        averageAge: totals.averageAge == null ? null : Math.round(Number(totals.averageAge)),
      },
      familyRanks,
      houseRanks,
      distributions: {
        ageGroups: normalizeAggregateBuckets(result.ageGroups),
        genders: normalizeAggregateBuckets(result.genders),
        accountStatuses: normalizeAggregateBuckets(result.accountStatuses),
        roles: normalizeAggregateBuckets(result.roles),
        presenceStatuses: normalizeAggregateBuckets(result.presenceStatuses),
        employmentStatuses: normalizeAggregateBuckets(result.employmentStatuses),
        cities: normalizeAggregateBuckets(result.cityRanks),
        governorates: normalizeAggregateBuckets(result.governorateRanks),
      },
      trends: {
        monthlyRegistrations: (result.monthlyTrend || [])
          .map((item) => ({
            label: formatYearMonth(item?._id?.year, item?._id?.month),
            count: Number(item?.count || 0),
          }))
          .filter((item) => item.label),
      },
    };
  }

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
      'tags', 'familyName', 'houseName', 'role', 'accountStatus', 'hasLogin', 'extraPermissions',
      'deniedPermissions', 'confessionFatherName', 'confessionFatherUserId',
      'avatar', 'customDetails',
      'father', 'mother', 'spouse', 'siblings', 'children', 'familyMembers',
    ];

    const changes = [];
    let shouldInvalidateSessions = false;
    const authSensitiveFields = new Set([
      'role',
      'accountStatus',
      'hasLogin',
      'extraPermissions',
      'deniedPermissions',
    ]);

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

        const nextLoginIdentifierType = this._getLoginIdentifierType({
          email: preparedData.email !== undefined ? preparedData.email : user.email,
          phonePrimary:
            preparedData.phonePrimary !== undefined ? preparedData.phonePrimary : user.phonePrimary,
          nationalId: preparedData.nationalId !== undefined ? preparedData.nationalId : user.nationalId,
        });

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
   * رفع صورة إلى storage فقط (بدون ربط بمستخدم) - للاستخدام عند إنشاء مستخدم جديد
   */
  async uploadImageToStorage(file, userId = 'pending') {
    const fileDetails = validateImageUpload(file, { emptyLabel: 'image' });

    const result = await storageService.uploadFile(file, {
      prefix: `users/avatars/${userId || 'pending'}`,
      fileDetails,
      failureMessage: 'Failed to upload avatar image',
    });

    return {
      url: result.url,
      storageKey: result.storageKey,
      provider: result.provider,
      mimeType: result.mimeType,
      size: result.size,
    };
  }

  /**
   * رفع الصورة الشخصية إلى storage وربطها بمستخدم
   */
  async uploadAvatar(userId, file, updatedByUserId) {
    const avatar = await this.uploadImageToStorage(file, userId);

    const user = await User.findById(userId);
    if (!user) {
      throw ApiError.notFound('المستخدم غير موجود', 'USER_NOT_FOUND');
    }

    // Delete old avatar if exists
    if (user.avatar && user.avatar.storageKey) {
      try {
        await storageService.deleteFile(user.avatar.storageKey);
      } catch (err) {
        logger.warn(`فشل حذف الصورة القديمة: ${err.message}`);
      }
    }

    const oldAvatar = user.avatar
      ? {
          url: user.avatar.url,
          storageKey: user.avatar.storageKey,
          provider: user.avatar.provider,
          mimeType: user.avatar.mimeType,
          size: user.avatar.size,
        }
      : null;

    user.avatar = avatar;
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

