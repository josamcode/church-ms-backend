/**
 * Model routing and fallback admissibility.
 *
 * The privacy-critical property under test: a fallback must never move a
 * request to a provider with weaker guarantees, and a sensitive workload must
 * not fall back at all.
 */

jest.mock('../../src/config/env', () => ({
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
    circuitBreaker: { failureThreshold: 3, resetTimeoutMs: 1000 },
  },
}));

jest.mock('../../src/utils/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

const { isFallbackAllowed, shouldAttemptFallback } = require('../../src/modules/ai/routing/fallback.policy');
const { selectRoute, selectFallbackRoute, resolveAdapter } = require('../../src/modules/ai/routing/model.router');
const { MODEL_REGISTRY, FALLBACK_RULES } = require('../../src/modules/ai/routing/model.registry');
const { PROVIDER_CAPABILITIES, REJECTED_PROVIDERS } = require('../../src/modules/ai/providers/capabilities');
const circuitBreaker = require('../../src/modules/ai/ops/circuitBreaker');

beforeEach(() => circuitBreaker.reset());

describe('fallback admissibility', () => {
  it('permits anthropic <-> openai, which carry equivalent guarantees', () => {
    expect(isFallbackAllowed({ from: 'anthropic', to: 'openai', sensitivity: 'internal' }))
      .toEqual({ allowed: true });
    expect(isFallbackAllowed({ from: 'openai', to: 'anthropic', sensitivity: 'internal' }))
      .toEqual({ allowed: true });
  });

  it('refuses any fallback to gemini while billing is unverified', () => {
    const result = isFallbackAllowed({ from: 'anthropic', to: 'gemini', sensitivity: 'internal' });
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/paid tier|training/i);
  });

  it('refuses any fallback to deepseek, from any provider', () => {
    for (const from of ['anthropic', 'openai', 'gemini']) {
      const result = isFallbackAllowed({ from, to: 'deepseek', sensitivity: 'internal' });
      expect(result.allowed).toBe(false);
      expect(result.reason).toMatch(/PRC|rejected/i);
    }
  });

  // A second provider means a second copy of the data under a second set of
  // terms. A retry must not make that trade silently.
  it('refuses every fallback for a sensitive workload', () => {
    const result = isFallbackAllowed({ from: 'anthropic', to: 'openai', sensitivity: 'sensitive' });
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/sensitive/i);
  });

  it('denies an unlisted transfer rather than defaulting to permit', () => {
    const result = isFallbackAllowed({ from: 'anthropic', to: 'someNewVendor', sensitivity: 'internal' });
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/no fallback rule/i);
  });

  it('refuses a fallback to the provider that just failed', () => {
    expect(isFallbackAllowed({ from: 'openai', to: 'openai', sensitivity: 'internal' }).allowed)
      .toBe(false);
  });

  it('refuses when no fallback target is configured', () => {
    expect(isFallbackAllowed({ from: 'anthropic', to: null, sensitivity: 'internal' }).allowed)
      .toBe(false);
  });
});

describe('which failures justify a fallback', () => {
  it('retries elsewhere for transport-level failures', () => {
    expect(shouldAttemptFallback('timeout')).toBe(true);
    expect(shouldAttemptFallback('rate_limit')).toBe(true);
    expect(shouldAttemptFallback('server_error')).toBe(true);
  });

  // A malformed response almost always means the prompt is wrong; sending the
  // same prompt to another vendor just leaks a second copy and fails again.
  it('does not change provider on a schema failure', () => {
    expect(shouldAttemptFallback('schema_invalid')).toBe(false);
  });

  it('does not change provider when the request itself was rejected', () => {
    expect(shouldAttemptFallback('invalid_request')).toBe(false);
    expect(shouldAttemptFallback('quota_exceeded')).toBe(false);
    expect(shouldAttemptFallback('redaction_blocked')).toBe(false);
  });
});

describe('provider registry integrity', () => {
  it('has no DeepSeek entry in the capability table', () => {
    expect(PROVIDER_CAPABILITIES.deepseek).toBeUndefined();
    expect(Object.keys(PROVIDER_CAPABILITIES)).not.toContain('deepseek');
  });

  it('lists DeepSeek as explicitly rejected, with a reason', () => {
    expect(REJECTED_PROVIDERS.deepseek).toBeTruthy();
  });

  it('refuses to resolve an adapter for a rejected provider', () => {
    expect(() => resolveAdapter('deepseek')).toThrow(/rejected/i);
  });

  it('refuses to resolve an unknown provider', () => {
    expect(() => resolveAdapter('nope')).toThrow(/Unknown AI provider/);
  });

  it('does not advertise embeddings for Anthropic', () => {
    expect(PROVIDER_CAPABILITIES.anthropic.embed).toBe(false);
    expect(PROVIDER_CAPABILITIES.anthropic.transcribe).toBe(false);
    expect(resolveAdapter('anthropic').embed).toBeUndefined();
  });

  it('keeps gemini disabled in the model registry', () => {
    expect(MODEL_REGISTRY['gemini:flash'].enabled).toBe(false);
    expect(MODEL_REGISTRY['gemini:flash'].requiresBillingAccount).toBe(true);
  });

  it('has no fallback rule that permits reaching deepseek', () => {
    for (const [key, rule] of Object.entries(FALLBACK_RULES)) {
      if (key.endsWith('deepseek')) expect(rule.allowed).toBe(false);
    }
  });
});

