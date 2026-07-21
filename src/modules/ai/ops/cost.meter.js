/**
 * Token cost estimation and spend tracking.
 *
 * Costs are *estimates*. Providers are billed on their own tokenizer, and
 * newer models can produce meaningfully more tokens for the same text, so
 * these figures drive budget alarms and kill switches — they are not an
 * accounting record.
 */

const redisClient = require('../../../config/redis');
const logger = require('../../../utils/logger');
const config = require('../../../config/env');
const { getModelEntry } = require('../routing/model.registry');

const PER_MILLION = 1000000;

/**
 * Estimate the USD cost of one call.
 *
 * @param {string} modelKey  registry key, e.g. 'anthropic:sonnet-5'
 * @param {{inputTokens?: number, outputTokens?: number, cachedInputTokens?: number}} usage
 * @returns {number} cost in USD
 */
function estimateCostUsd(modelKey, usage = {}) {
  const entry = getModelEntry(modelKey);
  if (!entry) return 0;

  const inputTokens = Math.max(Number(usage.inputTokens) || 0, 0);
  const outputTokens = Math.max(Number(usage.outputTokens) || 0, 0);
  const cachedInputTokens = Math.max(Number(usage.cachedInputTokens) || 0, 0);

  // Cached tokens are billed at the cached rate; only the remainder is fresh.
  const freshInputTokens = Math.max(inputTokens - cachedInputTokens, 0);

  let cost =
    (freshInputTokens / PER_MILLION) * entry.pricing.input
    + (cachedInputTokens / PER_MILLION) * entry.pricing.cachedInput
    + (outputTokens / PER_MILLION) * entry.pricing.output;

  // Long-context surcharge, where the provider applies one.
  if (entry.longContextSurchargeAbove && inputTokens > entry.longContextSurchargeAbove) {
    cost =
      (freshInputTokens / PER_MILLION) * entry.pricing.input * 2
      + (cachedInputTokens / PER_MILLION) * entry.pricing.cachedInput * 2
      + (outputTokens / PER_MILLION) * entry.pricing.output * 1.5;
  }

  return Number(cost.toFixed(6));
}

function dayKey(date = new Date()) {
  return `ai:spend:day:${date.toISOString().slice(0, 10)}`;
}

function monthKey(date = new Date()) {
  return `ai:spend:month:${date.toISOString().slice(0, 7)}`;
}

/**
 * Add a completed call's cost to the running daily and monthly totals.
 * Failures are logged and swallowed: metering must not break a served request.
 */
async function recordSpend(costUsd) {
  const amount = Number(costUsd) || 0;
  if (amount <= 0) return;

  try {
    // Stored in micro-dollars so Redis integer counters stay exact.
    const micros = Math.round(amount * 1000000);
    const day = dayKey();
    const month = monthKey();

    await redisClient.incrby(day, micros);
    await redisClient.expire(day, 3 * 24 * 60 * 60);
    await redisClient.incrby(month, micros);
    await redisClient.expire(month, 40 * 24 * 60 * 60);
  } catch (error) {
    logger.warn('Failed to record AI spend', { reason: error.message });
  }
}

async function readSpend(key) {
  try {
    const raw = await redisClient.get(key);
    return (Number(raw) || 0) / 1000000;
  } catch (error) {
    logger.warn('Failed to read AI spend', { reason: error.message });
    return 0;
  }
}

async function getSpend() {
  const [daily, monthly] = await Promise.all([
    readSpend(dayKey()),
    readSpend(monthKey()),
  ]);
  return { dailyUsd: daily, monthlyUsd: monthly };
}

/**
 * Hard spend ceiling.
 *
 * Returns the reason when over budget so the caller can audit and surface it.
 * A read failure returns "within budget" on purpose: an unavailable meter
 * should degrade to the rate limiter and quotas rather than take the feature
 * down, and both of those remain in force.
 */
async function checkSpendLimits() {
  const { dailyUsd, monthlyUsd } = await getSpend();
  const limits = config.ai.limits;

  if (monthlyUsd >= limits.monthlySpendUsd) {
    return {
      withinBudget: false,
      reason: 'monthly_spend_cap_reached',
      dailyUsd,
      monthlyUsd,
    };
  }
  if (dailyUsd >= limits.dailySpendUsd) {
    return {
      withinBudget: false,
      reason: 'daily_spend_cap_reached',
      dailyUsd,
      monthlyUsd,
    };
  }

  return { withinBudget: true, dailyUsd, monthlyUsd };
}

/** Fraction of each budget consumed, for the 80% warning. */
async function getBudgetUtilization() {
  const { dailyUsd, monthlyUsd } = await getSpend();
  return {
    daily: dailyUsd / config.ai.limits.dailySpendUsd,
    monthly: monthlyUsd / config.ai.limits.monthlySpendUsd,
  };
}

module.exports = {
  estimateCostUsd,
  recordSpend,
  getSpend,
  checkSpendLimits,
  getBudgetUtilization,
  dayKey,
  monthKey,
};
