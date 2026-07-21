/**
 * Rolling per-provider health metrics.
 *
 * Feeds the routing decision (prefer a healthy provider) and the operational
 * dashboard. Keeps a bounded in-memory window — this is a health signal, not
 * an analytics store; the durable record is `aiUsage`.
 */

const WINDOW_SIZE = 50;

const health = new Map();

function getRecord(provider) {
  if (!health.has(provider)) {
    health.set(provider, {
      provider,
      outcomes: [], // booleans, newest last
      totalCalls: 0,
      totalFailures: 0,
      latencies: [],
      lastErrorCategory: null,
      lastCallAt: null,
    });
  }
  return health.get(provider);
}

function push(list, value, max = WINDOW_SIZE) {
  list.push(value);
  if (list.length > max) list.shift();
}

function recordCall(provider, { success, latencyMs, errorCategory = null }) {
  const record = getRecord(provider);

  record.totalCalls += 1;
  if (!success) {
    record.totalFailures += 1;
    record.lastErrorCategory = errorCategory;
  }
  record.lastCallAt = new Date();

  push(record.outcomes, Boolean(success));
  if (Number.isFinite(latencyMs)) push(record.latencies, latencyMs);
}

function percentile(sorted, fraction) {
  if (sorted.length === 0) return 0;
  const index = Math.min(Math.floor(sorted.length * fraction), sorted.length - 1);
  return sorted[index];
}

/**
 * Health summary over the rolling window.
 * An unused provider reports healthy — absence of evidence is not a fault.
 */
function getHealth(provider) {
  const record = getRecord(provider);
  const windowCalls = record.outcomes.length;

  if (windowCalls === 0) {
    return {
      provider,
      healthy: true,
      errorRate: 0,
      p95LatencyMs: 0,
      windowCalls: 0,
      totalCalls: record.totalCalls,
      lastErrorCategory: record.lastErrorCategory,
    };
  }

  const failures = record.outcomes.filter((ok) => !ok).length;
  const errorRate = failures / windowCalls;
  const sortedLatencies = [...record.latencies].sort((a, b) => a - b);

  return {
    provider,
    // Matches the alerting threshold: error rate above 20% is unhealthy.
    healthy: errorRate <= 0.2,
    errorRate: Number(errorRate.toFixed(3)),
    p95LatencyMs: percentile(sortedLatencies, 0.95),
    windowCalls,
    totalCalls: record.totalCalls,
    totalFailures: record.totalFailures,
    lastErrorCategory: record.lastErrorCategory,
    lastCallAt: record.lastCallAt,
  };
}

function isHealthy(provider) {
  return getHealth(provider).healthy;
}

function describeAll() {
  return [...health.keys()].map((provider) => getHealth(provider));
}

/** Test hook. */
function reset() {
  health.clear();
}

module.exports = { recordCall, getHealth, isHealthy, describeAll, reset };
