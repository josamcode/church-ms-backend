const mongoose = require('mongoose');
const {
  PlatformSettings,
  PLATFORM_SETTINGS_DOCUMENT_KEY,
} = require('./platformSettings.model');

const DEFAULT_NOTIFICATION_TEMPLATES = Object.freeze({
  confessionNextSession: {
    title: {
      ar: 'موعد جلسة الاعتراف القادمة',
      en: 'موعد جلسة الاعتراف القادمة',
    },
    message: {
      ar: 'تم تحديد موعد جلسة الاعتراف القادمة بتاريخ {nextSessionAt}.',
      en: 'تم تحديد موعد جلسة الاعتراف القادمة بتاريخ {nextSessionAt}.',
    },
  },
  meetingReminder: {
    title: {
      ar: 'تذكير بموعد الاجتماع',
      en: 'تذكير بموعد الاجتماع',
    },
    message: {
      ar: 'سيتبقى {reminderLeadTime} على اجتماع {meetingName} يوم {meetingDay} في {meetingDateTime}.',
      en: 'سيتبقى {reminderLeadTime} على اجتماع {meetingName} يوم {meetingDay} في {meetingDateTime}.',
    },
  },
  dashboardNotificationPublished: {
    title: {
      ar: 'إشعار جديد',
      en: 'إشعار جديد',
    },
    message: {
      ar: 'تم نشر إشعار جديد بعنوان {notificationName}.',
      en: 'تم نشر إشعار جديد بعنوان {notificationName}.',
    },
  },
  divineLiturgyExceptionalCase: {
    title: {
      ar: 'قداس استثنائي جديد',
      en: 'قداس استثنائي جديد',
    },
    message: {
      ar: 'تمت إضافة حالة قداس استثنائية بتاريخ {exceptionDate} في {startTime}.',
      en: 'تمت إضافة حالة قداس استثنائية بتاريخ {exceptionDate} في {startTime}.',
    },
  },
});

const DEFAULT_TEMPLATE_TOKENS = Object.freeze({
  confessionNextSession: [
    {
      key: 'nextSessionAt',
      token: '{nextSessionAt}',
      label: {
        ar: 'تاريخ ووقت الجلسة القادمة',
        en: 'Next session date/time',
      },
      sampleValue: {
        ar: '8 أبريل 2026، 6:30 م',
        en: 'Apr 8, 2026, 6:30 PM',
      },
    },
    {
      key: 'creatorName',
      token: '{creatorName}',
      label: {
        ar: 'اسم منشئ الجلسة',
        en: 'Creator name',
      },
      sampleValue: {
        ar: 'أبونا يوحنا',
        en: 'Fr. Youhanna',
      },
    },
    {
      key: 'sessionTypeName',
      token: '{sessionTypeName}',
      label: {
        ar: 'نوع الجلسة',
        en: 'Session type',
      },
      sampleValue: {
        ar: 'جلسة اعتراف',
        en: 'Confession session',
      },
    },
  ],
  meetingReminder: [
    {
      key: 'meetingName',
      token: '{meetingName}',
      label: {
        ar: 'اسم الاجتماع',
        en: 'Meeting name',
      },
      sampleValue: {
        ar: 'اجتماع الشباب',
        en: 'Youth Meeting',
      },
    },
    {
      key: 'meetingDay',
      token: '{meetingDay}',
      label: {
        ar: 'يوم الاجتماع',
        en: 'Meeting day',
      },
      sampleValue: {
        ar: 'الأحد',
        en: 'Sunday',
      },
    },
    {
      key: 'meetingTime',
      token: '{meetingTime}',
      label: {
        ar: 'وقت الاجتماع',
        en: 'Meeting time',
      },
      sampleValue: {
        ar: '6:30 م',
        en: '6:30 PM',
      },
    },
    {
      key: 'meetingDateTime',
      token: '{meetingDateTime}',
      label: {
        ar: 'تاريخ ووقت الاجتماع',
        en: 'Meeting date/time',
      },
      sampleValue: {
        ar: '10 أبريل 2026، 6:30 م',
        en: 'Apr 10, 2026, 6:30 PM',
      },
    },
    {
      key: 'sectorName',
      token: '{sectorName}',
      label: {
        ar: 'اسم القطاع',
        en: 'Sector name',
      },
      sampleValue: {
        ar: 'قطاع الشباب',
        en: 'Youth Sector',
      },
    },
    {
      key: 'reminderLeadTime',
      token: '{reminderLeadTime}',
      label: {
        ar: 'المدة قبل الاجتماع',
        en: 'Reminder lead time',
      },
      sampleValue: {
        ar: 'ساعة واحدة',
        en: '1 hour',
      },
    },
  ],
  dashboardNotificationPublished: [
    {
      key: 'notificationName',
      token: '{notificationName}',
      label: {
        ar: 'عنوان الإشعار',
        en: 'Notification title',
      },
      sampleValue: {
        ar: 'رحلة مدارس الأحد',
        en: 'Sunday School Trip',
      },
    },
    {
      key: 'notificationSummary',
      token: '{notificationSummary}',
      label: {
        ar: 'ملخص الإشعار',
        en: 'Notification summary',
      },
      sampleValue: {
        ar: 'يرجى مراجعة التفاصيل الجديدة داخل لوحة التحكم.',
        en: 'Please review the new details in the dashboard.',
      },
    },
    {
      key: 'notificationTypeName',
      token: '{notificationTypeName}',
      label: {
        ar: 'نوع الإشعار',
        en: 'Notification type',
      },
      sampleValue: {
        ar: 'إعلان عام',
        en: 'General announcement',
      },
    },
    {
      key: 'eventDate',
      token: '{eventDate}',
      label: {
        ar: 'تاريخ ووقت الحدث',
        en: 'Event date/time',
      },
      sampleValue: {
        ar: '10 أبريل 2026، 7:00 م',
        en: 'Apr 10, 2026, 7:00 PM',
      },
    },
  ],
  divineLiturgyExceptionalCase: [
    {
      key: 'exceptionName',
      token: '{exceptionName}',
      label: {
        ar: 'اسم الحالة الاستثنائية',
        en: 'Exceptional case name',
      },
      sampleValue: {
        ar: 'قداس عيد البشارة',
        en: 'Annunciation Feast Liturgy',
      },
    },
    {
      key: 'exceptionDate',
      token: '{exceptionDate}',
      label: {
        ar: 'تاريخ القداس',
        en: 'Liturgy date',
      },
      sampleValue: {
        ar: '10 أبريل 2026',
        en: 'Apr 10, 2026',
      },
    },
    {
      key: 'startTime',
      token: '{startTime}',
      label: {
        ar: 'وقت البداية',
        en: 'Start time',
      },
      sampleValue: {
        ar: '7:00 م',
        en: '7:00 PM',
      },
    },
    {
      key: 'endTime',
      token: '{endTime}',
      label: {
        ar: 'وقت النهاية',
        en: 'End time',
      },
      sampleValue: {
        ar: '9:00 م',
        en: '9:00 PM',
      },
    },
  ],
});

