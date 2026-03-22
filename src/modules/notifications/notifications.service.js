const mongoose = require('mongoose');
const ApiError = require('../../utils/ApiError');
const { buildPaginationMeta } = require('../../utils/pagination');
const Notification = require('./notification.model');
const NotificationType = require('./notificationType.model');
const { PERMISSIONS } = require('../../constants/permissions');
const {
  uploadBufferToCloudinary,
  validateImageUpload,
} = require('../../utils/fileUploads');

const { seedDefaultNotificationTypes } = NotificationType;

class NotificationsService {
  _defaultAudiencePermissions() {
    return [
      PERMISSIONS.NOTIFICATIONS_CREATE,
      PERMISSIONS.NOTIFICATIONS_UPDATE,
      PERMISSIONS.NOTIFICATIONS_TYPES_MANAGE,
    ];
  }

  _buildAudienceQuery(userPermissions = []) {
    return {
      $or: [
        { audienceType: { $exists: false } },
        { audienceType: 'all' },
        {
          audienceType: 'permissions',
          audiencePermissions: { $in: Array.isArray(userPermissions) ? userPermissions : [] },
        },
      ],
    };
  }

  _normalizeAudience(payload = {}) {
    const requestedAudienceType = String(payload?.audienceType || '').trim().toLowerCase();
    if (requestedAudienceType === 'all') {
      return {
        audienceType: 'all',
        audiencePermissions: [],
      };
    }

    const audiencePermissions = [...new Set(
      (Array.isArray(payload?.audiencePermissions) ? payload.audiencePermissions : [])
        .map((permission) => String(permission || '').trim())
        .filter(Boolean)
    )];

    return {
      audienceType: 'permissions',
      audiencePermissions:
        audiencePermissions.length > 0 ? audiencePermissions : this._defaultAudiencePermissions(),
    };
  }

  _canAccessNotification(notification, userPermissions = []) {
    if (!notification) return false;

    const audienceType = String(notification.audienceType || 'all').trim().toLowerCase();
    if (audienceType !== 'permissions') return true;

    const permissionSet = new Set(Array.isArray(userPermissions) ? userPermissions : []);
    return (notification.audiencePermissions || []).some((permission) => permissionSet.has(permission));
  }

  _toObjectId(id, fieldName = 'id') {
    if (!mongoose.Types.ObjectId.isValid(id)) {
      throw ApiError.badRequest(`Invalid ${fieldName}`, 'VALIDATION_ERROR');
    }
    return new mongoose.Types.ObjectId(id);
  }

  _mapType(type) {
    return {
      id: type._id,
      name: type.name,
      isDefault: !!type.isDefault,
      order: type.order,
      createdAt: type.createdAt,
      updatedAt: type.updatedAt,
    };
  }

  _mapNotification(notification) {
    const type = notification.typeId || null;
    const typeIsPopulated = type && typeof type === 'object' && type.name;
    const typeId = typeIsPopulated ? type._id : notification.typeId;

    const creator = notification.createdBy || null;
    const creatorIsPopulated = creator && typeof creator === 'object' && creator.fullName;
    const creatorId = creatorIsPopulated ? creator._id : notification.createdBy;

    const updater = notification.updatedBy || null;
    const updaterIsPopulated = updater && typeof updater === 'object' && updater.fullName;
    const updaterId = updaterIsPopulated ? updater._id : notification.updatedBy;

    return {
      id: notification._id,
      type: {
        id: typeId || null,
        name: typeIsPopulated ? type.name : notification.typeNameSnapshot,
      },
      name: notification.name,
      summary: notification.summary || '',
      details: Array.isArray(notification.details)
        ? notification.details.map((detail) => ({
            id: detail._id || null,
            kind: detail.kind,
            title: detail.title || '',
            content: detail.content || '',
            url: detail.url || '',
          }))
        : [],
      eventDate: notification.eventDate || null,
      coverImageUrl: notification.coverImageUrl || '',
      isActive: notification.isActive !== false,
      audienceType: notification.audienceType || 'all',
      audiencePermissions: Array.isArray(notification.audiencePermissions)
        ? notification.audiencePermissions
        : [],
      sourceType: notification.sourceType || '',
      sourceData: notification.sourceData || null,
      createdBy: creatorId || null,
      createdByUser: creatorId
        ? {
            id: creatorId,
            fullName: creatorIsPopulated ? creator.fullName : null,
          }
        : null,
      updatedBy: updaterId || null,
      updatedByUser: updaterId
        ? {
            id: updaterId,
            fullName: updaterIsPopulated ? updater.fullName : null,
          }
        : null,
      createdAt: notification.createdAt,
      updatedAt: notification.updatedAt,
    };
  }

