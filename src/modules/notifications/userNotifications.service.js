const mongoose = require('mongoose');
const ApiError = require('../../utils/ApiError');
const { buildPaginationMeta } = require('../../utils/pagination');
const logger = require('../../utils/logger');
const { getEffectivePermissions } = require('../../constants/permissions');
const User = require('../users/user.model');
const { emitToUsers } = require('../chats/chat.realtime');
const UserNotification = require('./userNotification.model');
const pushService = require('./push.service');

class UserNotificationsService {
  _toObjectId(id, fieldName = 'id') {
    if (!mongoose.Types.ObjectId.isValid(id)) {
      throw ApiError.badRequest(`Invalid ${fieldName}`, 'VALIDATION_ERROR');
    }

    return new mongoose.Types.ObjectId(id);
  }

  _normalizeId(value) {
    if (!value) return null;
    if (typeof value === 'string') return value;
    if (value instanceof mongoose.Types.ObjectId) return value.toString();
    if (typeof value === 'object' && value._id) return String(value._id);
    return String(value);
  }

  _normalizeIdArray(values = []) {
    return [...new Set(
      (Array.isArray(values) ? values : [])
        .filter(Boolean)
        .map((value) => this._normalizeId(value))
        .filter(Boolean)
    )];
  }

  _normalizeType(type) {
    const normalized = String(type || '').trim().toLowerCase();
    if (!/^[a-z0-9_:-]{2,80}$/.test(normalized)) {
      throw ApiError.badRequest(
        'Notification type must contain only lowercase letters, numbers, underscores, hyphens, or colons.',
        'VALIDATION_ERROR'
      );
    }

    return normalized;
  }

  _normalizeLink(link) {
    const normalized = String(link || '').trim();
    if (!normalized) return '';

    if (normalized.startsWith('/')) {
      return normalized;
    }

    let parsed;
    try {
      parsed = new URL(normalized);
    } catch (_error) {
      throw ApiError.badRequest('Notification link must be a valid URL or app path', 'VALIDATION_ERROR');
    }

    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw ApiError.badRequest(
        'Notification link protocol must be http, https, or a relative app path',
        'VALIDATION_ERROR'
      );
    }

