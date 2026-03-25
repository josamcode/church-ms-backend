const mongoose = require('mongoose');

const PLATFORM_SETTINGS_DOCUMENT_KEY = 'platform_settings';

const localizedTextSchema = new mongoose.Schema(
  {
    en: { type: String, trim: true, default: '' },
    ar: { type: String, trim: true, default: '' },
  },
  { _id: false }
);

const notificationTemplateSchema = new mongoose.Schema(
  {
    title: {
      type: localizedTextSchema,
      default: () => ({ en: '', ar: '' }),
    },
    message: {
      type: localizedTextSchema,
      default: () => ({ en: '', ar: '' }),
    },
  },
  { _id: false }
);

const platformSettingsSchema = new mongoose.Schema(
  {
    key: {
      type: String,
      trim: true,
      unique: true,
      default: PLATFORM_SETTINGS_DOCUMENT_KEY,
    },
    notificationTemplates: {
      confessionNextSession: {
        type: notificationTemplateSchema,
        default: () => ({
          title: {
            ar: 'موعد جلسة الاعتراف القادمة',
            en: 'موعد جلسة الاعتراف القادمة',
          },
          message: {
            ar: 'تم تحديد موعد جلسة الاعتراف القادمة بتاريخ {nextSessionAt}.',
            en: 'تم تحديد موعد جلسة الاعتراف القادمة بتاريخ {nextSessionAt}.',
          },
        }),
      },
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
  },
  { timestamps: true }
);

const PlatformSettings = mongoose.model('PlatformSettings', platformSettingsSchema);

module.exports = {
  PlatformSettings,
  PLATFORM_SETTINGS_DOCUMENT_KEY,
};
