const mongoose = require('mongoose');
const ApiError = require('../../utils/ApiError');
const { buildPaginationMeta } = require('../../utils/pagination');
const logger = require('../../utils/logger');
const { getEffectivePermissions } = require('../../constants/permissions');
const Notification = require('./notification.model');
const NotificationType = require('./notificationType.model');
const PushSubscription = require('./pushSubscription.model');
const pushService = require('./push.service');
const User = require('../users/user.model');
const platformSettingsService = require('../settings/platformSettings.service');
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

  _extractPushMessage(notification = {}) {
    const summary = String(notification.summary || '').trim();
    if (summary) {
      return summary.slice(0, 2000);
    }

    const details = Array.isArray(notification.details) ? notification.details : [];
    const firstMeaningfulDetail = details.find((detail) => {
      const content = String(detail?.content || '').trim();
      const title = String(detail?.title || '').trim();
      const url = String(detail?.url || '').trim();
      return Boolean(content || title || url);
    });

    if (firstMeaningfulDetail) {
      return String(
        firstMeaningfulDetail.content
        || firstMeaningfulDetail.title
        || firstMeaningfulDetail.url
        || ''
      )
        .trim()
        .slice(0, 2000);
    }

    const typeName = String(notification?.type?.name || notification?.typeNameSnapshot || '').trim();
    if (typeName) {
      return typeName.slice(0, 2000);
    }

    return String(notification.name || '').trim().slice(0, 2000);
  }

  async _buildPushNotificationPayload(notification = {}) {
    const notificationId = String(notification.id || notification._id || '').trim();
    const notificationName = String(notification.name || '').trim();
    const typeName = String(notification?.type?.name || notification?.typeNameSnapshot || '').trim();
    const fallbackMessage = this._extractPushMessage(notification);
    const renderedTemplate = await platformSettingsService.renderDashboardNotificationPublishedNotification({
      notificationName,
      notificationSummary: fallbackMessage,
      notificationTypeName: typeName,
      eventDate: notification?.eventDate || null,
    });

    return {
      id: notificationId || `content-${Date.now()}`,
      type: 'content_notification',
      title: String(renderedTemplate?.title || notificationName || typeName || 'Notification')
        .trim()
        .slice(0, 160),
      message: String(renderedTemplate?.message || fallbackMessage || notificationName)
        .trim()
        .slice(0, 2000),
      link: notificationId ? `/dashboard/notifications/${notificationId}` : '/dashboard/notifications',
    };
  }

  _canReceiveAudienceNotification(user = {}, audience = {}) {
    const audienceType = String(audience?.audienceType || 'all').trim().toLowerCase();
    if (audienceType !== 'permissions') {
      return true;
    }

    const requiredPermissions = Array.isArray(audience?.audiencePermissions)
      ? audience.audiencePermissions
      : [];
    if (!requiredPermissions.length) {
      return true;
    }

    const effectivePermissions = getEffectivePermissions(
      user.role,
      user.extraPermissions || [],
      user.deniedPermissions || []
    );
    const permissionSet = new Set(effectivePermissions);

    return requiredPermissions.some((permission) => permissionSet.has(permission));
  }

  async _sendPushToAudience(notification = {}) {
    if (!pushService.isEnabled() || notification?.isActive === false) {
      return {
        eligibleUserCount: 0,
        deliveredUserCount: 0,
        deviceDeliveryCount: 0,
        skipped: true,
      };
    }

    const subscribedUserIds = await PushSubscription.distinct('userId');
    if (!subscribedUserIds.length) {
      return {
        eligibleUserCount: 0,
        deliveredUserCount: 0,
        deviceDeliveryCount: 0,
        skipped: true,
      };
    }

    const subscribedUsers = await User.find({
      _id: { $in: subscribedUserIds },
      isDeleted: { $ne: true },
      hasLogin: true,
      isLocked: { $ne: true },
    })
      .select('_id role extraPermissions deniedPermissions')
      .lean();

    const eligibleUsers = subscribedUsers.filter((user) =>
      this._canReceiveAudienceNotification(user, notification)
    );

    if (!eligibleUsers.length) {
      return {
        eligibleUserCount: 0,
        deliveredUserCount: 0,
        deviceDeliveryCount: 0,
        skipped: true,
      };
    }

    const pushPayload = await this._buildPushNotificationPayload(notification);
    const results = await Promise.allSettled(
      eligibleUsers.map((user) => pushService.sendToUser(user._id, pushPayload))
    );

    let deliveredUserCount = 0;
    let deviceDeliveryCount = 0;

    results.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        const sentCount = Number(result.value?.sentCount || 0);
        if (sentCount > 0) {
          deliveredUserCount += 1;
          deviceDeliveryCount += sentCount;
        }
        return;
      }

      logger.warn('Failed to send content notification push to subscribed user', {
        notificationId: String(notification.id || notification._id || ''),
        userId: String(eligibleUsers[index]?._id || ''),
        reason: result.reason?.message || 'Push delivery failed',
      });
    });

    return {
      eligibleUserCount: eligibleUsers.length,
      deliveredUserCount,
      deviceDeliveryCount,
      skipped: false,
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
    const mappedNotification = this._mapNotification(
      await Notification.findById(created._id)
        .populate('typeId', 'name')
        .populate('createdBy', 'fullName')
        .populate('updatedBy', 'fullName')
        .lean()
    );

    try {
      const pushSummary = await this._sendPushToAudience(mappedNotification);
      if (!pushSummary.skipped) {
        logger.info('Content notification push broadcast completed', {
          notificationId: String(mappedNotification.id || ''),
          eligibleUserCount: pushSummary.eligibleUserCount,
          deliveredUserCount: pushSummary.deliveredUserCount,
          deviceDeliveryCount: pushSummary.deviceDeliveryCount,
        });
      }
    } catch (error) {
      logger.warn('Failed to broadcast content notification push', {
        notificationId: String(mappedNotification.id || ''),
        reason: error.message,
      });
    }

    return mappedNotification;
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
