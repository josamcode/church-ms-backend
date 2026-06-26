const rateLimit = require('express-rate-limit');
const RedisStore = require('rate-limit-redis').default;
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const redisClient = require('../config/redis');
const ApiResponse = require('../utils/apiResponse');
const config = require('../config/env');
const logger = require('../utils/logger');

const HEALTH_CHECK_PATH = '/health';
const ANALYTICS_SYNC_PATH = '/system-analytics/sessions/sync';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

const RATE_LIMIT_POLICIES = [
  {
    group: 'Global API baseline',
    key: 'authenticated user when a valid access token is present, otherwise IP',
    window: '15 minutes',
    max: '600 anonymous / 5000 authenticated in production',
    reason: 'Caps broad API floods, including unknown API paths, while leaving room for normal admin sessions.',
    redisRequired: 'production',
    userImpact: 'Normal browsing and dashboard usage should stay well below the ceiling.',
  },
  {
    group: 'Public reads',
    key: 'IP',
    window: '15 minutes',
    max: 300,
    reason: 'Protects public content, archive, booking type, slot, and registration-option reads.',
    redisRequired: 'production',
    userImpact: 'Allows repeated browsing without letting scrapers run unbounded.',
  },
  {
    group: 'Login',
    key: 'IP and normalized login identifier hash',
    window: '15 minutes',
    max: '30 per IP / 8 per identifier',
    reason: 'Slows brute-force attempts against both a network source and a targeted account.',
    redisRequired: 'production',
    userImpact: 'Legitimate users can retry a few mistakes, then must wait.',
  },
  {
    group: 'Register',
    key: 'IP and submitted phone/email hash',
    window: '1 hour',
    max: '10 per IP / 3 per identifier',
    reason: 'Prevents registration and notification-review spam.',
    redisRequired: 'production',
    userImpact: 'Normal family registration remains unaffected.',
  },
  {
    group: 'Refresh/logout/password',
    key: 'authenticated user when available, otherwise IP/token fingerprint',
    window: '15 minutes',
    max: 60,
    reason: 'Limits token replay loops and password brute-force/change attempts.',
    redisRequired: 'production',
    userImpact: 'Normal session refresh is comfortably below the ceiling.',
  },
  {
    group: 'Public booking create',
    key: 'IP plus requester phone/email hash',
    window: '1 hour',
    max: '12 per IP / 4 per requester',
    reason: 'Blocks public booking spam before slot and storage ownership work.',
    redisRequired: 'production',
    userImpact: 'Enough for repeated family bookings, not automated floods.',
  },
  {
    group: 'Public booking image upload',
    key: 'IP before multipart parsing, plus global upload bucket',
    window: '1 hour',
    max: '20 public uploads per IP / 60 uploads per user-or-IP globally',
    reason: 'Stops upload spam before multer buffers files or storage is called.',
    redisRequired: 'production',
    userImpact: 'Allows normal image retries for public forms.',
  },
  {
    group: 'All file uploads',
    key: 'authenticated user when available, otherwise IP',
    window: '1 hour',
    max: 60,
    reason: 'Limits memory pressure and object-storage abuse across upload endpoints.',
    redisRequired: 'production',
    userImpact: 'Admins can upload normal content batches.',
  },
  {
    group: 'Analytics sync',
    key: 'authenticated user, otherwise session/visitor hash, otherwise IP',
    window: '1 hour',
    max: 240,
    reason: 'Tolerates active public sessions while capping telemetry floods.',
    redisRequired: 'production',
    userImpact: 'Normal browser heartbeat/sync cadence passes.',
  },
  {
    group: 'Authenticated mutations',
    key: 'authenticated user when token is valid, otherwise IP',
    window: '15 minutes',
    max: 600,
    reason: 'Protects admin write paths and invalid mutation probes before expensive handlers.',
    redisRequired: 'production',
    userImpact: 'Normal admin work is unaffected; accidental loops are stopped.',
  },
  {
    group: 'Chat messages',
    key: 'authenticated user',
    window: '1 minute',
    max: 60,
    reason: 'Limits message spam while preserving real conversations.',
    redisRequired: 'production',
    userImpact: 'One message per second sustained is allowed.',
  },
  {
    group: 'Push subscription mutations',
    key: 'authenticated user',
    window: '15 minutes',
    max: 30,
    reason: 'Prevents notification subscription churn and malformed push payload spam.',
    redisRequired: 'production',
    userImpact: 'Normal subscribe/unsubscribe flows pass.',
  },
];

