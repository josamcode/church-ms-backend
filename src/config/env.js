const dotenv = require('dotenv');
const path = require('path');

dotenv.config({ path: path.join(__dirname, '../../.env') });

const env = process.env.NODE_ENV || 'development';
const isProduction = env === 'production';
const isDevelopmentLike = env === 'development' || env === 'test';

const parseInteger = (value, fallback) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const parseBoolean = (value, fallback = false) => {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }

  const normalized = String(value).trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'off'].includes(normalized)) return false;
  return fallback;
};

const parseList = (value) =>
  String(value || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);

const parseTrustProxy = (value, fallback) => {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }

  const normalized = String(value).trim().toLowerCase();
  if (['true', '1'].includes(normalized)) return 1;
  if (['false', '0'].includes(normalized)) return false;

  const parsedInteger = Number.parseInt(normalized, 10);
  if (Number.isFinite(parsedInteger) && parsedInteger >= 0) {
    return parsedInteger;
  }

  return value;
};

const looksLikePlaceholderSecret = (value) => {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return true;

  return [
    'default_access_secret_change_me',
    'default_refresh_secret_change_me',
    'your_access_secret',
    'your_refresh_secret',
    'change_in_production',
    'change_me',
    'changeme',
  ].some((pattern) => normalized.includes(pattern));
};

const assertStrongSecret = (label, value) => {
  const normalized = String(value || '').trim();
  if (normalized.length < 32 || looksLikePlaceholderSecret(normalized)) {
    throw new Error(
      `${label} must be at least 32 characters long and must not use placeholder values`
    );
  }
};

const configuredCorsOrigins = parseList(process.env.CORS_ORIGIN);
const allowedCorsOrigins =
  configuredCorsOrigins.length > 0
    ? configuredCorsOrigins
    : isDevelopmentLike
      ? ['http://localhost:3000', 'http://127.0.0.1:3000']
      : [];

const cloudinary = {
  cloudName: process.env.CLOUDINARY_CLOUD_NAME || '',
  apiKey: process.env.CLOUDINARY_API_KEY || '',
  apiSecret: process.env.CLOUDINARY_API_SECRET || '',
};
const cloudinaryCredentialsCount = [cloudinary.cloudName, cloudinary.apiKey, cloudinary.apiSecret]
  .filter(Boolean).length;
const cloudinaryEnabled = cloudinaryCredentialsCount === 3;

if (cloudinaryCredentialsCount > 0 && cloudinaryCredentialsCount < 3) {
  throw new Error('Cloudinary configuration is incomplete. Provide all required credentials.');
}

const config = {
  env,
  isProduction,
  isDevelopmentLike,
  port: parseInteger(process.env.PORT, 5000),

  mongo: {
    uri: process.env.MONGO_URI || 'mongodb://localhost:27017/church',
  },

  redis: {
    url: process.env.REDIS_URL || '',
    host: process.env.REDIS_HOST || '',
    port: process.env.REDIS_PORT
      ? parseInteger(process.env.REDIS_PORT, 6379)
      : process.env.REDIS_HOST
        ? 6379
        : undefined,
    password: process.env.REDIS_PASSWORD || undefined,
    enabled: process.env.REDIS_ENABLED ? process.env.REDIS_ENABLED !== 'false' : true,
    required: parseBoolean(process.env.REDIS_REQUIRED, isProduction),
    readyTimeoutMs: parseInteger(process.env.REDIS_READY_TIMEOUT_MS, 5000),
  },

  jwt: {
    accessSecret: process.env.JWT_ACCESS_SECRET || '',
    refreshSecret: process.env.JWT_REFRESH_SECRET || '',
    accessExpiresIn: process.env.JWT_ACCESS_EXPIRES_IN || '15m',
    refreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '7d',
    refreshExpiresInMs:
      parseInteger(process.env.JWT_REFRESH_EXPIRES_IN_MS, 7 * 24 * 60 * 60 * 1000),
  },

  cloudinary: {
    ...cloudinary,
    enabled: cloudinaryEnabled,
    required: parseBoolean(process.env.CLOUDINARY_REQUIRED, isProduction),
  },

  cors: {
    origin: configuredCorsOrigins.join(','),
    allowedOrigins: allowedCorsOrigins,
    credentials: parseBoolean(process.env.CORS_CREDENTIALS, true),
  },

  docs: {
    enabled: parseBoolean(process.env.ENABLE_API_DOCS, !isProduction),
  },

  http: {
    trustProxy: parseTrustProxy(process.env.TRUST_PROXY, isProduction ? 1 : false),
  },

  site: {
    name: process.env.SITE_NAME || 'Church',
    tagline: process.env.SITE_TAGLINE || 'Church management system',
  },

  rateLimit: {
    windowMs: parseInteger(process.env.RATE_LIMIT_WINDOW_MS, 15 * 60 * 1000),
    max: parseInteger(process.env.RATE_LIMIT_MAX, 100),
  },

  upload: {
    maxFileSize: parseInteger(process.env.MAX_FILE_SIZE, 5 * 1024 * 1024),
    allowedImageTypes: ['image/jpeg', 'image/png', 'image/gif', 'image/webp'],
    maxDocumentationFileSize:
      parseInteger(process.env.MAX_DOCUMENTATION_FILE_SIZE, 20 * 1024 * 1024),
    allowedVideoTypes: ['video/mp4', 'video/quicktime', 'video/webm'],
    allowedDocumentTypes: [
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'text/plain',
    ],
  },

  cache: {
    userTTL: parseInteger(process.env.CACHE_USER_TTL, 3600),
    permissionsTTL: parseInteger(process.env.CACHE_PERMISSIONS_TTL, 1800),
  },

  aidReminders: {
    pollIntervalMs: parseInteger(
      process.env.AID_REMINDER_POLL_INTERVAL_MS,
      60 * 60 * 1000
    ),
  },
};

if (isProduction) {
  assertStrongSecret('JWT_ACCESS_SECRET', config.jwt.accessSecret);
  assertStrongSecret('JWT_REFRESH_SECRET', config.jwt.refreshSecret);

  if (configuredCorsOrigins.includes('*') && config.cors.credentials) {
    throw new Error('CORS_ORIGIN cannot include "*" when CORS credentials are enabled');
  }
}

if (!isProduction) {
  config.jwt.accessSecret =
    config.jwt.accessSecret || 'development_only_access_secret_change_before_production_123456';
  config.jwt.refreshSecret =
    config.jwt.refreshSecret || 'development_only_refresh_secret_change_before_production_123456';
}

if (config.redis.required && !(config.redis.url || config.redis.host)) {
  throw new Error('Redis is required in this environment. Set REDIS_URL or REDIS_HOST.');
}

if (config.cloudinary.required && !config.cloudinary.enabled) {
  throw new Error('Cloudinary is required in this environment. Configure all Cloudinary secrets.');
}

module.exports = config;