class PlatformSettingsService {
  _normalizeText(value, maxLength = 2000) {
    if (typeof value !== 'string') return '';
    return value.trim().slice(0, maxLength);
  }

  _normalizeLocalizedText(value = {}, maxLength = 2000) {
    const ar = this._normalizeText(value?.ar, maxLength);
    const en = this._normalizeText(value?.en, maxLength) || ar;

    return {
      ar,
      en,
    };
  }

  _normalizeNotificationTemplates(value = {}) {
    return Object.entries(DEFAULT_NOTIFICATION_TEMPLATES).reduce(
      (accumulator, [templateKey, templateDefaults]) => ({
        ...accumulator,
        [templateKey]: this._normalizeNotificationTemplateEntry(
          value?.[templateKey],
          templateDefaults
        ),
      }),
      {}
    );
  }

  _normalizeNotificationTemplateEntry(value = {}, templateDefaults = {}) {
    return {
      title: this._normalizeLocalizedText(
        value?.title || templateDefaults.title,
        160
      ),
      message: this._normalizeLocalizedText(
        value?.message || templateDefaults.message,
        2000
      ),
    };
  }

  _normalizeLeadMinutes(value, fallback = 60) {
    const parsedValue = Number(value);
    if (!Number.isFinite(parsedValue)) {
      return fallback;
    }

    return Math.max(0, Math.min(10080, Math.round(parsedValue)));
  }

  _normalizeRegistrationEnabled(value, fallback = true) {
    return typeof value === 'boolean' ? value : fallback;
  }

  normalizeMeetingReminderLeadMinutes(value, fallback = 60) {
    return this._normalizeLeadMinutes(value, fallback);
  }

  normalizeMeetingReminderTemplate(value = {}) {
    return this._normalizeNotificationTemplateEntry(
      value,
      DEFAULT_NOTIFICATION_TEMPLATES.meetingReminder
    );
  }

  _cloneAvailableTokens() {
    return Object.entries(DEFAULT_TEMPLATE_TOKENS).reduce(
      (accumulator, [templateKey, tokenList]) => ({
        ...accumulator,
        [templateKey]: tokenList.map((tokenEntry) => ({
          ...tokenEntry,
          label: { ...tokenEntry.label },
          sampleValue: { ...tokenEntry.sampleValue },
        })),
      }),
      {}
    );
  }