const getRateLimitSetting = (name, fallback) => {
  const value = config.rateLimit?.[name];
  return Number.isFinite(Number(value)) ? Number(value) : fallback;
};

const hashIdentifier = (value) => {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return '';
  return crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 32);
};

const normalizeIdentifier = (value) => String(value || '').trim().toLowerCase();

const getBearerToken = (req) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return null;
  }

  const token = authHeader.slice('Bearer '.length).trim();
  return token || null;
};

const resolveIpRateLimitKey = (req) =>
  `ip:${req.ip || req.socket?.remoteAddress || 'unknown'}`;

const resolveAuthenticatedRateLimitKey = (req) => {
  if (req.user?.id) {
    return `user:${req.user.id}`;
  }

  const token = getBearerToken(req);
  if (!token) {
    return null;
  }

  try {
    const decoded = jwt.verify(token, config.jwt.accessSecret);
    return decoded?.sub ? `user:${decoded.sub}` : null;
  } catch (_error) {
    return null;
  }
};

const resolveRateLimitKey = (req) =>
  resolveAuthenticatedRateLimitKey(req) || resolveIpRateLimitKey(req);

const resolveBodyIdentifierKey = (req, fields, fallbackPrefix) => {
  for (const field of fields) {
    const value = normalizeIdentifier(req.body?.[field]);
    const hashed = hashIdentifier(value);
    if (hashed) {
      return `${fallbackPrefix}:${field}:${hashed}`;
    }
  }

  return resolveIpRateLimitKey(req);
};

const resolveLoginIdentifierRateLimitKey = (req) =>
  resolveBodyIdentifierKey(req, ['identifier'], 'login-id');

const resolveRegisterIdentifierRateLimitKey = (req) =>
  resolveBodyIdentifierKey(req, ['phonePrimary', 'email', 'nationalId'], 'register-id');

const resolveRefreshRateLimitKey = (req) => {
  const authenticatedKey = resolveAuthenticatedRateLimitKey(req);
  if (authenticatedKey) return authenticatedKey;

  const refreshTokenHash = hashIdentifier(req.body?.refreshToken);
  if (refreshTokenHash) {
    return `refresh-token:${refreshTokenHash}`;
  }

  return resolveIpRateLimitKey(req);
};

const resolvePublicBookingIdentifierRateLimitKey = (req) =>
  resolveBodyIdentifierKey(req, ['requesterPhone', 'requesterEmail'], 'booking-requester');

const resolvePublicBookingUploadContextRateLimitKey = (req) => {
  const bookingTypeId = normalizeIdentifier(req.body?.bookingTypeId);
  const fieldKey = normalizeIdentifier(req.body?.fieldKey);
  const contextHash = hashIdentifier(`${bookingTypeId}:${fieldKey}`);
  if (contextHash) {
    return `booking-upload:${contextHash}:${resolveIpRateLimitKey(req)}`;
  }
  return resolveIpRateLimitKey(req);
};

const resolveAnalyticsRateLimitKey = (req) => {
  const authenticatedKey = resolveAuthenticatedRateLimitKey(req);
  if (authenticatedKey) {
    return authenticatedKey;
  }

  const sessionId = String(req.body?.sessionId || '').trim();
  const visitorId = String(req.body?.visitorId || '').trim();
  const analyticsHash = hashIdentifier(`${sessionId}:${visitorId}`);
  if (analyticsHash) {
    return `analytics-session:${analyticsHash}`;
  }

  return resolveIpRateLimitKey(req);
};

