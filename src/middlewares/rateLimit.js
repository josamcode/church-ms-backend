const rateLimit = require('express-rate-limit');
const RedisStore = require('rate-limit-redis').default;
const jwt = require('jsonwebtoken');
const redisClient = require('../config/redis');
const ApiResponse = require('../utils/apiResponse');
const config = require('../config/env');

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

const shouldSkipRateLimit = (req) =>
  req.method === 'OPTIONS' || req.path === '/health';

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
    handler: (_req, res) => {
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
  'rl:general:'
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
  authLimiter,
  uploadLimiter,
  publicBookingLimiter,
  createRateLimiter,
};
