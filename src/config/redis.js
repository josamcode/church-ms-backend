const Redis = require('ioredis');
const config = require('./env');
const logger = require('../utils/logger');

let redisClient;

const createFallbackClient = () => ({
  get: async () => null,
  set: async () => 'OK',
  setex: async () => 'OK',
  del: async () => 0,
  call: async () => null,
  status: 'fallback',
});

const redisEnabled = config.redis.enabled && (config.redis.url || config.redis.host);

if (!redisEnabled) {
  logger.warn('Redis: disabled (no REDIS_URL/REDIS_HOST)');
  redisClient = createFallbackClient();
} else {
  try {
    const options = {
      password: config.redis.password || undefined,
      maxRetriesPerRequest: 3,
      retryStrategy: (times) => {
        if (times > 10) {
          logger.error('Redis: طھظ… طھط¬ط§ظˆط² ط§ظ„ط­ط¯ ط§ظ„ط£ظ‚طµظ‰ ظ„ظ…ط­ط§ظˆظ„ط§طھ ط¥ط¹ط§ط¯ط© ط§ظ„ط§طھطµط§ظ„');
          return null;
        }
        return Math.min(times * 200, 2000);
      },
      enableOfflineQueue: true,
      lazyConnect: false,
    };

    redisClient = config.redis.url
      ? new Redis(config.redis.url, options)
      : new Redis({
          host: config.redis.host,
          port: config.redis.port,
          ...options,
        });

    redisClient.on('connect', () => logger.info('Redis ظ…طھطµظ„'));
    redisClient.on('error', (err) => logger.error(`ط®ط·ط£ Redis: ${err.message}`));
    redisClient.on('close', () => logger.warn('Redis: طھظ… ط¥ط؛ظ„ط§ظ‚ ط§ظ„ط§طھطµط§ظ„'));
    redisClient.on('reconnecting', () => logger.info('Redis: ط¥ط¹ط§ط¯ط© ط§ظ„ط§طھطµط§ظ„...'));
  } catch (err) {
    logger.error(`ظپط´ظ„ ط¥ظ†ط´ط§ط، ط§طھطµط§ظ„ Redis: ${err.message}`);
    redisClient = createFallbackClient();
  }
}

module.exports = redisClient;
