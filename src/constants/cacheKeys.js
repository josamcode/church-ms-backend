const CACHE_KEYS = Object.freeze({
  USER_PROFILE: (id) => `user:profile:${id}`,
  USER_PERMISSIONS: (id) => `user:permissions:${id}`,
  REFRESH_TOKEN: (hash) => `auth:refresh:${hash}`,
  TOKEN_BLACKLIST: (jti) => `auth:blacklist:${jti}`,
});

const CACHE_TTL = Object.freeze({
  USER_PROFILE: 3600,
  USER_PERMISSIONS: 1800,
  REFRESH_TOKEN: 7 * 24 * 3600,
  TOKEN_BLACKLIST: 900,
});

module.exports = { CACHE_KEYS, CACHE_TTL };
