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
});

const TEMPLATE_TOKENS = Object.freeze({
  confessionNextSession: [
    { token: '{nextSessionAt}', label: 'Next session date/time' },
    { token: '{creatorName}', label: 'Creator name' },
    { token: '{sessionTypeName}', label: 'Session type' },
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
    const confessionNextSession = value?.confessionNextSession || {};

    return {
      confessionNextSession: {
        title: this._normalizeLocalizedText(
          confessionNextSession.title || DEFAULT_NOTIFICATION_TEMPLATES.confessionNextSession.title,
          160
        ),
        message: this._normalizeLocalizedText(
          confessionNextSession.message || DEFAULT_NOTIFICATION_TEMPLATES.confessionNextSession.message,
          2000
        ),
      },
    };
  }

  _buildPayload(document = null) {
    return {
      notificationTemplates: this._normalizeNotificationTemplates(document?.notificationTemplates),
      availableTokens: TEMPLATE_TOKENS,
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

  async updateManageSettings(payload = {}, actorUserId) {
    const document = await this._ensureDocument();

    document.notificationTemplates = this._normalizeNotificationTemplates(payload.notificationTemplates);
    document.updatedBy = this._toObjectId(actorUserId, 'actorUserId');

    if (!document.createdBy) {
      document.createdBy = this._toObjectId(actorUserId, 'actorUserId');
    }

    await document.save();

    return this.getManageSettings();
  }

  _renderTemplate(template, context = {}) {
    const safeTemplate = String(template || '');

    return safeTemplate.replace(/\{([^{}]+)\}/g, (_match, rawToken) => {
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

  async renderConfessionNextSessionNotification(context = {}) {
    const settings = await this.getManageSettings();
    const template = settings.notificationTemplates.confessionNextSession;

    const localized = {
      title: {
        ar: this._renderTemplate(template?.title?.ar, {
          creatorName: context.creatorName || '',
          nextSessionAt: this._formatDateTime(context.nextSessionAt, 'ar'),
          sessionTypeName: context.sessionTypeName || '',
        }),
        en: this._renderTemplate(template?.title?.en, {
          creatorName: context.creatorName || '',
          nextSessionAt: this._formatDateTime(context.nextSessionAt, 'en'),
          sessionTypeName: context.sessionTypeName || '',
        }),
      },
      message: {
        ar: this._renderTemplate(template?.message?.ar, {
          creatorName: context.creatorName || '',
          nextSessionAt: this._formatDateTime(context.nextSessionAt, 'ar'),
          sessionTypeName: context.sessionTypeName || '',
        }),
        en: this._renderTemplate(template?.message?.en, {
          creatorName: context.creatorName || '',
          nextSessionAt: this._formatDateTime(context.nextSessionAt, 'en'),
          sessionTypeName: context.sessionTypeName || '',
        }),
      },
    };

    return {
      title: localized.title.ar || localized.title.en || '',
      message: localized.message.ar || localized.message.en || '',
      localized,
    };
  }
}

module.exports = new PlatformSettingsService();