describe('route selection', () => {
  it('picks Anthropic Sonnet for Arabic drafting', () => {
    const route = selectRoute({ workload: 'arabic_drafting', capability: 'generateStructured', language: 'ar' });
    expect(route.entry.provider).toBe('anthropic');
    expect(route.modelKey).toBe('anthropic:sonnet-5');
  });

  it('throws for an unknown workload rather than guessing', () => {
    expect(() => selectRoute({ workload: 'made_up', capability: 'generateText' }))
      .toThrow(/No routing policy/);
  });

  // Haiku is cheaper and capable, but has a documented Arabic quality gap.
  // `sensitivity: 'internal'` is passed explicitly: omitting it now fails
  // closed (a provider switch with no declared sensitivity is refused), which
  // is the point of the hardening — a real caller always declares it.
  it('excludes Haiku from Arabic work and falls through to the fallback model', () => {
    const route = selectRoute({
      workload: 'low_cost_bulk', capability: 'generateStructured', language: 'ar', sensitivity: 'internal',
    });
    expect(route.modelKey).not.toBe('anthropic:haiku-4-5');
  });

  it('allows Haiku for the same workload in English', () => {
    const route = selectRoute({
      workload: 'low_cost_bulk', capability: 'generateStructured', language: 'en', sensitivity: 'internal',
    });
    expect(route.modelKey).toBe('anthropic:haiku-4-5');
  });

  it('skips a provider whose circuit is open', () => {
    for (let i = 0; i < 3; i += 1) circuitBreaker.recordFailure('anthropic', 'server_error');
    const route = selectRoute({
      workload: 'arabic_drafting', capability: 'generateStructured', language: 'ar', sensitivity: 'internal',
    });
    expect(route.entry.provider).toBe('openai');
  });

  it('throws when every candidate is unavailable', () => {
    for (let i = 0; i < 3; i += 1) circuitBreaker.recordFailure('anthropic', 'server_error');
    for (let i = 0; i < 3; i += 1) circuitBreaker.recordFailure('openai', 'server_error');
    expect(() => selectRoute({ workload: 'arabic_drafting', capability: 'generateStructured', language: 'ar' }))
      .toThrow(/No AI model available/);
  });

  it('rejects a capability no routed model provides', () => {
    expect(() => selectRoute({ workload: 'arabic_drafting', capability: 'transcribe', language: 'ar' }))
      .toThrow(/No AI model available/);
  });
});

describe('fallback route selection', () => {
  it('returns the openai route after an anthropic failure', () => {
    const route = selectFallbackRoute({
      workload: 'arabic_drafting', capability: 'generateStructured',
      language: 'ar', sensitivity: 'internal', failedProvider: 'anthropic',
    });
    expect(route.blocked).toBeUndefined();
    expect(route.entry.provider).toBe('openai');
  });

  it('blocks the fallback for a sensitive workload', () => {
    const route = selectFallbackRoute({
      workload: 'arabic_drafting', capability: 'generateStructured',
      language: 'ar', sensitivity: 'sensitive', failedProvider: 'anthropic',
    });
    expect(route.blocked).toBe(true);
  });

  it('returns null when the workload declares no fallback', () => {
    const route = selectFallbackRoute({
      workload: 'batch_analysis', capability: 'generateStructured',
      language: 'ar', sensitivity: 'internal', failedProvider: 'anthropic',
    });
    expect(route).toBeNull();
  });
});

describe('primary selection respects the fallback privacy gate', () => {
  // Regression for a real hole: when the primary provider's circuit is open,
  // `selectRoute` promotes the fallback model to primary. That is still a
  // provider switch, so it must clear `isFallbackAllowed` — otherwise a
  // `sensitive` workload crossed to a second vendor on its FIRST attempt,
  // never touching the rule that exists to forbid exactly that.
  it('refuses to promote the fallback for a sensitive workload', () => {
    for (let i = 0; i < 3; i += 1) circuitBreaker.recordFailure('anthropic', 'server_error');

    expect(() =>
      selectRoute({
        workload: 'arabic_drafting',
        capability: 'generateStructured',
        language: 'ar',
        sensitivity: 'sensitive',
      })
    ).toThrow(/No AI model available/);
  });

  it('still promotes the fallback for an internal workload', () => {
    for (let i = 0; i < 3; i += 1) circuitBreaker.recordFailure('anthropic', 'server_error');

    const route = selectRoute({
      workload: 'arabic_drafting',
      capability: 'generateStructured',
      language: 'ar',
      sensitivity: 'internal',
    });
    expect(route.entry.provider).toBe('openai');
  });

  it('names the privacy rule as the reason it refused', () => {
    for (let i = 0; i < 3; i += 1) circuitBreaker.recordFailure('anthropic', 'server_error');

    try {
      selectRoute({
        workload: 'arabic_drafting',
        capability: 'generateStructured',
        language: 'ar',
        sensitivity: 'sensitive',
      });
      throw new Error('should have thrown');
    } catch (error) {
      expect(error.message).toMatch(/sensitive workloads must not be retried/);
    }
  });

  it('does not gate the primary itself', () => {
    const route = selectRoute({
      workload: 'arabic_drafting',
      capability: 'generateStructured',
      language: 'ar',
      sensitivity: 'sensitive',
    });
    expect(route.entry.provider).toBe('anthropic');
  });
});

