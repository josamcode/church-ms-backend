const rateLimit = require('express-rate-limit');
const RedisStore = require('rate-limit-redis').default;
const redisClient = require('../config/redis');
const ApiResponse = require('../utils/apiResponse');
const config = require('../config/env');

const resolveRateLimitKey = (req) => {
  const forwardedFor = req.headers['x-forwarded-for'];
  if (typeof forwardedFor === 'string' && forwardedFor.trim()) {
    return forwardedFor.split(',')[0].trim();
  }

  return req.ip || req.socket?.remoteAddress || 'unknown';
};

const createRateLimiter = (windowMs, max, message, storePrefix = 'rl:') => {
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
    keyGenerator: resolveRateLimitKey,
  };

  if (!redisClient.isFallback) {
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
  'rl:auth:'
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
