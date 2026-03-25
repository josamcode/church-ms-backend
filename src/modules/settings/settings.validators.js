const Joi = require('joi');

const localizedTitleSchema = Joi.object({
  ar: Joi.string().trim().max(160).required(),
  en: Joi.string().trim().max(160).allow('').default(''),
}).required();

const localizedMessageSchema = Joi.object({
  ar: Joi.string().trim().max(2000).required(),
  en: Joi.string().trim().max(2000).allow('').default(''),
}).required();

const notificationTemplateSchema = Joi.object({
  title: localizedTitleSchema,
  message: localizedMessageSchema,
}).required();

const updatePlatformSettings = {
  body: Joi.object({
    notificationTemplates: Joi.object({
      confessionNextSession: notificationTemplateSchema,
      dashboardNotificationPublished: notificationTemplateSchema,
      divineLiturgyExceptionalCase: notificationTemplateSchema,
    }).required(),
  }).required(),
};

module.exports = {
  updatePlatformSettings,
};
