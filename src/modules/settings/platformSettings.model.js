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
      meetingReminder: {
        type: notificationTemplateSchema,
        default: () => ({
          title: {
            ar: 'تذكير بموعد الاجتماع',
            en: 'تذكير بموعد الاجتماع',
          },
          message: {
            ar: 'سيتبقى {reminderLeadTime} على اجتماع {meetingName} يوم {meetingDay} في {meetingDateTime}.',
            en: 'سيتبقى {reminderLeadTime} على اجتماع {meetingName} يوم {meetingDay} في {meetingDateTime}.',
          },
        }),
      },
      dashboardNotificationPublished: {
        type: notificationTemplateSchema,
        default: () => ({
          title: {
            ar: 'إشعار جديد',
            en: 'إشعار جديد',
          },
          message: {
            ar: 'تم نشر إشعار جديد بعنوان {notificationName}.',
            en: 'تم نشر إشعار جديد بعنوان {notificationName}.',
          },
        }),
      },
      divineLiturgyExceptionalCase: {
        type: notificationTemplateSchema,
        default: () => ({
          title: {
            ar: 'قداس استثنائي جديد',
            en: 'قداس استثنائي جديد',
          },
          message: {
            ar: 'تمت إضافة حالة قداس استثنائية بتاريخ {exceptionDate} في {startTime}.',
            en: 'تمت إضافة حالة قداس استثنائية بتاريخ {exceptionDate} في {startTime}.',
          },
        }),
      },
    },
    meetingReminderLeadMinutes: {
      type: Number,
      min: 0,
      max: 10080,
      default: 60,
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
