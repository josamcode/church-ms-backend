const rateLimit = require('express-rate-limit');
const RedisStore = require('rate-limit-redis').default;
const redisClient = require('../config/redis');
const ApiResponse = require('../utils/apiResponse');
const config = require('../config/env');

const createRateLimiter = (windowMs, max, message, storePrefix = 'rl:') => {
  const options = {
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res) => {
      return ApiResponse.error(res, {
        message: message || 'تم تجاوز الحد المسموح به من الطلبات. يرجى المحاولة لاحقاً',
        errorCode: 'RATE_LIMITED',
        statusCode: 429,
      });
    },
    keyGenerator: (req) => {
      return req.ip || req.headers['x-forwarded-for'] || 'unknown';
    },
  };

  if (redisClient.status !== 'fallback') {
    try {
      options.store = new RedisStore({
        sendCommand: (...args) => redisClient.call(...args),
        prefix: storePrefix,
      });
    } catch (err) {
      // Fallback to memory store
    }
  }

  return rateLimit(options);
};

const generalLimiter = createRateLimiter(
  config.rateLimit.windowMs,
  config.rateLimit.max,
  'تم تجاوز الحد المسموح به من الطلبات. يرجى المحاولة لاحقاً',
  'rl:general:'
);

const authLimiter = createRateLimiter(
  15 * 60 * 1000,
  20,
  'تم تجاوز عدد محاولات تسجيل الدخول. يرجى المحاولة بعد 15 دقيقة',
  'rl:auth:'
);

const uploadLimiter = createRateLimiter(
  60 * 60 * 1000,
  30,
  'تم تجاوز الحد المسموح لرفع الملفات. يرجى المحاولة لاحقاً',
  'rl:upload:'
);

module.exports = { generalLimiter, authLimiter, uploadLimiter, createRateLimiter };