const shouldSkipRateLimit = (req) => req.method === 'OPTIONS';

const shouldSkipGeneralRateLimit = (req) =>
  shouldSkipRateLimit(req) ||
  req.path === HEALTH_CHECK_PATH ||
  req.path === ANALYTICS_SYNC_PATH;

const resolveGeneralRateLimitMax = (req) =>
  resolveAuthenticatedRateLimitKey(req)
    ? getRateLimitSetting('authenticatedMax', config.isProduction ? 5000 : 500)
    : getRateLimitSetting(
      'anonymousMax',
      getRateLimitSetting('max', config.isProduction ? 600 : 100)
    );

const shouldSkipApiMutationRateLimit = (req) => {
  if (SAFE_METHODS.has(req.method)) return true;
  if (req.path === ANALYTICS_SYNC_PATH) return true;
  return req.path.startsWith('/auth/');
};

const createRedisStore = (storePrefix) => {
  if (!redisClient.isReady) {
    if (config.redis?.required) {
      throw new Error(
        `Redis-backed rate limiting is required but Redis is not ready for ${storePrefix}`
      );
    }
    return null;
  }

  return new RedisStore({
    sendCommand: (...args) => redisClient.call(...args),
    prefix: storePrefix,
  });
};

const createRateLimiter = (
  windowMs,
  max,
  message,
  storePrefix = 'rl:',
  { keyGenerator = resolveRateLimitKey, skip = shouldSkipRateLimit } = {}
) => {
  const options = {
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res) => {
      let rateLimitKey = 'unknown';
      try {
        rateLimitKey = keyGenerator(req, res);
      } catch (_error) {
        rateLimitKey = 'unknown';
      }

      logger.warn('Rate limit exceeded', {
        path: req.originalUrl || req.path,
        method: req.method,
        rateLimitKey,
        limit: req.rateLimit?.limit,
        used: req.rateLimit?.used,
        remaining: req.rateLimit?.remaining,
        resetTime: req.rateLimit?.resetTime,
        ip: req.ip || req.socket?.remoteAddress || 'unknown',
      });

      return ApiResponse.error(res, {
        message: message || 'Too many requests. Please try again later.',
        errorCode: 'RATE_LIMITED',
        statusCode: 429,
      });
    },
    keyGenerator,
    skip,
  };

  const store = createRedisStore(storePrefix);
  if (store) {
    options.store = store;
  }

  return rateLimit(options);
};

const generalLimiter = createRateLimiter(
  getRateLimitSetting('windowMs', 15 * 60 * 1000),
  resolveGeneralRateLimitMax,
  'Too many requests. Please try again later.',
  'rl:general:',
  { skip: shouldSkipGeneralRateLimit }
);

const publicReadLimiter = createRateLimiter(
  15 * 60 * 1000,
  300,
  'Too many public requests. Please try again later.',
  'rl:public-read:',
  { keyGenerator: resolveIpRateLimitKey }
);

const analyticsSessionLimiter = createRateLimiter(
  60 * 60 * 1000,
  240,
  'Too many analytics sync requests. Please try again later.',
  'rl:analytics:',
  { keyGenerator: resolveAnalyticsRateLimitKey }
);

const authIpLimiter = createRateLimiter(
  15 * 60 * 1000,
  30,
  'Too many authentication attempts. Please try again in 15 minutes.',
  'rl:auth:',
  { keyGenerator: resolveIpRateLimitKey }
);

const authLoginIdentifierLimiter = createRateLimiter(
  15 * 60 * 1000,
  8,
  'Too many authentication attempts. Please try again in 15 minutes.',
  'rl:auth:login-id:',
  { keyGenerator: resolveLoginIdentifierRateLimitKey }
);