  async _resolveType(typeId) {
    await seedDefaultNotificationTypes();

    const type = await NotificationType.findById(typeId).lean();
    if (!type) {
      throw ApiError.notFound('Notification type not found', 'RESOURCE_NOT_FOUND');
    }

    return type;
  }

  async listNotificationTypes() {
    await seedDefaultNotificationTypes();

    const types = await NotificationType.find().sort({ order: 1, name: 1 }).lean();
    return types.map((type) => this._mapType(type));
  }

  async createNotificationType(name, actorUserId) {
    await seedDefaultNotificationTypes();

    const trimmedName = (name || '').trim();
    if (!trimmedName) {
      throw ApiError.badRequest('Notification type name is required', 'VALIDATION_ERROR');
    }

    const normalizedName = trimmedName.toLowerCase();
    const existing = await NotificationType.findOne({ normalizedName }).lean();
    if (existing) {
      throw ApiError.conflict('Notification type already exists', 'DUPLICATE_VALUE');
    }

    const maxOrderDoc = await NotificationType.findOne().sort({ order: -1 }).select('order').lean();

    const created = await NotificationType.create({
      name: trimmedName,
      normalizedName,
      isDefault: false,
      order: (maxOrderDoc?.order ?? 99) + 1,
      createdBy: actorUserId,
    });

    return this._mapType(created);
  }

  async uploadImageToCloudinary(file) {
    validateImageUpload(file, { emptyLabel: 'image' });

    const uploadResult = await uploadBufferToCloudinary(
      file,
      {
        folder: 'church/notifications',
        resource_type: 'image',
        transformation: [{ quality: 'auto', fetch_format: 'auto' }],
      },
      'Failed to upload notification image'
    );

    return {
      url: uploadResult.secure_url,
      publicId: uploadResult.public_id,
    };
  }

  async listNotifications({ cursor, limit = 20, order = 'desc', filters = {}, userPermissions = [] }) {
    const query = {};
    const andConditions = [this._buildAudienceQuery(userPermissions)];

    if (filters.typeId) {
      query.typeId = this._toObjectId(filters.typeId, 'typeId');
    }

    if (typeof filters.isActive === 'boolean') {
      query.isActive = filters.isActive;
    }

    if (filters.sourceType) {
      query.sourceType = String(filters.sourceType).trim();
    }

    if (filters.excludeSourceType) {
      query.sourceType = {
        ...(query.sourceType && typeof query.sourceType === 'object' ? query.sourceType : {}),
        $ne: String(filters.excludeSourceType).trim(),
      };
    }

    if (filters.q) {
      andConditions.push({
        $or: [
          { name: { $regex: filters.q, $options: 'i' } },
          { summary: { $regex: filters.q, $options: 'i' } },
        ],
      });
    }

    const createdAtQuery = {};
    if (cursor) {
      const cursorDate = new Date(cursor);
      if (!Number.isNaN(cursorDate.getTime())) {
        createdAtQuery[order === 'desc' ? '$lt' : '$gt'] = cursorDate;
      }
    }

    if (Object.keys(createdAtQuery).length > 0) {
      query.createdAt = createdAtQuery;
    }

    if (andConditions.length > 0) {
      query.$and = andConditions;
    }

    const sortDirection = order === 'desc' ? -1 : 1;

    const notifications = await Notification.find(query)
      .sort({ createdAt: sortDirection, _id: sortDirection })
      .limit(limit)
      .populate('typeId', 'name')
      .populate('createdBy', 'fullName')
      .populate('updatedBy', 'fullName')
      .lean();

    const meta = buildPaginationMeta(notifications, limit, 'createdAt');

    return {
      notifications: notifications.map((notification) => this._mapNotification(notification)),
      meta,
    };
  }

