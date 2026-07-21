/**
 * Operational controls: quotas, spend ceilings, kill switches, circuit breaker.
 */

const mockConfig = {
  env: 'test',
  isProduction: false,
  ai: {
    enabled: true,
    features: { notificationDraft: true, analyticsNarrative: true, importAmbiguity: true },
    providers: {
      anthropic: { enabled: true, apiKey: 'test-key', baseUrl: 'https://x', version: '2023-06-01' },
      openai: { enabled: true, apiKey: 'test-key', baseUrl: 'https://x' },
      gemini: { enabled: false, apiKey: '', billingAccountVerified: false },
    },
    limits: { requestTimeoutMs: 1000, maxRetries: 1, dailySpendUsd: 5, monthlySpendUsd: 100 },
    circuitBreaker: { failureThreshold: 3, resetTimeoutMs: 50 },
  },
};

jest.mock('../../src/config/env', () => mockConfig);
jest.mock('../../src/utils/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

// In-memory Redis stand-in.
const mockStore = new Map();
jest.mock('../../src/config/redis', () => ({
  isReady: true,
  get: jest.fn(async (key) => (mockStore.has(key) ? String(mockStore.get(key)) : null)),
  incr: jest.fn(async (key) => {
    const next = (Number(mockStore.get(key)) || 0) + 1;
    mockStore.set(key, next);
    return next;
  }),
  incrby: jest.fn(async (key, amount) => {
    const next = (Number(mockStore.get(key)) || 0) + Number(amount);
    mockStore.set(key, next);
    return next;
  }),
  expire: jest.fn(async () => 1),
}));

const quotaService = require('../../src/modules/ai/ops/quota.service');
const costMeter = require('../../src/modules/ai/ops/cost.meter');
const featureFlags = require('../../src/modules/ai/ops/featureFlags');
const circuitBreaker = require('../../src/modules/ai/ops/circuitBreaker');
const providerHealth = require('../../src/modules/ai/ops/providerHealth');
const { AI_FEATURES, AI_QUOTAS } = require('../../src/modules/ai/ai.constants');

const FEATURE = AI_FEATURES.NOTIFICATION_DRAFT;

beforeEach(() => {
  mockStore.clear();
  circuitBreaker.reset();
  providerHealth.reset();
  mockConfig.ai.enabled = true;
  mockConfig.ai.features.notificationDraft = true;
  mockConfig.ai.providers.gemini.enabled = false;
  mockConfig.ai.providers.gemini.billingAccountVerified = false;
});

describe('quotas', () => {
  const actor = { userId: 'u1', role: 'ADMIN', feature: FEATURE };

  it('allows a first request', async () => {
    expect(await quotaService.checkQuota(actor)).toEqual({ allowed: true });
  });

  it('blocks once the per-user daily limit is reached', async () => {
    const limit = AI_QUOTAS.perUser[FEATURE];
    for (let i = 0; i < limit; i += 1) {
      await quotaService.consumeQuota({ ...actor, role: 'SUPER_ADMIN' });
    }
    const result = await quotaService.checkQuota({ ...actor, role: 'SUPER_ADMIN' });
    expect(result).toMatchObject({ allowed: false, scope: 'user', limit });
  });

  it('blocks once the per-role daily limit is reached', async () => {
    mockStore.set(quotaService.roleKey('ADMIN'), AI_QUOTAS.perRole.ADMIN);
    const result = await quotaService.checkQuota(actor);
    expect(result).toMatchObject({ allowed: false, scope: 'role' });
  });

  it('blocks once the system-wide feature limit is reached', async () => {
    mockStore.set(quotaService.featureKey(FEATURE), AI_QUOTAS.perFeature[FEATURE]);
    const result = await quotaService.checkQuota(actor);
    expect(result).toMatchObject({ allowed: false, scope: 'feature' });
  });

  // Failing closed means adding a role later cannot silently grant unlimited AI.
  it('denies a role with no configured allowance', async () => {
    const result = await quotaService.checkQuota({ ...actor, role: 'USER' });
    expect(result.allowed).toBe(false);
    expect(result.scope).toBe('role');
  });

  it('denies an unknown role', async () => {
    const result = await quotaService.checkQuota({ ...actor, role: 'VOLUNTEER' });
    expect(result.allowed).toBe(false);
  });

  it('increments all three counters on consume', async () => {
    await quotaService.consumeQuota(actor);
    const usage = await quotaService.getUsage(actor);
    expect(usage.user.used).toBe(1);
    expect(usage.role.used).toBe(1);
    expect(usage.feature.used).toBe(1);
  });

  it('tracks each feature separately for the same user', async () => {
    await quotaService.consumeQuota(actor);
    const other = await quotaService.getUsage({
      ...actor, feature: AI_FEATURES.ANALYTICS_NARRATIVE,
    });
    expect(other.user.used).toBe(0);
  });

  it('keys quotas by day', async () => {
    const today = new Date().toISOString().slice(0, 10);
    expect(quotaService.userKey('u1', FEATURE)).toContain(today);
  });
});

describe('cost metering', () => {
  it('estimates cost from the registry prices', () => {
    // 1M input + 1M output on Sonnet at 2.00 / 10.00.
    const cost = costMeter.estimateCostUsd('anthropic:sonnet-5', {
      inputTokens: 1000000, outputTokens: 1000000,
    });
    expect(cost).toBeCloseTo(12.0, 5);
  });

  it('bills cached input at the cached rate', () => {
    const cached = costMeter.estimateCostUsd('anthropic:sonnet-5', {
      inputTokens: 1000000, cachedInputTokens: 1000000, outputTokens: 0,
    });
    expect(cached).toBeCloseTo(0.2, 5);
  });

  it('returns zero for an unknown model rather than guessing', () => {
    expect(costMeter.estimateCostUsd('nope:nope', { inputTokens: 1000 })).toBe(0);
  });

  it('treats negative or missing token counts as zero', () => {
    expect(costMeter.estimateCostUsd('anthropic:sonnet-5', {})).toBe(0);
    expect(costMeter.estimateCostUsd('anthropic:sonnet-5', { inputTokens: -5 })).toBe(0);
  });

  it('applies the long-context surcharge above the threshold', () => {
    const under = costMeter.estimateCostUsd('openai:main', { inputTokens: 200000, outputTokens: 0 });
    const over = costMeter.estimateCostUsd('openai:main', { inputTokens: 300000, outputTokens: 0 });
    expect(over / 300000).toBeGreaterThan(under / 200000);
  });

  it('accumulates spend and reports it', async () => {
    await costMeter.recordSpend(1.5);
    await costMeter.recordSpend(0.75);
    const spend = await costMeter.getSpend();
    expect(spend.dailyUsd).toBeCloseTo(2.25, 5);
    expect(spend.monthlyUsd).toBeCloseTo(2.25, 5);
  });

  it('reports within budget under the ceiling', async () => {
    await costMeter.recordSpend(1);
    expect((await costMeter.checkSpendLimits()).withinBudget).toBe(true);
  });

  it('trips the daily ceiling', async () => {
    await costMeter.recordSpend(5);
    const result = await costMeter.checkSpendLimits();
    expect(result).toMatchObject({ withinBudget: false, reason: 'daily_spend_cap_reached' });
  });

  it('trips the monthly ceiling and reports it ahead of the daily one', async () => {
    mockStore.set(costMeter.monthKey(), 100 * 1000000);
    mockStore.set(costMeter.dayKey(), 100 * 1000000);
    const result = await costMeter.checkSpendLimits();
    expect(result.reason).toBe('monthly_spend_cap_reached');
  });

  it('reports budget utilization for the 80% warning', async () => {
    await costMeter.recordSpend(4);
    const utilization = await costMeter.getBudgetUtilization();
    expect(utilization.daily).toBeCloseTo(0.8, 2);
  });
});

describe('kill switches', () => {
  it('reports AI enabled when the master switch is on', () => {
    expect(featureFlags.isAiEnabled()).toBe(true);
    expect(featureFlags.isFeatureEnabled(FEATURE)).toBe(true);
  });

  // The property that makes the kill switch a kill switch.
  it('disables every feature when the master switch is off', () => {
    mockConfig.ai.enabled = false;
    expect(featureFlags.isAiEnabled()).toBe(false);
    for (const feature of Object.values(AI_FEATURES)) {
      expect(featureFlags.isFeatureEnabled(feature)).toBe(false);
    }
  });

  it('disables one feature without touching the others', () => {
    mockConfig.ai.features.notificationDraft = false;
    expect(featureFlags.isFeatureEnabled(FEATURE)).toBe(false);
    expect(featureFlags.isFeatureEnabled(AI_FEATURES.ANALYTICS_NARRATIVE)).toBe(true);
  });

  it('treats an unknown feature key as disabled', () => {
    expect(featureFlags.isFeatureEnabled('made_up_feature')).toBe(false);
  });

  // Read at call time, not cached at import: a flag flip takes effect on the
  // next request rather than the next deploy.
  it('reflects a config change without re-importing the module', () => {
    expect(featureFlags.isAiEnabled()).toBe(true);
    mockConfig.ai.enabled = false;
    expect(featureFlags.isAiEnabled()).toBe(false);
    mockConfig.ai.enabled = true;
    expect(featureFlags.isAiEnabled()).toBe(true);
  });
});

describe('provider enablement', () => {
  it('enables a configured provider', () => {
    expect(featureFlags.isProviderEnabled('anthropic')).toBe(true);
  });

  it('disables a provider with no API key', () => {
    const original = mockConfig.ai.providers.openai.apiKey;
    mockConfig.ai.providers.openai.apiKey = '';
    expect(featureFlags.isProviderEnabled('openai')).toBe(false);
    mockConfig.ai.providers.openai.apiKey = original;
  });

  it('keeps gemini disabled by default', () => {
    expect(featureFlags.isProviderEnabled('gemini')).toBe(false);
  });

  // The two-key rule: a key alone is not enough, because the unpaid tier is
  // exactly the configuration whose data terms are unacceptable.
  it('keeps gemini disabled even with a key, until billing is verified', () => {
    mockConfig.ai.providers.gemini.enabled = true;
    mockConfig.ai.providers.gemini.apiKey = 'test-key';
    mockConfig.ai.providers.gemini.billingAccountVerified = false;
    expect(featureFlags.isProviderEnabled('gemini')).toBe(false);

    mockConfig.ai.providers.gemini.billingAccountVerified = true;
    expect(featureFlags.isProviderEnabled('gemini')).toBe(true);
  });

  it('never reports deepseek as an enabled provider', () => {
    expect(featureFlags.enabledProviders()).not.toContain('deepseek');
    expect(featureFlags.isProviderEnabled('deepseek')).toBe(false);
  });

  it('exposes no secrets in the flag snapshot', () => {
    const snapshot = JSON.stringify(featureFlags.describeFlags());
    expect(snapshot).not.toContain('test-key');
  });
});

describe('circuit breaker', () => {
  it('starts closed', () => {
    expect(circuitBreaker.canAttempt('anthropic')).toBe(true);
    expect(circuitBreaker.getState('anthropic').state).toBe('closed');
  });

  it('opens after the configured number of consecutive failures', () => {
    for (let i = 0; i < 3; i += 1) circuitBreaker.recordFailure('anthropic', 'server_error');
    expect(circuitBreaker.getState('anthropic').state).toBe('open');
    expect(circuitBreaker.canAttempt('anthropic')).toBe(false);
  });

  it('stays closed when successes interrupt the failure run', () => {
    circuitBreaker.recordFailure('anthropic', 'timeout');
    circuitBreaker.recordFailure('anthropic', 'timeout');
    circuitBreaker.recordSuccess('anthropic');
    circuitBreaker.recordFailure('anthropic', 'timeout');
    expect(circuitBreaker.getState('anthropic').state).toBe('closed');
  });

  it('half-opens after the cooldown and closes on a successful probe', async () => {
    for (let i = 0; i < 3; i += 1) circuitBreaker.recordFailure('anthropic', 'server_error');
    expect(circuitBreaker.canAttempt('anthropic')).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(circuitBreaker.canAttempt('anthropic')).toBe(true);
    expect(circuitBreaker.getState('anthropic').state).toBe('half_open');

    circuitBreaker.recordSuccess('anthropic');
    expect(circuitBreaker.getState('anthropic').state).toBe('closed');
  });

  // A failed probe means the provider is still unhealthy; spending the full
  // threshold again would hammer it needlessly.
  it('re-opens immediately when the probe fails', async () => {
    for (let i = 0; i < 3; i += 1) circuitBreaker.recordFailure('anthropic', 'server_error');
    await new Promise((resolve) => setTimeout(resolve, 60));
    circuitBreaker.canAttempt('anthropic');

    circuitBreaker.recordFailure('anthropic', 'server_error');
    expect(circuitBreaker.getState('anthropic').state).toBe('open');
  });

  it('tracks providers independently', () => {
    for (let i = 0; i < 3; i += 1) circuitBreaker.recordFailure('anthropic', 'server_error');
    expect(circuitBreaker.canAttempt('anthropic')).toBe(false);
    expect(circuitBreaker.canAttempt('openai')).toBe(true);
  });
});

describe('provider health', () => {
  it('treats an unused provider as healthy', () => {
    expect(providerHealth.isHealthy('anthropic')).toBe(true);
  });

  it('computes an error rate over the rolling window', () => {
    for (let i = 0; i < 8; i += 1) {
      providerHealth.recordCall('anthropic', { success: true, latencyMs: 100 });
    }
    for (let i = 0; i < 2; i += 1) {
      providerHealth.recordCall('anthropic', { success: false, latencyMs: 100, errorCategory: 'timeout' });
    }
    const health = providerHealth.getHealth('anthropic');
    expect(health.errorRate).toBeCloseTo(0.2, 2);
    expect(health.healthy).toBe(true);
  });

  it('marks a provider unhealthy above a 20% error rate', () => {
    for (let i = 0; i < 5; i += 1) {
      providerHealth.recordCall('openai', { success: false, latencyMs: 50, errorCategory: 'server_error' });
    }
    const health = providerHealth.getHealth('openai');
    expect(health.healthy).toBe(false);
    expect(health.lastErrorCategory).toBe('server_error');
  });

  it('reports p95 latency', () => {
    for (let i = 1; i <= 20; i += 1) {
      providerHealth.recordCall('anthropic', { success: true, latencyMs: i * 100 });
    }
    expect(providerHealth.getHealth('anthropic').p95LatencyMs).toBeGreaterThan(1500);
  });

  it('bounds the window rather than growing without limit', () => {
    for (let i = 0; i < 200; i += 1) {
      providerHealth.recordCall('anthropic', { success: true, latencyMs: 10 });
    }
    const health = providerHealth.getHealth('anthropic');
    expect(health.windowCalls).toBeLessThanOrEqual(50);
    expect(health.totalCalls).toBe(200);
  });
});
