const dotenv = require('dotenv');
const fs = require('fs');
const path = require('path');
const cron = require('node-cron');

dotenv.config({ path: path.join(__dirname, '../../.env') });

const projectRoot = path.join(__dirname, '../../');
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

const resolveAppPath = (value, fallback = '') => {
  const normalized = String(value || fallback || '').trim();
  if (!normalized) return '';

  return path.isAbsolute(normalized)
    ? normalized
    : path.resolve(projectRoot, normalized);
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

const backupEnabled = parseBoolean(process.env.BACKUP_ENABLED, false);
const backupSchedulerEnabled = parseBoolean(process.env.BACKUP_SCHEDULER_ENABLED, true);
const backupIntervalDays = parseInteger(process.env.BACKUP_INTERVAL_DAYS, 3);
const backupCron = String(process.env.BACKUP_CRON || '0 2 * * *').trim();
const backupTimezone = String(process.env.BACKUP_TIMEZONE || 'UTC').trim() || 'UTC';
const backupLocalRetentionDays = parseInteger(process.env.BACKUP_LOCAL_RETENTION_DAYS, 1);
const backupLockTimeoutMinutes = parseInteger(process.env.BACKUP_LOCK_TIMEOUT_MINUTES, 240);
const backupFilePrefix = String(process.env.BACKUP_FILE_PREFIX || 'church-mongodb-backup')
  .trim()
  .replace(/[^\w.-]+/g, '-')
  .replace(/^-+|-+$/g, '');
const backupTempDir = resolveAppPath(process.env.BACKUP_TEMP_DIR, path.join('tmp', 'backups'));
const googleOAuthClientFilePath = resolveAppPath(
  process.env.GOOGLE_OAUTH_CLIENT_FILE,
  path.join('secure', 'google-oauth-client.json')
);
const googleOAuthTokenFilePath = resolveAppPath(
  process.env.GOOGLE_OAUTH_TOKEN_FILE,
  path.join('secure', 'google-oauth-token.json')
);
const smtpEnabled = parseBoolean(process.env.SMTP_ENABLED, false);
const smtpHost = String(process.env.SMTP_HOST || '').trim();
const smtpPort = parseInteger(process.env.SMTP_PORT, 587);
const smtpSecure = parseBoolean(process.env.SMTP_SECURE, false);
const smtpUser = String(process.env.SMTP_USER || '').trim();
const smtpPass = String(process.env.SMTP_PASS || process.env.SMTP_PASSWORD || '');
const smtpFrom = String(process.env.SMTP_FROM || '').trim();
const backupNotificationRecipients = parseList(
  process.env.BACKUP_NOTIFICATION_EMAILS || 'gergessamuel100@gmail.com'
);
const backupEmailNotificationsEnabled = parseBoolean(
  process.env.BACKUP_EMAIL_NOTIFICATIONS_ENABLED,
  false
);
const backupNotificationSubjectPrefix = String(
  process.env.BACKUP_NOTIFICATION_SUBJECT_PREFIX || '[Church Backup]'
).trim();
const googleOAuthAllowMissingToken = parseBoolean(
  process.env.GOOGLE_OAUTH_ALLOW_MISSING_TOKEN,
  false
);
const vapidPublicKey = String(process.env.VAPID_PUBLIC_KEY || '').trim();
const vapidPrivateKey = String(process.env.VAPID_PRIVATE_KEY || '').trim();
const vapidEmail = String(process.env.VAPID_EMAIL || '').trim();
const pushCredentialsCount = [vapidPublicKey, vapidPrivateKey, vapidEmail].filter(Boolean).length;
const pushEnabled = pushCredentialsCount === 3;
const redisUrl = String(process.env.REDIS_URL || '').trim();
const redisHost = redisUrl ? '' : String(process.env.REDIS_HOST || '').trim();
const redisPort = redisUrl
  ? undefined
  : process.env.REDIS_PORT
    ? parseInteger(process.env.REDIS_PORT, 6379)
    : redisHost
      ? 6379
      : undefined;
const redisPassword = redisUrl
  ? undefined
  : String(process.env.REDIS_PASSWORD || '').trim() || undefined;

if (pushCredentialsCount > 0 && pushCredentialsCount < 3) {
  throw new Error(
    'Web push configuration is incomplete. Provide VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, and VAPID_EMAIL together.'
  );
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
    url: redisUrl,
    host: redisHost,
    port: redisPort,
    password: redisPassword,
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

  mail: {
    enabled: smtpEnabled,
    host: smtpHost,
    port: smtpPort,
    secure: smtpSecure,
    user: smtpUser,
    pass: smtpPass,
    from: smtpFrom,
  },

  rateLimit: {
    windowMs: parseInteger(process.env.RATE_LIMIT_WINDOW_MS, 15 * 60 * 1000),
    max: parseInteger(process.env.RATE_LIMIT_MAX, isProduction ? 600 : 1000),
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

  push: {
    enabled: pushEnabled,
    vapidPublicKey,
    vapidPrivateKey,
    vapidEmail,
    vapidSubject: vapidEmail
      ? vapidEmail.startsWith('mailto:')
        ? vapidEmail
        : `mailto:${vapidEmail}`
      : '',
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

  meetingReminders: {
    pollIntervalMs: parseInteger(
      process.env.MEETING_REMINDER_POLL_INTERVAL_MS,
      60 * 1000
    ),
  },

  backup: {
    enabled: backupEnabled,
    schedulerEnabled: backupEnabled ? backupSchedulerEnabled : false,
    intervalDays: backupIntervalDays,
    intervalMs: backupIntervalDays * 24 * 60 * 60 * 1000,
    cron: backupCron,
    timezone: backupTimezone,
    tempDir: backupTempDir,
    localRetentionDays: backupLocalRetentionDays,
    localRetentionMs:
      backupLocalRetentionDays < 0 ? -1 : backupLocalRetentionDays * 24 * 60 * 60 * 1000,
    lockTimeoutMs: backupLockTimeoutMinutes * 60 * 1000,
    filePrefix: backupFilePrefix || 'church-mongodb-backup',
    mongodumpPath: String(process.env.BACKUP_MONGODUMP_PATH || 'mongodump').trim() || 'mongodump',
    googleDrive: {
      folderId: String(process.env.GOOGLE_DRIVE_FOLDER_ID || '').trim(),
      oauthClientFilePath: googleOAuthClientFilePath,
      oauthTokenFilePath: googleOAuthTokenFilePath,
    },
    notifications: {
      emailEnabled: backupEmailNotificationsEnabled,
      recipients: backupNotificationRecipients,
      subjectPrefix: backupNotificationSubjectPrefix || '[Church Backup]',
    },
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

if (config.mail.enabled) {
  if (!config.mail.host) {
    throw new Error('SMTP_HOST is required when SMTP_ENABLED=true.');
  }

  if (!config.mail.from) {
    throw new Error('SMTP_FROM is required when SMTP_ENABLED=true.');
  }

  if (config.mail.port < 1) {
    throw new Error('SMTP_PORT must be a valid port number when SMTP_ENABLED=true.');
  }

  if ((config.mail.user && !config.mail.pass) || (!config.mail.user && config.mail.pass)) {
    throw new Error('SMTP_USER and SMTP_PASS must be provided together.');
  }
}

if (config.backup.enabled) {
  if (config.backup.intervalDays < 1) {
    throw new Error('BACKUP_INTERVAL_DAYS must be at least 1.');
  }

  if (!cron.validate(config.backup.cron)) {
    throw new Error('BACKUP_CRON is invalid. Provide a valid cron expression.');
  }

  if (config.backup.localRetentionDays < -1) {
    throw new Error('BACKUP_LOCAL_RETENTION_DAYS must be -1 or greater.');
  }

  if (config.backup.lockTimeoutMs < 60 * 1000) {
    throw new Error('BACKUP_LOCK_TIMEOUT_MINUTES must be at least 1.');
  }

  if (!config.backup.googleDrive.folderId) {
    throw new Error('GOOGLE_DRIVE_FOLDER_ID is required when BACKUP_ENABLED=true.');
  }

  if (!config.backup.googleDrive.oauthClientFilePath) {
    throw new Error(
      'GOOGLE_OAUTH_CLIENT_FILE is required when BACKUP_ENABLED=true.'
    );
  }

  if (!fs.existsSync(config.backup.googleDrive.oauthClientFilePath)) {
    throw new Error(
      `GOOGLE_OAUTH_CLIENT_FILE does not exist: ${config.backup.googleDrive.oauthClientFilePath}`
    );
  }

  if (!config.backup.googleDrive.oauthTokenFilePath) {
    throw new Error(
      'GOOGLE_OAUTH_TOKEN_FILE is required when BACKUP_ENABLED=true. Run the OAuth authorization script first to generate the token file.'
    );
  }

  if (!googleOAuthAllowMissingToken && !fs.existsSync(config.backup.googleDrive.oauthTokenFilePath)) {
    throw new Error(
      `GOOGLE_OAUTH_TOKEN_FILE does not exist: ${config.backup.googleDrive.oauthTokenFilePath}. Run the OAuth authorization script first.`
    );
  }

  if (config.backup.notifications.emailEnabled) {
    if (!config.mail.enabled) {
      throw new Error(
        'Backup email notifications require SMTP_ENABLED=true and valid SMTP configuration.'
      );
    }

    if (config.backup.notifications.recipients.length === 0) {
      throw new Error(
        'BACKUP_NOTIFICATION_EMAILS must include at least one email address when BACKUP_EMAIL_NOTIFICATIONS_ENABLED=true.'
      );
    }
  }
}

if (config.push.enabled) {
  if (!config.push.vapidPublicKey || !config.push.vapidPrivateKey || !config.push.vapidSubject) {
    throw new Error('Web push configuration is incomplete.');
  }
}

module.exports = config;
