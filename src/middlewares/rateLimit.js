const rateLimit = require('express-rate-limit');
const RedisStore = require('rate-limit-redis').default;
const jwt = require('jsonwebtoken');
const redisClient = require('../config/redis');
const ApiResponse = require('../utils/apiResponse');
const config = require('../config/env');
const logger = require('../utils/logger');

const HEALTH_CHECK_PATH = '/health';
const ANALYTICS_SYNC_PATH = '/system-analytics/sessions/sync';

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

const resolveAnalyticsRateLimitKey = (req) => {
  const authenticatedKey = resolveAuthenticatedRateLimitKey(req);
  if (authenticatedKey) {
    return authenticatedKey;
  }

  const sessionId = String(req.body?.sessionId || '').trim();
  if (sessionId) {
    return `analytics-session:${sessionId}`;
  }

  return resolveIpRateLimitKey(req);
};

const shouldSkipRateLimit = (req) => req.method === 'OPTIONS';

const shouldSkipGeneralRateLimit = (req) =>
  shouldSkipRateLimit(req) ||
  req.path === HEALTH_CHECK_PATH ||
  req.path === ANALYTICS_SYNC_PATH;

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
        ip: req.ip || req.socket?.remoteAddress || 'unknown',
        forwardedFor: req.get('x-forwarded-for') || '',
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

  if (redisClient.isReady) {
    try {
      options.store = new RedisStore({
        sendCommand: (...args) => redisClient.call(...args),
        prefix: storePrefix,
      });
    } catch (_error) {
      // Fall back to in-memory rate limiting when Redis-backed storage is unavailable.
    }
  }

  return rateLimit(options);
};

const generalLimiter = createRateLimiter(
  config.rateLimit.windowMs,
  config.rateLimit.max,
  'Too many requests. Please try again later.',
  'rl:general:',
  { skip: shouldSkipGeneralRateLimit }
);

const analyticsSessionLimiter = createRateLimiter(
  60 * 60 * 1000,
  240,
  'Too many analytics sync requests. Please try again later.',
  'rl:analytics:',
  { keyGenerator: resolveAnalyticsRateLimitKey }
);

const authLimiter = createRateLimiter(
  15 * 60 * 1000,
  20,
  'Too many authentication attempts. Please try again in 15 minutes.',
  'rl:auth:',
  { keyGenerator: resolveIpRateLimitKey }
);

const uploadLimiter = createRateLimiter(
  60 * 60 * 1000,
  30,
  'Too many upload attempts. Please try again later.',
  'rl:upload:'
);

const publicBookingLimiter = createRateLimiter(
  60 * 60 * 1000,
  12,
  'Too many public booking attempts. Please try again later.',
  'rl:bookings:public:'
);

module.exports = {
  generalLimiter,
  analyticsSessionLimiter,
  authLimiter,
  uploadLimiter,
  publicBookingLimiter,
  createRateLimiter,
};
