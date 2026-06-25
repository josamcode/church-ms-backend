const mongoose = require('mongoose');
const {
  LANDING_CONTENT_DOCUMENT_KEY,
  LANDING_STAT_SOURCE_TYPES,
  LANDING_SYSTEM_STAT_KEYS,
  LANDING_DEFAULT_STAT_ITEMS,
  LANDING_SOCIAL_PLATFORMS,
} = require('./landingContent.constants');

const localizedTextSchema = new mongoose.Schema(
  {
    en: { type: String, trim: true, default: '' },
    ar: { type: String, trim: true, default: '' },
  },
  { _id: false }
);

const heroImageSchema = new mongoose.Schema(
  {
    url: { type: String, trim: true },
    storageKey: { type: String, trim: true },
    provider: { type: String, trim: true, default: 'r2' },
    mimeType: { type: String, trim: true, default: '' },
    size: { type: Number, min: 0, default: 0 },
  },
  { _id: false }
);

const statItemSchema = new mongoose.Schema(
  {
    sourceType: {
      type: String,
      enum: Object.values(LANDING_STAT_SOURCE_TYPES),
      default: LANDING_STAT_SOURCE_TYPES.SYSTEM,
    },
    sourceKey: {
      type: String,
      enum: Object.values(LANDING_SYSTEM_STAT_KEYS),
      default: LANDING_SYSTEM_STAT_KEYS.MEMBERS_TOTAL,
    },
    manualValue: {
      type: String,
      trim: true,
      default: '',
    },
  },
  { _id: false }
);

const priestEntrySchema = new mongoose.Schema(
  {
    priestUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    role: {
      type: localizedTextSchema,
      default: () => ({ en: '', ar: '' }),
    },
    bio: {
      type: localizedTextSchema,
      default: () => ({ en: '', ar: '' }),
    },
    alt: {
      type: localizedTextSchema,
      default: () => ({ en: '', ar: '' }),
    },
  },
  { _id: false }
);

const socialLinkSchema = new mongoose.Schema(
  {
    platform: {
      type: String,
      enum: LANDING_SOCIAL_PLATFORMS,
      required: true,
    },
    enabled: {
      type: Boolean,
      default: false,
    },
    url: {
      type: String,
      trim: true,
      default: '',
    },
    handle: {
      type: String,
      trim: true,
      default: '',
    },
  },
  { _id: false }
);

const locationSchema = new mongoose.Schema(
  {
    placeName: { type: String, trim: true, default: '' },
    plusCode: { type: String, trim: true, default: '' },
    addressLine: { type: String, trim: true, default: '' },
    mapEmbedUrl: { type: String, trim: true, default: '' },
    directionsUrl: { type: String, trim: true, default: '' },
  },
  { _id: false }
);

const landingContentSchema = new mongoose.Schema(
  {
    key: {
      type: String,
      trim: true,
      unique: true,
      default: LANDING_CONTENT_DOCUMENT_KEY,
    },
    texts: {
      type: mongoose.Schema.Types.Mixed,
      default: () => ({ en: {}, ar: {} }),
    },
    heroImage: {
      type: heroImageSchema,
      default: undefined,
    },
    stats: {
      families: {
        type: statItemSchema,
        default: () => ({ ...LANDING_DEFAULT_STAT_ITEMS.families }),
      },
      members: {
        type: statItemSchema,
        default: () => ({ ...LANDING_DEFAULT_STAT_ITEMS.members }),
      },
      services: {
        type: statItemSchema,
        default: () => ({ ...LANDING_DEFAULT_STAT_ITEMS.services }),
      },
      servants: {
        type: statItemSchema,
        default: () => ({ ...LANDING_DEFAULT_STAT_ITEMS.servants }),
      },
    },
    priestEntries: {
      type: [priestEntrySchema],
      default: [],
    },
    location: {
      type: locationSchema,
      default: () => ({
        placeName: '',
        plusCode: '',
        addressLine: '',
        mapEmbedUrl: '',
        directionsUrl: '',
      }),
    },
    socialLinks: {
      type: [socialLinkSchema],
      default: () =>
        LANDING_SOCIAL_PLATFORMS.map((platform) => ({
          platform,
          enabled: false,
          url: '',
          handle: '',
        })),
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

const LandingContent = mongoose.model('LandingContent', landingContentSchema);

module.exports = LandingContent;