describe('context window and cost ceiling', () => {
  it('rejects a prompt larger than the model context window', () => {
    expect(() =>
      selectRoute({
        workload: 'low_cost_bulk',
        capability: 'generateStructured',
        language: 'en',
        sensitivity: 'internal',
        // Beyond Haiku's 200k and OpenAI main's 1.05M.
        estimatedInputTokens: 2000000,
      })
    ).toThrow(/context window/);
  });

  it('reports the context window as the reason the small-context model was skipped', () => {
    // Haiku (200k) cannot hold this prompt; its only larger-context sibling in
    // this policy is OpenAI, which then blows the $0.01 ceiling — so the whole
    // cheap workload legitimately cannot serve a 500k prompt. The value under
    // test is that the FIRST rejection names the context window, not a crash.
    try {
      selectRoute({
        workload: 'low_cost_bulk',
        capability: 'generateStructured',
        language: 'en',
        sensitivity: 'internal',
        estimatedInputTokens: 500000,
        maxOutputTokens: 256,
      });
      throw new Error('should have thrown');
    } catch (error) {
      expect(error.message).toMatch(/context window/);
      expect(error.code).toBe('NO_ROUTE_AVAILABLE');
    }
  });

  // Distinct from the daily/monthly caps: those bound the aggregate, this
  // bounds one pathological request before it is ever made.
  it('rejects a call whose projected cost exceeds the per-call ceiling', () => {
    expect(() =>
      selectRoute({
        workload: 'batch_analysis', // maxCostPerCall 0.02, no fallback
        capability: 'generateStructured',
        language: 'ar',
        sensitivity: 'internal',
        estimatedInputTokens: 100000, // 100k * $2/M = $0.20, well over $0.02
        maxOutputTokens: 1024,
      })
    ).toThrow(/exceeds ceiling/);
  });

  // Regression: a fixed worst-case output estimate made cheap workloads
  // unroutable even for tiny prompts, because the assumed response alone
  // blew the ceiling.
  it('uses the requested output budget, not a fixed worst case', () => {
    const route = selectRoute({
      workload: 'batch_analysis',
      capability: 'generateStructured',
      language: 'ar',
      sensitivity: 'internal',
      estimatedInputTokens: 600,
      maxOutputTokens: 1024,
    });
    expect(route.modelKey).toBe('anthropic:sonnet-5');
  });

  it('allows an ordinary prompt', () => {
    const route = selectRoute({
      workload: 'arabic_drafting',
      capability: 'generateStructured',
      language: 'ar',
      sensitivity: 'internal',
      estimatedInputTokens: 900,
    });
    expect(route.modelKey).toBe('anthropic:sonnet-5');
  });
});

describe('sensitivity normalization fails closed (confirmation review)', () => {
  // A strict === 'sensitive' check failed OPEN on any non-canonical value.
  it.each(['sensitive', 'Sensitive', 'SENSITIVE', ' sensitive '])(
    'treats %j as sensitive and refuses the fallback',
    (value) => {
      expect(isFallbackAllowed({ from: 'anthropic', to: 'openai', sensitivity: value }).allowed)
        .toBe(false);
    }
  );

  // An unrecognized band is treated as sensitive, so a typo blocks rather than
  // silently permits a cross-provider move.
  it('treats an unknown sensitivity band as sensitive', () => {
    const result = isFallbackAllowed({ from: 'anthropic', to: 'openai', sensitivity: 'secret' });
    expect(result.allowed).toBe(false);
    expect(result.reason).toMatch(/unrecognized sensitivity/);
  });

  it('treats undefined sensitivity as sensitive', () => {
    expect(isFallbackAllowed({ from: 'anthropic', to: 'openai', sensitivity: undefined }).allowed)
      .toBe(false);
  });

  it('still permits an explicitly internal workload', () => {
    expect(isFallbackAllowed({ from: 'anthropic', to: 'openai', sensitivity: 'internal' }))
      .toEqual({ allowed: true });
  });

  it('routes a non-canonical sensitive value away from a provider switch', () => {
    for (let i = 0; i < 3; i += 1) circuitBreaker.recordFailure('anthropic', 'server_error');
    expect(() =>
      selectRoute({
        workload: 'arabic_drafting',
        capability: 'generateStructured',
        language: 'ar',
        sensitivity: 'SENSITIVE',
      })
    ).toThrow(/No AI model available/);
  });
});
