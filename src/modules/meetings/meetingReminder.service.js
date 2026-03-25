const Meeting = require('./meeting.model');
const MeetingReminderDispatch = require('./meetingReminderDispatch.model');
const User = require('../users/user.model');
const userNotificationsService = require('../notifications/userNotifications.service');
const platformSettingsService = require('../settings/platformSettings.service');
const config = require('../../config/env');
const logger = require('../../utils/logger');

class MeetingReminderService {
  constructor() {
    this.intervalHandle = null;
    this.isRunning = false;
  }

  _normalizeText(value, maxLength = 300) {
    return String(value || '').trim().slice(0, maxLength);
  }

  _normalizeLeadMinutes(value, fallback = 60) {
    const parsedValue = Number(value);
    if (!Number.isFinite(parsedValue)) {
      return fallback;
    }

    return Math.max(0, Math.min(10080, Math.round(parsedValue)));
  }

  _getMeetingWeekday(day) {
    const weekdayMap = {
      sunday: 0,
      monday: 1,
      tuesday: 2,
      wednesday: 3,
      thursday: 4,
      friday: 5,
      saturday: 6,
    };

    return weekdayMap[this._normalizeText(day).toLowerCase()] ?? null;
  }

  _parseMeetingTime(value) {
    const normalizedValue = this._normalizeText(value, 20);
    const matched = normalizedValue.match(/^([01]\d|2[0-3]):([0-5]\d)$/);
    if (!matched) return null;

    return {
      hours: Number(matched[1]),
      minutes: Number(matched[2]),
    };
  }

  _getNextOccurrenceAt(meeting, referenceDate = new Date()) {
    const weekday = this._getMeetingWeekday(meeting?.day);
    const time = this._parseMeetingTime(meeting?.time);
    if (weekday == null || !time) {
      return null;
    }

    const now = referenceDate instanceof Date ? referenceDate : new Date(referenceDate);
    if (Number.isNaN(now.getTime())) {
      return null;
    }

    const candidate = new Date(now);
    candidate.setSeconds(0, 0);
    candidate.setHours(time.hours, time.minutes, 0, 0);

    const currentWeekday = candidate.getDay();
    let daysUntilMeeting = weekday - currentWeekday;
    if (daysUntilMeeting < 0) {
      daysUntilMeeting += 7;
    }

    candidate.setDate(candidate.getDate() + daysUntilMeeting);

    if (candidate.getTime() <= now.getTime()) {
      candidate.setDate(candidate.getDate() + 7);
    }

    return candidate;
  }

  _isReminderDue({ occurrenceAt, leadMinutes, now, lookbackMs }) {
    if (!(occurrenceAt instanceof Date) || Number.isNaN(occurrenceAt.getTime())) {
      return false;
    }

    const reminderAtMs = occurrenceAt.getTime() - (leadMinutes * 60 * 1000);
    const nowMs = now.getTime();
    return reminderAtMs <= nowMs && reminderAtMs > nowMs - lookbackMs;
  }

  async _claimDispatch({ meetingId, occurrenceAt, reminderAt, reminderLeadMinutes, now }) {
    try {
      return await MeetingReminderDispatch.create({
        meetingId,
        occurrenceAt,
        reminderAt,
        reminderLeadMinutes,
        sentAt: now,
      });
    } catch (error) {
      if (error?.code === 11000) {
        return null;
      }

      throw error;
    }
  }

  async _loadRecipientIds(meetingId) {
    const users = await User.find({
      meetingIds: meetingId,
      isDeleted: { $ne: true },
      hasLogin: true,
      isLocked: { $ne: true },
    })
      .select('_id')
      .lean();

    return [...new Set(users.map((user) => String(user._id)).filter(Boolean))];
  }