  _buildPayload(document = null) {
    return {
      notificationTemplates: this._normalizeNotificationTemplates(document?.notificationTemplates),
      meetingReminderLeadMinutes: this._normalizeLeadMinutes(document?.meetingReminderLeadMinutes, 60),
      registrationEnabled: this._normalizeRegistrationEnabled(document?.registrationEnabled, true),
      availableTokens: this._cloneAvailableTokens(),
      createdAt: document?.createdAt || null,
      updatedAt: document?.updatedAt || null,
    };
  }

  async _loadDocument() {
    return PlatformSettings.findOne({ key: PLATFORM_SETTINGS_DOCUMENT_KEY }).lean();
  }

  async _ensureDocument() {
    let document = await PlatformSettings.findOne({ key: PLATFORM_SETTINGS_DOCUMENT_KEY });
    if (!document) {
      document = await PlatformSettings.create({ key: PLATFORM_SETTINGS_DOCUMENT_KEY });
    }
    return document;
  }

  _toObjectId(id, fieldName = 'id') {
    if (!mongoose.Types.ObjectId.isValid(id)) {
      throw new Error(`Invalid ${fieldName}`);
    }
    return new mongoose.Types.ObjectId(id);
  }

  async getManageSettings() {
    const document = await this._loadDocument();
    return this._buildPayload(document);
  }

  async isRegistrationEnabled() {
    const document = await this._loadDocument();
    return this._normalizeRegistrationEnabled(document?.registrationEnabled, true);
  }

  async updateManageSettings(payload = {}, actorUserId) {
    const document = await this._ensureDocument();

    document.notificationTemplates = this._normalizeNotificationTemplates(payload.notificationTemplates);
    document.meetingReminderLeadMinutes = this._normalizeLeadMinutes(
      payload.meetingReminderLeadMinutes,
      document.meetingReminderLeadMinutes
    );
    document.registrationEnabled = this._normalizeRegistrationEnabled(
      payload.registrationEnabled,
      document.registrationEnabled
    );
    document.updatedBy = this._toObjectId(actorUserId, 'actorUserId');

    if (!document.createdBy) {
      document.createdBy = this._toObjectId(actorUserId, 'actorUserId');
    }

    await document.save();

    return this.getManageSettings();
  }

  _renderTemplate(template, context = {}) {
    return String(template || '').replace(/\{([^{}]+)\}/g, (_match, rawToken) => {
      const token = String(rawToken || '').trim();
      if (!token) return '';

      const resolved = context[token];
      return resolved == null ? '' : String(resolved);
    });
  }

  _formatDateTime(value, language = 'ar') {
    if (!value) return '';

    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) {
      return '';
    }

    return new Intl.DateTimeFormat(language === 'ar' ? 'ar-EG' : 'en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    }).format(date);
  }

  _formatDate(value, language = 'ar') {
    if (!value) return '';

    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) {
      return '';
    }

    return new Intl.DateTimeFormat(language === 'ar' ? 'ar-EG' : 'en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    }).format(date);
  }

