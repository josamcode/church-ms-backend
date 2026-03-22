const webPush = require('web-push');
const config = require('../../config/env');
const ApiError = require('../../utils/ApiError');
const logger = require('../../utils/logger');
const PushSubscription = require('./pushSubscription.model');
const User = require('../users/user.model');

const INVALID_PUSH_STATUS_CODES = new Set([404, 410]);

class PushService {
  constructor() {
    if (config.push.enabled) {
      webPush.setVapidDetails(
        config.push.vapidSubject,
        config.push.vapidPublicKey,
        config.push.vapidPrivateKey
      );
    }
  }

  isEnabled() {
    return config.push.enabled;
  }

  getPublicKey() {
    if (!this.isEnabled()) {
      throw ApiError.serviceUnavailable(
        'Web push notifications are not configured on this server.',
        'PUSH_NOT_CONFIGURED'
      );
    }

    return config.push.vapidPublicKey;
  }

  _mapSubscription(subscription) {
    return {
      id: subscription._id ? String(subscription._id) : null,
      userId: subscription.userId ? String(subscription.userId) : null,
      endpoint: subscription.endpoint || '',
      createdAt: subscription.createdAt || null,
      updatedAt: subscription.updatedAt || null,
    };
  }

  _buildWebPushPayload(notification) {
    return {
      title: notification.title,
      body: notification.message,
      icon: '/logo192.png',
      badge: '/logo192.png',
      link: notification.link || '/dashboard/notifications/inbox',
      tag: `user-notification:${notification.id}`,
      data: {
        notificationId: notification.id,
        type: notification.type,
        link: notification.link || '/dashboard/notifications/inbox',
      },
    };
  }

  _buildWebPushSubscription(subscription) {
    return {
      endpoint: subscription.endpoint,
      expirationTime: subscription.expirationTime
        ? new Date(subscription.expirationTime).getTime()
        : null,
      keys: {
        p256dh: subscription.keys?.p256dh,
        auth: subscription.keys?.auth,
      },
    };
  }

  _buildDeliveryOptions(notification) {
    const normalizedType = String(notification?.type || '').trim().toLowerCase();
    const isHighPriority = ['chat_message', 'admin', 'backup_failure'].includes(normalizedType);

    return {
      // Keep notifications deliverable even if the browser is sleeping or briefly offline.
      TTL: isHighPriority ? 60 * 60 : 6 * 60 * 60,
      urgency: isHighPriority ? 'high' : 'normal',
      topic: notification?.id ? `user-notification-${notification.id}` : undefined,
    };
  }

  async upsertSubscription({ userId, subscription, userAgent = '' }) {
    if (!this.isEnabled()) {
      throw ApiError.serviceUnavailable(
        'Web push notifications are not configured on this server.',
        'PUSH_NOT_CONFIGURED'
      );
    }

    const endpoint = String(subscription?.endpoint || '').trim();
    if (!endpoint) {
      throw ApiError.badRequest('Push subscription endpoint is required', 'VALIDATION_ERROR');
    }

    const persisted = await PushSubscription.findOneAndUpdate(
      { endpoint },
      {
        $set: {
          userId,
          endpoint,
          keys: {
            p256dh: String(subscription?.keys?.p256dh || '').trim(),
            auth: String(subscription?.keys?.auth || '').trim(),
          },
          expirationTime: subscription?.expirationTime
            ? new Date(subscription.expirationTime)
            : null,
          userAgent: String(userAgent || '').trim().slice(0, 500),
        },
        $setOnInsert: {
          lastUsedAt: null,
        },
      },
      {
        new: true,
        upsert: true,
        setDefaultsOnInsert: true,
      }
    );

    return this._mapSubscription(persisted);
  }

  async removeSubscription({ userId, endpoint }) {
    const normalizedEndpoint = String(endpoint || '').trim();
    if (!normalizedEndpoint) {
      throw ApiError.badRequest('Push subscription endpoint is required', 'VALIDATION_ERROR');
    }

    const result = await PushSubscription.deleteOne({
      userId,
      endpoint: normalizedEndpoint,
    });

    return {
      removed: result.deletedCount > 0,
    };
  }

  async _removeInvalidSubscription(subscription, reason) {
    await PushSubscription.deleteOne({ _id: subscription._id });
    logger.warn('Removed invalid push subscription', {
      endpoint: subscription.endpoint,
      userId: subscription.userId ? String(subscription.userId) : null,
      reason,
    });
  }

  async sendToUser(userId, notification) {
    if (!this.isEnabled() || !userId || !notification) {
      return { sentCount: 0, failedCount: 0, skipped: true };
    }

    const user = await User.findById(userId)
      .select('hasLogin isLocked isDeleted')
      .lean();

    if (!user || user.isDeleted || user.hasLogin !== true || user.isLocked === true) {
      return { sentCount: 0, failedCount: 0, skipped: true };
    }

    const subscriptions = await PushSubscription.find({ userId }).lean();
    if (!subscriptions.length) {
      return { sentCount: 0, failedCount: 0, skipped: true };
    }

    const payload = JSON.stringify(this._buildWebPushPayload(notification));
    const results = await Promise.allSettled(
      subscriptions.map((subscription) =>
        webPush.sendNotification(
          this._buildWebPushSubscription(subscription),
          payload,
          this._buildDeliveryOptions(notification)
        )
      )
    );

    let sentCount = 0;
    let failedCount = 0;

    for (let index = 0; index < results.length; index += 1) {
      const result = results[index];
      const subscription = subscriptions[index];

      if (result.status === 'fulfilled') {
        sentCount += 1;
        await PushSubscription.updateOne(
          { _id: subscription._id },
          { $set: { lastUsedAt: new Date() } }
        );
        continue;
      }

      failedCount += 1;
      const statusCode = result.reason?.statusCode;
      const reason = result.reason?.body || result.reason?.message || 'Push delivery failed';

      if (INVALID_PUSH_STATUS_CODES.has(Number(statusCode || 0))) {
        await this._removeInvalidSubscription(subscription, reason);
        continue;
      }

      logger.warn('Push notification delivery failed', {
        endpoint: subscription.endpoint,
        userId: String(userId),
        statusCode,
        reason,
      });
    }

    return {
      sentCount,
      failedCount,
      skipped: false,
    };
  }
}

module.exports = new PushService();
