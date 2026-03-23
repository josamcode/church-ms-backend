const mongoose = require('mongoose');

const ANALYTICS_SURFACES = Object.freeze(['public', 'auth', 'dashboard', 'other']);

const pathStatSchema = new mongoose.Schema(
  {
    path: { type: String, trim: true, required: true },
    title: { type: String, trim: true, default: '' },
    views: { type: Number, default: 0, min: 0 },
    activeSeconds: { type: Number, default: 0, min: 0 },
    lastSeenAt: { type: Date },
  },
  { _id: false }
);

const siteAnalyticsSessionSchema = new mongoose.Schema(
  {
    sessionId: {
      type: String,
      required: true,
      unique: true,
      index: true,
      trim: true,
    },
    visitorId: {
      type: String,
      required: true,
      index: true,
      trim: true,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      index: true,
      sparse: true,
    },
    userRole: {
      type: String,
      trim: true,
    },
    isAuthenticated: {
      type: Boolean,
      default: false,
      index: true,
    },
    entrySurface: {
      type: String,
      enum: ANALYTICS_SURFACES,
      default: 'other',
      index: true,
    },
    currentSurface: {
      type: String,
      enum: ANALYTICS_SURFACES,
      default: 'other',
    },
    entryPath: {
      type: String,
      trim: true,
      default: '/',
    },
    currentPath: {
      type: String,
      trim: true,
      default: '/',
    },
    exitPath: {
      type: String,
      trim: true,
      default: '/',
    },
    entryTitle: {
      type: String,
      trim: true,
      default: '',
    },
    currentTitle: {
      type: String,
      trim: true,
      default: '',
    },
    referrer: {
      type: String,
      trim: true,
      default: '',
    },
    language: {
      type: String,
      trim: true,
      default: '',
    },
    timezone: {
      type: String,
      trim: true,
      default: '',
    },
    userAgent: {
      type: String,
      trim: true,
      default: '',
    },
    screenWidth: {
      type: Number,
      min: 0,
    },
    screenHeight: {
      type: Number,
      min: 0,
    },
    totalPageViews: {
      type: Number,
      default: 0,
      min: 0,
    },
    totalActiveSeconds: {
      type: Number,
      default: 0,
      min: 0,
    },
    pathsVisited: {
      type: [String],
      default: [],
    },
    pathStats: {
      type: Map,
      of: pathStatSchema,
      default: () => ({}),
    },
    startedAt: {
      type: Date,
      required: true,
      index: true,
    },
    lastSeenAt: {
      type: Date,
      required: true,
      index: true,
    },
    endedAt: {
      type: Date,
    },
  },
  {
    timestamps: true,
  }
);

siteAnalyticsSessionSchema.index({ startedAt: -1 });
siteAnalyticsSessionSchema.index({ lastSeenAt: -1 });
siteAnalyticsSessionSchema.index({ entrySurface: 1, startedAt: -1 });
siteAnalyticsSessionSchema.index({ visitorId: 1, startedAt: -1 });
siteAnalyticsSessionSchema.index({ userId: 1, startedAt: -1 });
siteAnalyticsSessionSchema.index({ isAuthenticated: 1, startedAt: -1 });

const SiteAnalyticsSession = mongoose.model('SiteAnalyticsSession', siteAnalyticsSessionSchema);

module.exports = {
  SiteAnalyticsSession,
  ANALYTICS_SURFACES,
};
