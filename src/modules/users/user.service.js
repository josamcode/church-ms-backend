const mongoose = require('mongoose');
const User = require('./user.model');
const RelationRole = require('./relationRole.model');
const ApiError = require('../../utils/ApiError');
const redisClient = require('../../config/redis');
const cloudinary = require('../../config/cloudinary');
const streamifier = require('streamifier');
const { CACHE_KEYS, CACHE_TTL } = require('../../constants/cacheKeys');
const { buildPaginationMeta } = require('../../utils/pagination');
const { ROLES } = require('../../constants/roles');
const config = require('../../config/env');
const logger = require('../../utils/logger');

class UserService {
  /**
   * إنشاء مستخدم جديد (مع أو بدون تسجيل دخول)
   */
  async createUser(data, createdByUserId) {
    await this._assertRoleAndPermissionManagementAllowed({
      actorUserId: createdByUserId,
      targetUser: null,
      updateData: data,
    });

    const orConditions = [{ phonePrimary: data.phonePrimary }];
    if (data.email) orConditions.push({ email: data.email });
    if (data.nationalId) orConditions.push({ nationalId: data.nationalId });

    const existing = await User.findOne({ $or: orConditions }).lean();

    if (existing) {
      if (existing.phonePrimary === data.phonePrimary) {
        throw ApiError.conflict('رقم الهاتف مسجل مسبقاً', 'DUPLICATE_PHONE');
      }
      if (data.email && existing.email === data.email) {
        throw ApiError.conflict('البريد الإلكتروني مسجل مسبقاً', 'DUPLICATE_EMAIL');
      }
      if (data.nationalId && existing.nationalId === data.nationalId) {
        throw ApiError.conflict('الرقم القومي مسجل مسبقاً', 'DUPLICATE_NATIONAL_ID');
      }
    }

    const userData = { ...data, createdBy: createdByUserId };
    if (data.avatar && typeof data.avatar === 'object' && data.avatar.url && data.avatar.publicId) {
      userData.avatar = { url: data.avatar.url, publicId: data.avatar.publicId };
    }

    if (data.password) {
      userData.hasLogin = true;
      userData.passwordHash = data.password;
      userData.loginIdentifierType = data.email ? 'email' : 'phone';
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
    if (filters.fullName) {
      query.fullName = { $regex: filters.fullName, $options: 'i' };
    }
    if (filters.phonePrimary) {
      query.phonePrimary = { $regex: filters.phonePrimary, $options: 'i' };
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

    const inverseFamily = await this.getInverseFamily(user._id || user.id || userId);
    return { ...user, inverseFamily };
  }

  /**
   * تحديث بيانات المستخدم
   */
  async updateUser(userId, data, updatedByUserId) {
    const user = await User.findById(userId);
    if (!user) {
      throw ApiError.notFound('المستخدم غير موجود', 'USER_NOT_FOUND');
    }

    await this._assertRoleAndPermissionManagementAllowed({
      actorUserId: updatedByUserId,
      targetUser: user,
      updateData: data,
    });

    const allowedFields = [
      'fullName', 'gender', 'birthDate', 'nationalId', 'notes',
      'phonePrimary', 'phoneSecondary', 'whatsappNumber', 'email',
      'address', 'tags', 'familyName', 'houseName', 'role', 'extraPermissions',
      'deniedPermissions', 'confessionFatherName', 'confessionFatherUserId',
      'avatar', 'customDetails',
      'father', 'mother', 'spouse', 'siblings', 'children', 'familyMembers',
    ];

    const changes = [];

    for (const field of allowedFields) {
      if (data[field] !== undefined) {
        const oldVal = user[field];
        const newVal = data[field];

        if (JSON.stringify(oldVal) !== JSON.stringify(newVal)) {
          changes.push({
            field,
            from: oldVal,
            to: newVal,
          });
          user[field] = newVal;
        }
      }
    }

    if (data.password !== undefined) {
      const nextPassword = typeof data.password === 'string' ? data.password.trim() : '';
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
          data.email !== undefined
            ? (data.email ? 'email' : 'phone')
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
      }
    }

    if (changes.length === 0) {
      return user.toSafeObject();
    }

    user.updatedBy = updatedByUserId;
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
    if (!file) {
      throw ApiError.badRequest('يجب اختيار صورة', 'UPLOAD_FAILED');
    }
    if (!config.upload.allowedImageTypes.includes(file.mimetype)) {
      throw ApiError.badRequest(
        'نوع الملف غير مسموح به. الأنواع المسموحة: JPEG, PNG, GIF, WEBP',
        'UPLOAD_INVALID_TYPE'
      );
    }
    if (file.size > config.upload.maxFileSize) {
      throw ApiError.badRequest(
        `حجم الملف يتجاوز الحد المسموح (${Math.round(config.upload.maxFileSize / 1024 / 1024)} ميجابايت)`,
        'UPLOAD_FILE_TOO_LARGE'
      );
    }

    const result = await new Promise((resolve, reject) => {
      const uploadStream = cloudinary.uploader.upload_stream(
        {
          folder: 'church/avatars',
          resource_type: 'image',
          transformation: [
            { width: 400, height: 400, crop: 'fill', gravity: 'face' },
            { quality: 'auto', fetch_format: 'auto' },
          ],
        },
        (error, result) => {
          if (error) {
            logger.error(`Cloudinary upload error: ${error.message}`);
            reject(ApiError.internal('فشل رفع الصورة'));
          } else {
            resolve(result);
          }
        }
      );
      streamifier.createReadStream(file.buffer).pipe(uploadStream);
    });

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