  async createNotification(payload, actorUserId) {
    const type = await this._resolveType(payload.typeId);
    const audience = this._normalizeAudience(payload);

    const created = await Notification.create({
      typeId: type._id,
      typeNameSnapshot: type.name,
      name: payload.name,
      summary: payload.summary || undefined,
      details: payload.details || [],
      eventDate: payload.eventDate ? new Date(payload.eventDate) : undefined,
      coverImageUrl: payload.coverImageUrl || undefined,
      isActive: payload.isActive !== undefined ? payload.isActive : true,
      audienceType: audience.audienceType,
      audiencePermissions: audience.audiencePermissions,
      createdBy: actorUserId,
      updatedBy: actorUserId,
    });

    return this._mapNotification(
      await Notification.findById(created._id)
        .populate('typeId', 'name')
        .populate('createdBy', 'fullName')
        .populate('updatedBy', 'fullName')
        .lean()
    );
  }

  async getNotificationById(id, userPermissions = []) {
    const notification = await Notification.findById(this._toObjectId(id))
      .populate('typeId', 'name')
      .populate('createdBy', 'fullName')
      .populate('updatedBy', 'fullName')
      .lean();

    if (!notification) {
      throw ApiError.notFound('Notification not found', 'RESOURCE_NOT_FOUND');
    }

    if (!this._canAccessNotification(notification, userPermissions)) {
      throw ApiError.notFound('Notification not found', 'RESOURCE_NOT_FOUND');
    }

    return this._mapNotification(notification);
  }

  async updateNotification(id, payload, actorUserId) {
    const notification = await Notification.findById(this._toObjectId(id));
    if (!notification) {
      throw ApiError.notFound('Notification not found', 'RESOURCE_NOT_FOUND');
    }
    const audience = this._normalizeAudience({
      audienceType:
        payload.audienceType !== undefined ? payload.audienceType : notification.audienceType,
      audiencePermissions:
        payload.audiencePermissions !== undefined
          ? payload.audiencePermissions
          : notification.audiencePermissions,
    });

    if (payload.typeId && String(payload.typeId) !== String(notification.typeId)) {
      const type = await this._resolveType(payload.typeId);
      notification.typeId = type._id;
      notification.typeNameSnapshot = type.name;
    }

    if (payload.name !== undefined) {
      notification.name = payload.name;
    }

    if (payload.summary !== undefined) {
      notification.summary = payload.summary || undefined;
    }

    if (payload.details !== undefined) {
      notification.details = payload.details;
    }

    if (payload.eventDate !== undefined) {
      notification.eventDate = payload.eventDate ? new Date(payload.eventDate) : null;
    }

    if (payload.coverImageUrl !== undefined) {
      notification.coverImageUrl = payload.coverImageUrl || undefined;
    }

    if (payload.isActive !== undefined) {
      notification.isActive = payload.isActive;
    }

    notification.audienceType = audience.audienceType;
    notification.audiencePermissions = audience.audiencePermissions;

    notification.updatedBy = actorUserId;
    await notification.save();

    return this._mapNotification(
      await Notification.findById(notification._id)
        .populate('typeId', 'name')
        .populate('createdBy', 'fullName')
        .populate('updatedBy', 'fullName')
        .lean()
    );
  }
}

module.exports = new NotificationsService();