  _formatTime(value, language = 'ar') {
    const normalized = this._normalizeText(value, 20);
    const match = normalized.match(/^([01]\d|2[0-3]):([0-5]\d)$/);
    if (!match) {
      return normalized;
    }

    const hours = Number(match[1]);
    const minutes = Number(match[2]);
    const date = new Date(Date.UTC(1970, 0, 1, hours, minutes));

    return new Intl.DateTimeFormat(language === 'ar' ? 'ar-EG' : 'en-US', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
      timeZone: 'UTC',
    }).format(date);
  }

  _formatWeekday(value, language = 'ar') {
    const normalizedValue = this._normalizeText(value, 40);
    if (!normalizedValue) return '';

    const localizedWeekdays = {
      Sunday: { ar: 'الأحد', en: 'Sunday' },
      Monday: { ar: 'الاثنين', en: 'Monday' },
      Tuesday: { ar: 'الثلاثاء', en: 'Tuesday' },
      Wednesday: { ar: 'الأربعاء', en: 'Wednesday' },
      Thursday: { ar: 'الخميس', en: 'Thursday' },
      Friday: { ar: 'الجمعة', en: 'Friday' },
      Saturday: { ar: 'السبت', en: 'Saturday' },
    };

    return localizedWeekdays[normalizedValue]?.[language] || normalizedValue;
  }

  _formatLeadTime(value, language = 'ar') {
    const minutes = this._normalizeLeadMinutes(value, 60);
    if (minutes === 0) {
      return language === 'ar' ? 'الآن' : 'now';
    }

    if (minutes % 1440 === 0) {
      const days = minutes / 1440;
      return language === 'ar'
        ? `${days} ${days === 1 ? 'يوم' : 'أيام'}`
        : `${days} day${days === 1 ? '' : 's'}`;
    }

    if (minutes % 60 === 0) {
      const hours = minutes / 60;
      return language === 'ar'
        ? `${hours} ${hours === 1 ? 'ساعة' : 'ساعات'}`
        : `${hours} hour${hours === 1 ? '' : 's'}`;
    }

    return language === 'ar'
      ? `${minutes} دقيقة`
      : `${minutes} minute${minutes === 1 ? '' : 's'}`;
  }

  _renderLocalizedTemplate(template = {}, contexts = {}) {
    const localized = {
      title: {
        ar: this._renderTemplate(template?.title?.ar, contexts.ar),
        en: this._renderTemplate(template?.title?.en, contexts.en),
      },
      message: {
        ar: this._renderTemplate(template?.message?.ar, contexts.ar),
        en: this._renderTemplate(template?.message?.en, contexts.en),
      },
    };

    return {
      title: localized.title.ar || localized.title.en || '',
      message: localized.message.ar || localized.message.en || '',
      localized,
    };
  }

  async renderConfessionNextSessionNotification(context = {}) {
    const settings = await this.getManageSettings();
    const template = settings.notificationTemplates.confessionNextSession;

    return this._renderLocalizedTemplate(template, {
      ar: {
        creatorName: context.creatorName || '',
        nextSessionAt: this._formatDateTime(context.nextSessionAt, 'ar'),
        sessionTypeName: context.sessionTypeName || '',
      },
      en: {
        creatorName: context.creatorName || '',
        nextSessionAt: this._formatDateTime(context.nextSessionAt, 'en'),
        sessionTypeName: context.sessionTypeName || '',
      },
    });
  }

  async renderMeetingReminderNotification(context = {}, options = {}) {
    const settings = await this.getManageSettings();
    const template = options?.template
      ? this.normalizeMeetingReminderTemplate(options.template)
      : settings.notificationTemplates.meetingReminder;
    const reminderLeadMinutes = this._normalizeLeadMinutes(
      options?.reminderLeadMinutes ?? context.reminderLeadMinutes,
      settings.meetingReminderLeadMinutes
    );

    return this._renderLocalizedTemplate(template, {
      ar: {
        meetingName: context.meetingName || '',
        meetingDay: this._formatWeekday(context.meetingDay, 'ar'),
        meetingTime: this._formatTime(context.meetingTime, 'ar'),
        meetingDateTime: this._formatDateTime(context.meetingDateTime, 'ar'),
        sectorName: context.sectorName || '',
        reminderLeadTime: this._formatLeadTime(reminderLeadMinutes, 'ar'),
      },
      en: {
        meetingName: context.meetingName || '',
        meetingDay: this._formatWeekday(context.meetingDay, 'en'),
        meetingTime: this._formatTime(context.meetingTime, 'en'),
        meetingDateTime: this._formatDateTime(context.meetingDateTime, 'en'),
        sectorName: context.sectorName || '',
        reminderLeadTime: this._formatLeadTime(reminderLeadMinutes, 'en'),
      },
    });
  }

  async renderDashboardNotificationPublishedNotification(context = {}) {
    const settings = await this.getManageSettings();
    const template = settings.notificationTemplates.dashboardNotificationPublished;

    return this._renderLocalizedTemplate(template, {
      ar: {
        notificationName: context.notificationName || '',
        notificationSummary: context.notificationSummary || '',
        notificationTypeName: context.notificationTypeName || '',
        eventDate: this._formatDateTime(context.eventDate, 'ar'),
      },
      en: {
        notificationName: context.notificationName || '',
        notificationSummary: context.notificationSummary || '',
        notificationTypeName: context.notificationTypeName || '',
        eventDate: this._formatDateTime(context.eventDate, 'en'),
      },
    });
  }

  async renderDivineLiturgyExceptionalCaseNotification(context = {}) {
    const settings = await this.getManageSettings();
    const template = settings.notificationTemplates.divineLiturgyExceptionalCase;

    return this._renderLocalizedTemplate(template, {
      ar: {
        exceptionName: context.exceptionName || '',
        exceptionDate: this._formatDate(context.exceptionDate, 'ar'),
        startTime: this._formatTime(context.startTime, 'ar'),
        endTime: this._formatTime(context.endTime, 'ar'),
      },
      en: {
        exceptionName: context.exceptionName || '',
        exceptionDate: this._formatDate(context.exceptionDate, 'en'),
        startTime: this._formatTime(context.startTime, 'en'),
        endTime: this._formatTime(context.endTime, 'en'),
      },
    });
  }
}

module.exports = new PlatformSettingsService();