  async _buildReminderPayload({ meeting, occurrenceAt, reminderLeadMinutes }) {
    const meetingName = this._normalizeText(meeting?.name, 160);
    const sectorName = this._normalizeText(meeting?.sectorId?.name || '', 160);
    const renderedTemplate = await platformSettingsService.renderMeetingReminderNotification({
      meetingName,
      meetingDay: meeting?.day || '',
      meetingTime: meeting?.time || '',
      meetingDateTime: occurrenceAt,
      sectorName,
      reminderLeadMinutes,
    }, {
      template: meeting?.reminderSettings?.template,
      reminderLeadMinutes,
    });

    return {
      type: 'meeting_reminder',
      title: renderedTemplate.title || meetingName || 'Meeting reminder',
      message: renderedTemplate.message || meetingName || 'Meeting reminder',
      link: `/dashboard/meetings/list/${String(meeting?._id || '')}`,
      metadata: {
        meetingId: String(meeting?._id || ''),
        meetingName,
        meetingDay: this._normalizeText(meeting?.day, 32),
        meetingTime: this._normalizeText(meeting?.time, 10),
        meetingDateTime: occurrenceAt ? occurrenceAt.toISOString() : null,
        occurrenceAt: occurrenceAt ? occurrenceAt.toISOString() : null,
        sectorName,
        reminderLeadMinutes,
        localizedContent: renderedTemplate.localized,
      },
    };
  }

  async _sendReminderForMeeting(meeting, { now, leadMinutes, lookbackMs }) {
    const occurrenceAt = this._getNextOccurrenceAt(meeting, now);
    if (!occurrenceAt) {
      return null;
    }

    if (!this._isReminderDue({ occurrenceAt, leadMinutes, now, lookbackMs })) {
      return null;
    }

    const reminderAt = new Date(occurrenceAt.getTime() - (leadMinutes * 60 * 1000));
    const dispatch = await this._claimDispatch({
      meetingId: meeting._id,
      occurrenceAt,
      reminderAt,
      reminderLeadMinutes: leadMinutes,
      now,
    });

    if (!dispatch) {
      return null;
    }

    try {
      const recipientIds = await this._loadRecipientIds(meeting._id);
      const payload = await this._buildReminderPayload({
        meeting,
        occurrenceAt,
        reminderLeadMinutes: leadMinutes,
      });

      const notifications = await userNotificationsService.createForUsers(
        recipientIds,
        payload,
        { createdBy: meeting?.createdBy || null }
      );

      dispatch.recipientCount = notifications.length;
      await dispatch.save();

      return dispatch;
    } catch (error) {
      await MeetingReminderDispatch.deleteOne({ _id: dispatch._id });
      throw error;
    }
  }

  async runReminderSweep(referenceDate = new Date()) {
    const now = referenceDate instanceof Date ? referenceDate : new Date(referenceDate);
    if (Number.isNaN(now.getTime())) return;

    const pollIntervalMs = Number(config.meetingReminders?.pollIntervalMs || 60 * 1000);
    const lookbackMs = Math.max(pollIntervalMs, 60 * 1000);

    const meetings = await Meeting.find({
      isDeleted: { $ne: true },
      day: { $exists: true, $ne: '' },
      time: { $exists: true, $ne: '' },
    })
      .select('_id name day time sectorId createdBy reminderSettings')
      .populate('sectorId', 'name')
      .lean();

    for (const meeting of meetings) {
      const leadMinutes = this._normalizeLeadMinutes(
        meeting?.reminderSettings?.leadMinutes,
        60
      );

      await this._sendReminderForMeeting(meeting, {
        now,
        leadMinutes,
        lookbackMs,
      });
    }
  }

  async runScheduledSweep() {
    if (this.isRunning) return;

    this.isRunning = true;
    try {
      await this.runReminderSweep();
    } catch (error) {
      logger.error(`Meeting reminder sweep failed: ${error.message}`);
    } finally {
      this.isRunning = false;
    }
  }

  start() {
    if (config.env === 'test' || this.intervalHandle) return;

    this.runScheduledSweep();
    this.intervalHandle = setInterval(
      () => this.runScheduledSweep(),
      config.meetingReminders?.pollIntervalMs || 60 * 1000
    );
  }

  stop() {
    if (!this.intervalHandle) return;

    clearInterval(this.intervalHandle);
    this.intervalHandle = null;
  }
}

module.exports = new MeetingReminderService();