const registerIpLimiter = createRateLimiter(
  60 * 60 * 1000,
  10,
  'Too many registration attempts. Please try again later.',
  'rl:auth:register-ip:',
  { keyGenerator: resolveIpRateLimitKey }
);

const registerIdentifierLimiter = createRateLimiter(
  60 * 60 * 1000,
  3,
  'Too many registration attempts for this contact. Please try again later.',
  'rl:auth:register-id:',
  { keyGenerator: resolveRegisterIdentifierRateLimitKey }
);

const authSessionLimiter = createRateLimiter(
  15 * 60 * 1000,
  60,
  'Too many session requests. Please try again later.',
  'rl:auth:session:',
  { keyGenerator: resolveRefreshRateLimitKey }
);

const passwordLimiter = createRateLimiter(
  15 * 60 * 1000,
  10,
  'Too many password attempts. Please try again later.',
  'rl:auth:credential-change:',
  { keyGenerator: resolveRateLimitKey }
);

const uploadLimiter = createRateLimiter(
  60 * 60 * 1000,
  60,
  'Too many upload attempts. Please try again later.',
  'rl:upload:'
);

const publicBookingIpLimiter = createRateLimiter(
  60 * 60 * 1000,
  12,
  'Too many public booking attempts. Please try again later.',
  'rl:bookings:public-ip:',
  { keyGenerator: resolveIpRateLimitKey }
);

const publicBookingIdentifierLimiter = createRateLimiter(
  60 * 60 * 1000,
  4,
  'Too many public booking attempts for this requester. Please try again later.',
  'rl:bookings:public-id:',
  { keyGenerator: resolvePublicBookingIdentifierRateLimitKey }
);

const publicBookingUploadIpLimiter = createRateLimiter(
  60 * 60 * 1000,
  20,
  'Too many public booking upload attempts. Please try again later.',
  'rl:bookings:upload-ip:',
  { keyGenerator: resolveIpRateLimitKey }
);

const publicBookingUploadContextLimiter = createRateLimiter(
  60 * 60 * 1000,
  8,
  'Too many public booking upload attempts. Please try again later.',
  'rl:bookings:upload-context:',
  { keyGenerator: resolvePublicBookingUploadContextRateLimitKey }
);

const apiMutationLimiter = createRateLimiter(
  15 * 60 * 1000,
  600,
  'Too many API mutation requests. Please try again later.',
  'rl:api-mutations:',
  { keyGenerator: resolveRateLimitKey, skip: shouldSkipApiMutationRateLimit }
);

const chatMessageLimiter = createRateLimiter(
  60 * 1000,
  60,
  'Too many chat messages. Please slow down.',
  'rl:chat-messages:',
  { keyGenerator: resolveRateLimitKey }
);

const pushMutationLimiter = createRateLimiter(
  15 * 60 * 1000,
  30,
  'Too many push notification subscription requests. Please try again later.',
  'rl:push:',
  { keyGenerator: resolveRateLimitKey }
);

module.exports = {
  RATE_LIMIT_POLICIES,
  generalLimiter,
  publicReadLimiter,
  analyticsSessionLimiter,
  authLimiter: [authIpLimiter, authLoginIdentifierLimiter],
  authLoginLimiter: [authIpLimiter, authLoginIdentifierLimiter],
  registerLimiter: [registerIpLimiter, registerIdentifierLimiter],
  authSessionLimiter,
  passwordLimiter,
  uploadLimiter,
  publicBookingLimiter: [publicBookingIpLimiter, publicBookingIdentifierLimiter],
  publicBookingUploadLimiter: [
    publicBookingUploadIpLimiter,
    uploadLimiter,
  ],
  publicBookingUploadContextLimiter,
  apiMutationLimiter,
  chatMessageLimiter,
  pushMutationLimiter,
  createRateLimiter,
  resolveAuthenticatedRateLimitKey,
  resolveIpRateLimitKey,
  resolveLoginIdentifierRateLimitKey,
  resolvePublicBookingIdentifierRateLimitKey,
};
