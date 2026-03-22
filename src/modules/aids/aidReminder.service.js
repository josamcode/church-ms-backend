const crypto = require('crypto');
const Aid = require('./aid.model');
const Notification = require('../notifications/notification.model');
const NotificationType = require('../notifications/notificationType.model');
const userNotificationsService = require('../notifications/userNotifications.service');
const { PERMISSIONS } = require('../../constants/permissions');
const logger = require('../../utils/logger');
const config = require('../../config/env');
const {
  getAidOccurrenceFrequency,
  getNextOccurrenceAfter,
  getNextOccurrenceOnOrAfter,
  isSameUtcDay,
  normalizeAidOccurrence,
  toUtcDate,
} = require('./aidOccurrence.utils');

const { seedDefaultNotificationTypes } = NotificationType;

const REMINDER_TYPE_NAME = 'Aid Reminder';
const REMINDER_SOURCE_TYPE = 'aid_recurring';
const REMINDER_AUDIENCE_PERMISSIONS = [PERMISSIONS.HOUSEHOLD_CLASSIFICATIONS_VIEW];

class AidReminderService {
  constructor() {
    this.intervalHandle = null;
    this.isRunning = false;
  }

  _formatDate(dateValue) {
    const date = toUtcDate(dateValue);
    return date ? date.toISOString().slice(0, 10) : '';
  }

  _buildGroupKey(group) {
    return crypto
      .createHash('sha256')
      .update(
        JSON.stringify({
          date: this._formatDate(group.date),
          category: String(group.category || '').trim(),
          occurrence: normalizeAidOccurrence(group.occurrence),
          description: String(group.description || '').trim(),
        })
      )
      .digest('hex');
  }

  _buildOccurrenceKey(groupKey, occurrenceDate) {
    return crypto
      .createHash('sha256')
      .update(`${groupKey}:${this._formatDate(occurrenceDate)}`)
      .digest('hex');
  }

  async _ensureReminderType() {
    await seedDefaultNotificationTypes();

    let type = await NotificationType.findOne({ normalizedName: REMINDER_TYPE_NAME.toLowerCase() });
    if (!type) {
      type = await NotificationType.create({
        name: REMINDER_TYPE_NAME,
        normalizedName: REMINDER_TYPE_NAME.toLowerCase(),
        isDefault: true,
        order: 4,
      });
    }

    return type;
  }

  _buildReminderPayload(group, occurrenceDate, typeId, typeName, existingNotification = null) {
    const normalizedOccurrence = normalizeAidOccurrence(group.occurrence);
    const dueDateLabel = this._formatDate(occurrenceDate);
    const nextOccurrenceDate = getNextOccurrenceAfter(occurrenceDate, normalizedOccurrence);
    const nextDueDateLabel = this._formatDate(nextOccurrenceDate);
    const beneficiaryCount = Number(group.beneficiariesCount || 0);
    const noteLine = String(group.notes || '').trim();
    const groupKey = this._buildGroupKey(group);
    const originalDateLabel = this._formatDate(group.date);
    const sourceData = {
      originalDate: originalDateLabel,
      dueDate: dueDateLabel,
      nextDueDate: nextDueDateLabel || null,
      category: String(group.category || '').trim(),
      occurrence: normalizedOccurrence,
      description: String(group.description || '').trim(),
      notes: noteLine || '',
      beneficiariesCount: beneficiaryCount,
      houseNames: Array.isArray(group.houseNames)
        ? [...new Set(group.houseNames.map((houseName) => String(houseName || '').trim()).filter(Boolean))]
        : [],
    };

    return {
      typeId,
      typeNameSnapshot: typeName,
      name: `Aid reminder: ${group.description}`,
      summary: nextDueDateLabel
        ? `${group.category} aid (${normalizedOccurrence}) is due on ${dueDateLabel}. Next repeat: ${nextDueDateLabel}.`
        : `${group.category} aid (${normalizedOccurrence}) is due on ${dueDateLabel}.`,
      details: [
        {
          kind: 'text',
          title: 'Aid reminder',
          content: [
            `Description: ${group.description}`,
            `Category: ${group.category}`,
            `Occurrence: ${normalizedOccurrence}`,
            `Original date: ${originalDateLabel}`,
            `Due date: ${dueDateLabel}`,
            nextDueDateLabel ? `Next repeat: ${nextDueDateLabel}` : null,
            beneficiaryCount > 0 ? `Beneficiaries: ${beneficiaryCount}` : null,
            noteLine ? `Notes: ${noteLine}` : null,
          ]
            .filter(Boolean)
            .join('\n'),
        },
      ],
      eventDate: occurrenceDate,
      isActive: true,
      createdBy: existingNotification?.createdBy || group.recordedBy || undefined,
      updatedBy: group.recordedBy || existingNotification?.updatedBy || existingNotification?.createdBy || undefined,
      audienceType: 'permissions',
      audiencePermissions: REMINDER_AUDIENCE_PERMISSIONS,
      sourceType: REMINDER_SOURCE_TYPE,
      sourceGroupKey: groupKey,
      sourceKey: this._buildOccurrenceKey(groupKey, occurrenceDate),
      sourceData,
    };
  }

