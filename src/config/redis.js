const Redis = require('ioredis');
const config = require('./env');
const logger = require('../utils/logger');

let redisClient;

try {
  redisClient = new Redis({
    host: config.redis.host,
    port: config.redis.port,
    password: config.redis.password || undefined,
    maxRetriesPerRequest: 3,
    retryStrategy: (times) => {
      if (times > 10) {
        logger.error('Redis: تم تجاوز الحد الأقصى لمحاولات إعادة الاتصال');
        return null;
      }
      return Math.min(times * 200, 2000);
    },
    enableOfflineQueue: true,
    lazyConnect: false,
  });

  redisClient.on('connect', () => logger.info('Redis متصل'));
  redisClient.on('error', (err) => logger.error(`خطأ Redis: ${err.message}`));
  redisClient.on('close', () => logger.warn('Redis: تم إغلاق الاتصال'));
  redisClient.on('reconnecting', () => logger.info('Redis: إعادة الاتصال...'));
} catch (err) {
  logger.error(`فشل إنشاء اتصال Redis: ${err.message}`);
  redisClient = {
    get: async () => null,
    set: async () => 'OK',
    setex: async () => 'OK',
    del: async () => 0,
    call: async () => null,
    status: 'fallback',
  };
}

module.exports = redisClient;
