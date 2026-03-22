const Redis = require('ioredis');
const config = require('./env');
const logger = require('../utils/logger');

const createFallbackClient = () => {
  const store = new Map();

  const cleanup = (key) => {
    const entry = store.get(String(key));
    if (entry?.expiresAt && entry.expiresAt <= Date.now()) {
      store.delete(String(key));
      return null;
    }
    return entry || null;
  };

  return {
    status: 'fallback',
    isFallback: true,
    on: () => undefined,
    async get(key) {
      return cleanup(key)?.value ?? null;
    },
    async set(key, value) {
      store.set(String(key), { value: String(value), expiresAt: null });
      return 'OK';
    },
    async setex(key, seconds, value) {
      store.set(String(key), {
        value: String(value),
        expiresAt: Date.now() + Number(seconds || 0) * 1000,
      });
      return 'OK';
    },
    async del(...keys) {
      return keys.flat().reduce((count, key) => {
        if (store.delete(String(key))) {
          return count + 1;
        }
        return count;
      }, 0);
    },
    async ping() {
      return 'PONG';
    },
    async call(command, ...args) {
      const normalized = String(command || '').trim().toLowerCase();
      if (normalized === 'get') return this.get(args[0]);
      if (normalized === 'set') return this.set(args[0], args[1]);
      if (normalized === 'setex') return this.setex(args[0], args[1], args[2]);
      if (normalized === 'del') return this.del(...args);
      if (normalized === 'ping') return this.ping();
      return null;
    },
  };
};

const redisEnabled = config.redis.enabled && (config.redis.url || config.redis.host);
let currentClient = createFallbackClient();
let preferredClient = currentClient;
let connectPromise = null;

const swapClient = (nextClient) => {
  currentClient = nextClient;
  return currentClient;
};

const createRedisClient = () => {
  const options = {
    password: config.redis.password || undefined,
    maxRetriesPerRequest: 1,
    retryStrategy: (times) => {
      if (times > 5) {
        logger.error('Redis exceeded reconnect retry budget');
        return null;
      }
      return Math.min(times * 250, 2000);
    },
    enableOfflineQueue: false,
    lazyConnect: true,
  };

  const client = config.redis.url
    ? new Redis(config.redis.url, options)
    : new Redis({
      host: config.redis.host,
      port: config.redis.port,
      ...options,
    });

  client.isFallback = false;
  client.on('connect', () => logger.info('Redis connected'));
  client.on('ready', () => logger.info('Redis ready'));
  client.on('error', (err) => logger.error(`Redis error: ${err.message}`));
  client.on('close', () => logger.warn('Redis connection closed'));
  client.on('reconnecting', () => logger.info('Redis reconnecting...'));
  return client;
};

if (!redisEnabled) {
  if (config.redis.required) {
    throw new Error('Redis is required but no Redis connection settings were provided.');
  }
  logger.warn('Redis is disabled, using in-memory fallback for non-production use');
} else {
  preferredClient = createRedisClient();

  if (config.redis.required) {
    swapClient(preferredClient);
  } else {
    logger.warn('Redis is optional; using in-memory fallback until Redis becomes ready');
  }
}

const redisClient = {
  get status() {
    return currentClient.status;
  },
  get isFallback() {
    return Boolean(currentClient.isFallback);
  },
  get isRequired() {
    return Boolean(config.redis.required);
  },
  on(...args) {
    if (typeof currentClient.on === 'function') {
      return currentClient.on(...args);
    }
    return undefined;
  },
  get(...args) {
    return currentClient.get(...args);
  },
  set(...args) {
    return currentClient.set(...args);
  },
  setex(...args) {
    return currentClient.setex(...args);
  },
  del(...args) {
    return currentClient.del(...args);
  },
  call(...args) {
    if (typeof currentClient.call === 'function') {
      return currentClient.call(...args);
    }
    return null;
  },
  ping(...args) {
    if (typeof currentClient.ping === 'function') {
      return currentClient.ping(...args);
    }
    return Promise.resolve('PONG');
  },
};

const ensureRedisReady = async () => {
  if (!redisEnabled) {
    return;
  }

  if (preferredClient.status === 'ready') {
    swapClient(preferredClient);
    await preferredClient.ping();
    return;
  }

  if (!connectPromise) {
    connectPromise = preferredClient.connect()
      .then(async () => {
        await preferredClient.ping();
        swapClient(preferredClient);
      })
      .catch((error) => {
        connectPromise = null;
        if (config.redis.required) {
          throw error;
        }

        logger.warn(`Redis unavailable, falling back to in-memory store: ${error.message}`);
        swapClient(createFallbackClient());
      });
  }

  await Promise.race([
    connectPromise,
    new Promise((_, reject) => {
      setTimeout(() => {
        reject(new Error('Redis readiness check timed out'));
      }, config.redis.readyTimeoutMs);
    }),
  ]);
};

redisClient.ensureRedisReady = ensureRedisReady;

module.exports = redisClient;
