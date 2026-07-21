/**
 * Daily AI usage quotas.
 *
 * Three independent ceilings, all of which must pass:
 *   - per user, per feature — stops one person consuming the budget;
 *   - per role             — stops a whole role class doing so;
 *   - per feature, system  — stops a runaway loop in one feature.
 *
 * Distinct from the rate limiter: `aiLimiter` bounds requests per hour to
 * protect latency, while quotas bound requests per day to protect cost. A
 * caller can be inside the rate limit and out of quota, and vice versa.
 */

const redisClient = require('../../../config/redis');
const logger = require('../../../utils/logger');
const { AI_QUOTAS } = require('../ai.constants');

const SECONDS_IN_DAY = 24 * 60 * 60;

function today() {
  return new Date().toISOString().slice(0, 10);
}

function userKey(userId, feature) {
  return `ai:quota:user:${userId}:${feature}:${today()}`;
}

function roleKey(role) {
  return `ai:quota:role:${role}:${today()}`;
}

function featureKey(feature) {
  return `ai:quota:feature:${feature}:${today()}`;
}

async function readCount(key) {
  try {
    return Number(await redisClient.get(key)) || 0;
  } catch (error) {
    logger.warn('Failed to read AI quota counter', { reason: error.message });
    return 0;
  }
}

/**
 * Check all three ceilings without consuming any.
 *
 * @returns {Promise<{allowed: boolean, scope?: string, limit?: number, used?: number}>}
 */
async function checkQuota({ userId, role, feature }) {
  const userLimit = AI_QUOTAS.perUser[feature];
  const roleLimit = AI_QUOTAS.perRole[role];
  const featureLimit = AI_QUOTAS.perFeature[feature];

  // A role with no entry gets no allowance. Failing closed means adding a new
  // role does not silently grant it unlimited AI usage.
  if (roleLimit === undefined || roleLimit <= 0) {
    return { allowed: false, scope: 'role', limit: roleLimit || 0, used: 0 };
  }

  const [userUsed, roleUsed, featureUsed] = await Promise.all([
    readCount(userKey(userId, feature)),
    readCount(roleKey(role)),
    readCount(featureKey(feature)),
  ]);

  if (userLimit !== undefined && userUsed >= userLimit) {
    return { allowed: false, scope: 'user', limit: userLimit, used: userUsed };
  }
  if (roleUsed >= roleLimit) {
    return { allowed: false, scope: 'role', limit: roleLimit, used: roleUsed };
  }
  if (featureLimit !== undefined && featureUsed >= featureLimit) {
    return { allowed: false, scope: 'feature', limit: featureLimit, used: featureUsed };
  }

  return { allowed: true };
}

/**
 * Consume one unit against all three counters.
 *
 * Called only after a provider call is actually attempted, so a request
 * rejected by a flag, the redaction gate, or the rate limiter does not burn
 * someone's daily allowance.
 */
async function consumeQuota({ userId, role, feature }) {
  const keys = [userKey(userId, feature), roleKey(role), featureKey(feature)];

  try {
    await Promise.all(
      keys.map(async (key) => {
        const value = await redisClient.incr(key);
        // Set the TTL only when creating the key, so the daily window is
        // anchored to first use rather than sliding forward on every call.
        if (value === 1) await redisClient.expire(key, SECONDS_IN_DAY);
      })
    );
  } catch (error) {
    logger.warn('Failed to consume AI quota', { reason: error.message });
  }
}

/** Current usage, for a "N of M remaining today" display. */
async function getUsage({ userId, role, feature }) {
  const [userUsed, roleUsed, featureUsed] = await Promise.all([
    readCount(userKey(userId, feature)),
    readCount(roleKey(role)),
    readCount(featureKey(feature)),
  ]);

  return {
    user: { used: userUsed, limit: AI_QUOTAS.perUser[feature] ?? null },
    role: { used: roleUsed, limit: AI_QUOTAS.perRole[role] ?? 0 },
    feature: { used: featureUsed, limit: AI_QUOTAS.perFeature[feature] ?? null },
  };
}

module.exports = { checkQuota, consumeQuota, getUsage, userKey, roleKey, featureKey };
