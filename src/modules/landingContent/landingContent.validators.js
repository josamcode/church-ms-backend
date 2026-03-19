const Joi = require('joi');
const {
  LANDING_STAT_SOURCE_TYPES,
  LANDING_SYSTEM_STAT_KEYS,
  LANDING_SOCIAL_PLATFORMS,
} = require('./landingContent.constants');

const OBJECT_ID_PATTERN = /^[0-9a-fA-F]{24}$/;

const localizedTextSchema = Joi.object({
  en: Joi.string().trim().max(5000).allow('').default(''),
  ar: Joi.string().trim().max(5000).allow('').default(''),
}).default({ en: '', ar: '' });

const statItemSchema = Joi.object({
  sourceType: Joi.string()
    .valid(...Object.values(LANDING_STAT_SOURCE_TYPES))
    .required(),
  sourceKey: Joi.string()
    .valid(...Object.values(LANDING_SYSTEM_STAT_KEYS))
    .required(),
  manualValue: Joi.string().trim().max(120).allow('').default(''),
});

const priestEntrySchema = Joi.object({
  priestUserId: Joi.string().pattern(OBJECT_ID_PATTERN).required().messages({
    'string.pattern.base': 'Invalid priest user id',
  }),
  role: localizedTextSchema,
  bio: Joi.object({
    en: Joi.string().trim().max(4000).allow('').default(''),
    ar: Joi.string().trim().max(4000).allow('').default(''),
  }).default({ en: '', ar: '' }),
  alt: Joi.object({
    en: Joi.string().trim().max(240).allow('').default(''),
    ar: Joi.string().trim().max(240).allow('').default(''),
  }).default({ en: '', ar: '' }),
});

const socialLinkSchema = Joi.object({
  platform: Joi.string()
    .valid(...LANDING_SOCIAL_PLATFORMS)
    .required(),
  enabled: Joi.boolean().default(false),
  url: Joi.string().uri().max(2000).allow('').default(''),
  handle: Joi.string().trim().max(160).allow('').default(''),
});

const updateLandingContent = {
  body: Joi.object({
    texts: Joi.object({
      en: Joi.object().unknown(true).default({}),
      ar: Joi.object().unknown(true).default({}),
    }).default({ en: {}, ar: {} }),
    stats: Joi.object({
      families: statItemSchema.required(),
      members: statItemSchema.required(),
      services: statItemSchema.required(),
      servants: statItemSchema.required(),
    }).required(),
    priestEntries: Joi.array().items(priestEntrySchema).required(),
    location: Joi.object({
      placeName: Joi.string().trim().max(240).allow('').default(''),
      plusCode: Joi.string().trim().max(120).allow('').default(''),
      addressLine: Joi.string().trim().max(500).allow('').default(''),
      mapEmbedUrl: Joi.string().uri().max(2000).allow('').default(''),
      directionsUrl: Joi.string().uri().max(2000).allow('').default(''),
    }).required(),
    socialLinks: Joi.array().items(socialLinkSchema).required(),
  }),
};

module.exports = {
  updateLandingContent,
};