    return parsed.toString();
  }

  _normalizeMetadata(metadata) {
    if (metadata === undefined || metadata === null) {
      return null;
    }

    let serialized;
    try {
      serialized = JSON.stringify(metadata);
    } catch (_error) {
      throw ApiError.badRequest('Notification metadata must be JSON-serializable', 'VALIDATION_ERROR');
    }

    if (serialized.length > 10000) {
      throw ApiError.badRequest(
        'Notification metadata is too large. Keep it under 10KB.',
        'VALIDATION_ERROR'
      );
    }

    return JSON.parse(serialized);
  }

  _normalizePayload(payload = {}) {
    const title = String(payload.title || '').trim();
    const message = String(payload.message || '').trim();

    if (!title) {
      throw ApiError.badRequest('Notification title is required', 'VALIDATION_ERROR');
    }

    if (!message) {
      throw ApiError.badRequest('Notification message is required', 'VALIDATION_ERROR');
    }

    return {
      type: this._normalizeType(payload.type || 'system'),
      title: title.slice(0, 160),
      message: message.slice(0, 2000),
      link: this._normalizeLink(payload.link),
      metadata: this._normalizeMetadata(payload.metadata),
    };
  }

  _mapNotification(notification) {
    return {
      id: this._normalizeId(notification._id || notification.id),
      userId: this._normalizeId(notification.userId),
      type: notification.type || 'system',
      title: notification.title || '',
      message: notification.message || '',
      link: notification.link || '',
      isRead: notification.isRead === true,
      readAt: notification.readAt || null,
      metadata: notification.metadata || null,
      createdAt: notification.createdAt || null,
      updatedAt: notification.updatedAt || null,
    };
  }

  async _computeUnreadCount(userId) {
    return UserNotification.countDocuments({
      userId: this._toObjectId(userId, 'userId'),
      isRead: false,
    });
  }

  _emitCreated(notification) {
    emitToUsers([notification.userId], 'notification:new', {
      notification,
    });
  }

  async _emitRead(notificationId, userId) {
    const unreadCount = await this._computeUnreadCount(userId);
    emitToUsers([userId], 'notification:read', {
      notificationId: String(notificationId),
      unreadCount,
    });
    return unreadCount;
  }

  async _emitReadAll(userId) {
    emitToUsers([userId], 'notification:read-all', {
      unreadCount: 0,
    });
  }

  async listNotifications({ userId, cursor, limit = 20 }) {
    const query = {
      userId: this._toObjectId(userId, 'userId'),
    };

    if (cursor) {
      const cursorDate = new Date(cursor);
      if (!Number.isNaN(cursorDate.getTime())) {
        query.createdAt = { $lt: cursorDate };
      }
    }

    const notifications = await UserNotification.find(query)
      .sort({ createdAt: -1, _id: -1 })
      .limit(limit)
      .lean();

    return {
      notifications: notifications.map((notification) => this._mapNotification(notification)),
      meta: buildPaginationMeta(notifications, limit, 'createdAt'),
    };
  }

  async getUnreadCount(userId) {
    return {
      unreadCount: await this._computeUnreadCount(userId),
    };
  }

  async markAsRead(notificationId, userId) {
    const notification = await UserNotification.findOne({
      _id: this._toObjectId(notificationId, 'notificationId'),
      userId: this._toObjectId(userId, 'userId'),
    });

    if (!notification) {
      throw ApiError.notFound('Notification not found', 'RESOURCE_NOT_FOUND');
    }

    if (!notification.isRead) {
      notification.isRead = true;
      notification.readAt = new Date();
      await notification.save();
    }

    const unreadCount = await this._emitRead(notification._id, userId);

    return {
      notification: this._mapNotification(notification),
      unreadCount,
    };
  }

  async markAllAsRead(userId) {
    const now = new Date();
    const result = await UserNotification.updateMany(
      {
        userId: this._toObjectId(userId, 'userId'),
        isRead: false,
      },
      {
        $set: {
          isRead: true,
          readAt: now,
        },
      }
    );

    await this._emitReadAll(userId);

    return {
      updatedCount: Number(result.modifiedCount || 0),
      unreadCount: 0,
    };
  }

  async _loadDeliverableUsersByIds(userIds = []) {
    const normalizedUserIds = this._normalizeIdArray(userIds);
    if (!normalizedUserIds.length) {
      return [];
    }

    const users = await User.find({
      _id: { $in: normalizedUserIds.map((userId) => this._toObjectId(userId, 'userId')) },
      isDeleted: { $ne: true },
    })
      .select('_id fullName hasLogin')
      .lean();

    if (users.length !== normalizedUserIds.length) {
      throw ApiError.notFound('One or more target users were not found', 'USER_NOT_FOUND');
    }

    const usersWithoutLogin = users.filter((user) => user.hasLogin !== true);
    if (usersWithoutLogin.length > 0) {
      throw ApiError.badRequest(
        'All target users must have login access enabled to receive in-app notifications.',
        'VALIDATION_ERROR'
      );
    }

    return normalizedUserIds.map((userId) =>
      users.find((user) => this._normalizeId(user._id) === userId)
    );
  }

  async _loadUsersByPermissions(requiredPermissions = [], { matchMode = 'any' } = {}) {
    const normalizedPermissions = [...new Set(
      (Array.isArray(requiredPermissions) ? requiredPermissions : [])
        .map((permission) => String(permission || '').trim())
        .filter(Boolean)
    )];

    if (!normalizedPermissions.length) {
      return [];
    }

    const users = await User.find({
      isDeleted: { $ne: true },
      hasLogin: true,
    })
      .select('_id fullName role extraPermissions deniedPermissions')
      .lean();

    return users.filter((user) => {
      const effectivePermissions = getEffectivePermissions(
        user.role,
        user.extraPermissions || [],
        user.deniedPermissions || []
      );

      return matchMode === 'all'
        ? normalizedPermissions.every((permission) => effectivePermissions.includes(permission))
        : normalizedPermissions.some((permission) => effectivePermissions.includes(permission));
    });
  }

  async _resolveRecipients({
    userIds = [],
    targetPermissions = [],
    broadcastToAll = false,
    throwIfEmpty = true,
  } = {}) {
    const explicitUsers = await this._loadDeliverableUsersByIds(userIds);
    const permissionUsers = await this._loadUsersByPermissions(targetPermissions, { matchMode: 'any' });
    const broadcastUsers = broadcastToAll
      ? await User.find({
          isDeleted: { $ne: true },
          hasLogin: true,
        })
          .select('_id fullName')
          .lean()
      : [];

    const recipients = [];
    const seen = new Set();

    [...explicitUsers, ...permissionUsers, ...broadcastUsers].forEach((user) => {
      const userId = this._normalizeId(user._id);
      if (!userId || seen.has(userId)) {
        return;
      }

      seen.add(userId);
      recipients.push({
        id: userId,
        fullName: user.fullName || '',
      });
    });

    if (throwIfEmpty && recipients.length === 0) {
      throw ApiError.badRequest(
        'No users matched the selected notification audience.',
        'VALIDATION_ERROR'
      );
    }

    return recipients;
  }

  async createForUsers(userIds = [], payload = {}, { createdBy = null } = {}) {
    const normalizedUserIds = this._normalizeIdArray(userIds);
    if (!normalizedUserIds.length) {
      return [];
    }

    const normalizedPayload = this._normalizePayload(payload);
    const documents = await UserNotification.insertMany(
      normalizedUserIds.map((userId) => ({
        userId: this._toObjectId(userId, 'userId'),
        type: normalizedPayload.type,
        title: normalizedPayload.title,
        message: normalizedPayload.message,
        link: normalizedPayload.link || undefined,
        metadata: normalizedPayload.metadata,
        createdBy: createdBy ? this._toObjectId(createdBy, 'createdBy') : null,
      }))
    );

    const notifications = documents.map((document) => this._mapNotification(document));

    notifications.forEach((notification) => {
      this._emitCreated(notification);
      pushService.sendToUser(notification.userId, notification).catch((error) => {
        logger.warn('Push delivery failed after notification creation', {
          notificationId: notification.id,
          userId: notification.userId,
          reason: error.message,
        });
      });
    });

    return notifications;
  }

  async sendSystemNotification({
    actorUserId,
    type = 'admin',
    title,
    message,
    link,
    metadata,
    userIds = [],
    targetPermissions = [],
    broadcastToAll = false,
  }) {
    const recipients = await this._resolveRecipients({
      userIds,
      targetPermissions,
      broadcastToAll,
      throwIfEmpty: true,
    });

    await this.createForUsers(
      recipients.map((recipient) => recipient.id),
      {
        type,
        title,
        message,
        link,
        metadata,
      },
      { createdBy: actorUserId }
    );

    return {
      recipientCount: recipients.length,
      recipients: recipients.slice(0, 10),
    };
  }

  async notifyUsersWithAnyPermissions(
    permissions = [],
    payload = {},
    { createdBy = null } = {}
  ) {
    const recipients = await this._resolveRecipients({
      targetPermissions: permissions,
      throwIfEmpty: false,
    });

    if (!recipients.length) {
      return {
        recipientCount: 0,
      };
    }

    await this.createForUsers(
      recipients.map((recipient) => recipient.id),
      payload,
      { createdBy }
    );

    return {
      recipientCount: recipients.length,
    };
  }

  async notifyUser(userId, payload = {}, { createdBy = null } = {}) {
    const recipients = await this._resolveRecipients({
      userIds: [userId],
      throwIfEmpty: true,
    });

    const notifications = await this.createForUsers(
      recipients.map((recipient) => recipient.id),
      payload,
      { createdBy }
    );

    return notifications[0] || null;
  }
}

module.exports = new UserNotificationsService();