  async syncDueReminderForGroup(group, targetDateValue = new Date()) {
    const frequency = getAidOccurrenceFrequency(group?.occurrence);
    if (!frequency) return null;

    const targetDate = toUtcDate(targetDateValue);
    const baseDate = toUtcDate(group?.date);
    if (!targetDate || !baseDate || targetDate <= baseDate) return null;

    const nextOccurrenceDate = getNextOccurrenceOnOrAfter(group.date, group.occurrence, targetDate);
    if (!nextOccurrenceDate || !isSameUtcDay(nextOccurrenceDate, targetDate)) return null;

    const type = await this._ensureReminderType();
    const groupKey = this._buildGroupKey(group);
    const sourceKey = this._buildOccurrenceKey(groupKey, nextOccurrenceDate);
    const existing = await Notification.findOne({ sourceType: REMINDER_SOURCE_TYPE, sourceKey });

    if (existing) {
      const alreadyApproved = await Aid.exists({ reminderNotificationId: existing._id });
      if (alreadyApproved) {
        return existing;
      }
    }

    const payload = this._buildReminderPayload(group, nextOccurrenceDate, type._id, type.name, existing);

    if (!existing) {
      const created = await Notification.create(payload);
      await userNotificationsService.notifyUsersWithAnyPermissions(
        REMINDER_AUDIENCE_PERMISSIONS,
        {
          type: 'aid_reminder',
          title: 'Aid reminder due',
          message: `${group.description} is due on ${payload.sourceData?.dueDate || this._formatDate(nextOccurrenceDate)}.`,
          link: '/dashboard/lords-brethren/aid-history/notifications',
          metadata: {
            reminderNotificationId: String(created._id),
            sourceType: REMINDER_SOURCE_TYPE,
            dueDate: payload.sourceData?.dueDate || null,
            nextDueDate: payload.sourceData?.nextDueDate || null,
            category: String(group.category || '').trim(),
            occurrence: payload.sourceData?.occurrence || normalizeAidOccurrence(group.occurrence),
            description: String(group.description || '').trim(),
          },
        },
        {
          createdBy: group.recordedBy || null,
        }
      );
      return created;
    }

    existing.typeId = payload.typeId;
    existing.typeNameSnapshot = payload.typeNameSnapshot;
    existing.name = payload.name;
    existing.summary = payload.summary;
    existing.details = payload.details;
    existing.eventDate = payload.eventDate;
    existing.isActive = payload.isActive;
    existing.updatedBy = payload.updatedBy;
    existing.audienceType = payload.audienceType;
    existing.audiencePermissions = payload.audiencePermissions;
    existing.sourceGroupKey = payload.sourceGroupKey;
    existing.sourceData = payload.sourceData;
    await existing.save();
    return existing;
  }

  async deleteRemindersForGroup(group) {
    const frequency = getAidOccurrenceFrequency(group?.occurrence);
    if (!frequency) return;

    const sourceGroupKey = this._buildGroupKey(group);
    await Notification.deleteMany({
      sourceType: REMINDER_SOURCE_TYPE,
      sourceGroupKey,
    });
  }

  async runDueReminderSweep(targetDateValue = new Date()) {
    const targetDate = toUtcDate(targetDateValue);
    if (!targetDate) return;

    const groupedAids = await Aid.aggregate([
      {
        $match: {
          $or: [
            { isRecurringSource: { $exists: false } },
            { isRecurringSource: true },
          ],
        },
      },
      {
        $group: {
          _id: {
            date: '$date',
            category: '$category',
            occurrence: '$occurrence',
            description: '$description',
          },
          notes: { $first: '$notes' },
          recordedBy: { $first: '$recordedBy' },
          beneficiariesCount: { $sum: 1 },
          houseNames: { $addToSet: '$houseName' },
        },
      },
    ]);

    for (const entry of groupedAids) {
      const group = {
        date: entry?._id?.date,
        category: entry?._id?.category,
        occurrence: entry?._id?.occurrence,
        description: entry?._id?.description,
        notes: entry?.notes,
        recordedBy: entry?.recordedBy,
        beneficiariesCount: entry?.beneficiariesCount,
        houseNames: entry?.houseNames,
      };

      if (!getAidOccurrenceFrequency(group.occurrence)) continue;
      await this.syncDueReminderForGroup(group, targetDate);
    }
  }

  async runScheduledSweep() {
    if (this.isRunning) return;

    this.isRunning = true;
    try {
      await this.runDueReminderSweep();
    } catch (error) {
      logger.error(`Aid reminder sweep failed: ${error.message}`);
    } finally {
      this.isRunning = false;
    }
  }

  start() {
    if (config.env === 'test' || this.intervalHandle) return;

    this.runScheduledSweep();
    this.intervalHandle = setInterval(
      () => this.runScheduledSweep(),
      config.aidReminders?.pollIntervalMs || 60 * 60 * 1000
    );
  }

  stop() {
    if (!this.intervalHandle) return;

    clearInterval(this.intervalHandle);
    this.intervalHandle = null;
  }
}

module.exports = new AidReminderService();
