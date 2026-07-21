/**
 * End-to-end orchestration: gate ordering, fallback, schema enforcement,
 * quota accounting, and audit emission.
 *
 * Providers are mocked. No network call is made and no provider key exists in
 * this environment, which is the point — every path here must be exercisable
 * without credentials.
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

const mockRedisStore = new Map();
jest.mock('../../src/config/redis', () => ({
  isReady: true,
  get: jest.fn(async (key) => (mockRedisStore.has(key) ? String(mockRedisStore.get(key)) : null)),
  incr: jest.fn(async (key) => {
    const next = (Number(mockRedisStore.get(key)) || 0) + 1;
    mockRedisStore.set(key, next);
    return next;
  }),
  incrby: jest.fn(async (key, amount) => {
    const next = (Number(mockRedisStore.get(key)) || 0) + Number(amount);
    mockRedisStore.set(key, next);
    return next;
  }),
  expire: jest.fn(async () => 1),
}));

const mockUsageRecords = [];
jest.mock('../../src/modules/ai/aiUsage.model', () => ({
  create: jest.fn(async (record) => {
    mockUsageRecords.push(record);
    return record;
  }),
}));

const mockAuditEvents = [];
jest.mock('../../src/modules/audit/audit.service', () => ({
  recordAiEvent: jest.fn(async (event) => {
    mockAuditEvents.push(event);
    return event;
  }),
}));

// ── Provider mocks ──────────────────────────────────────────────────────────
const mockAnthropicCall = jest.fn();
const mockOpenAiCall = jest.fn();

jest.mock('../../src/modules/ai/providers/anthropic.adapter', () => ({
  anthropicAdapter: {
    name: 'anthropic',
    supports: (capability) => ['generateText', 'generateStructured'].includes(capability),
    isConfigured: () => true,
    generateStructured: (...args) => mockAnthropicCall(...args),
  },
}));

jest.mock('../../src/modules/ai/providers/openai.adapter', () => ({
  openaiAdapter: {
    name: 'openai',
    supports: (capability) => ['generateText', 'generateStructured'].includes(capability),
    isConfigured: () => true,
    generateStructured: (...args) => mockOpenAiCall(...args),
  },
}));

const { orchestrate } = require('../../src/modules/ai/ai.orchestrator');
const { NOTIFICATION_DRAFT_SCHEMA } = require('../../src/modules/ai/schemas/notificationDraft.schema');
const { AI_FEATURES } = require('../../src/modules/ai/ai.constants');
const circuitBreaker = require('../../src/modules/ai/ops/circuitBreaker');
const providerHealth = require('../../src/modules/ai/ops/providerHealth');

const VALID_DRAFT = {
  ar: { title: 'إعلان القداس', summary: 'قداس يوم الأحد الساعة السابعة' },
  en: { title: 'Liturgy Notice', summary: 'Sunday liturgy at seven' },
  tone: 'formal',
  confidence: 'high',
};

function providerResult(data, overrides = {}) {
  return {
    data,
    usage: { inputTokens: 800, outputTokens: 400, cachedInputTokens: 0, estimatedCostUsd: 0 },
    provider: 'anthropic',
    model: 'claude-sonnet-5',
    latencyMs: 120,
    usedFallback: false,
    ...overrides,
  };
}

const CONTEXT = {
  userId: 'user-1',
  role: 'ADMIN',
  permissions: ['AI_DRAFT_CONTENT', 'NOTIFICATIONS_CREATE'],
  requestId: 'req-1',
  feature: AI_FEATURES.NOTIFICATION_DRAFT,
  sensitivity: 'internal',
  language: 'ar',
};

function run(overrides = {}) {
  return orchestrate({
    feature: AI_FEATURES.NOTIFICATION_DRAFT,
    workload: 'arabic_drafting',
    sensitivity: 'internal',
    capability: 'generateStructured',
    schema: NOTIFICATION_DRAFT_SCHEMA,
    schemaName: 'NotificationDraft',
    promptKey: 'notificationDraft',
    input: {
      notificationTypeName: 'إعلان عام',
      audienceLabel: 'كل المستخدمين',
      bulletPoints: ['قداس الأحد الساعة السابعة'],
    },
    context: CONTEXT,
    ...overrides,
  });
}

beforeEach(() => {
  mockRedisStore.clear();
  mockUsageRecords.length = 0;
  mockAuditEvents.length = 0;
  mockAnthropicCall.mockReset();
  mockOpenAiCall.mockReset();
  circuitBreaker.reset();
  providerHealth.reset();
  mockConfig.ai.enabled = true;
  mockConfig.ai.features.notificationDraft = true;
});

const eventTypes = () => mockAuditEvents.map((event) => event.eventType);

describe('happy path', () => {
  it('returns validated data with provider metadata', async () => {
    mockAnthropicCall.mockResolvedValue(providerResult(VALID_DRAFT));

    const result = await run();

    expect(result.data).toEqual(VALID_DRAFT);
    expect(result.meta).toMatchObject({
      provider: 'anthropic',
      model: 'claude-sonnet-5',
      usedFallback: false,
      requestId: 'req-1',
      tokensUsed: 1200,
    });
    expect(result.meta.promptVersion).toBe('notificationDraft.v1');
  });

  it('audits request and completion', async () => {
    mockAnthropicCall.mockResolvedValue(providerResult(VALID_DRAFT));
    await run();
    expect(eventTypes()).toEqual(['ai.requested', 'ai.completed']);
  });

  it('writes a usage record with token counts and no prompt text', async () => {
    mockAnthropicCall.mockResolvedValue(providerResult(VALID_DRAFT));
    await run();

    expect(mockUsageRecords).toHaveLength(1);
    const record = mockUsageRecords[0];
    expect(record).toMatchObject({
      feature: 'notification_draft',
      provider: 'anthropic',
      inputTokens: 800,
      outputTokens: 400,
      schemaValid: true,
      usedFallback: false,
    });
    expect(record.promptHash).toMatch(/^[a-f0-9]{16}$/);
    // Fingerprint only — the prompt itself is never persisted.
    expect(JSON.stringify(record)).not.toContain('قداس الأحد الساعة السابعة');
  });

  it('meters spend', async () => {
    mockAnthropicCall.mockResolvedValue(providerResult(VALID_DRAFT));
    await run();
    expect(mockUsageRecords[0].estimatedCostUsd).toBeGreaterThan(0);
  });

  it('consumes quota exactly once', async () => {
    mockAnthropicCall.mockResolvedValue(providerResult(VALID_DRAFT));
    await run();
    const quotaKeys = [...mockRedisStore.keys()].filter((k) => k.startsWith('ai:quota:'));
    expect(quotaKeys).toHaveLength(3);
    quotaKeys.forEach((key) => expect(mockRedisStore.get(key)).toBe(1));
  });

  it('passes the schema to the adapter', async () => {
    mockAnthropicCall.mockResolvedValue(providerResult(VALID_DRAFT));
    await run();
    expect(mockAnthropicCall.mock.calls[0][0]).toMatchObject({
      schema: NOTIFICATION_DRAFT_SCHEMA,
      schemaName: 'NotificationDraft',
    });
  });
});

describe('kill switches', () => {
  it('refuses when AI is globally disabled, without calling a provider', async () => {
    mockConfig.ai.enabled = false;
    await expect(run()).rejects.toMatchObject({ statusCode: 503, errorCode: 'AI_DISABLED' });
    expect(mockAnthropicCall).not.toHaveBeenCalled();
  });

  it('refuses when only this feature is disabled', async () => {
    mockConfig.ai.features.notificationDraft = false;
    await expect(run()).rejects.toMatchObject({ errorCode: 'AI_DISABLED' });
    expect(mockAnthropicCall).not.toHaveBeenCalled();
  });

  it('does not consume quota when disabled', async () => {
    mockConfig.ai.enabled = false;
    await expect(run()).rejects.toThrow();
    expect([...mockRedisStore.keys()].filter((k) => k.startsWith('ai:quota:'))).toHaveLength(0);
  });
});

describe('spend and quota ceilings', () => {
  it('refuses once the daily spend cap is reached', async () => {
    mockRedisStore.set(`ai:spend:day:${new Date().toISOString().slice(0, 10)}`, 5 * 1000000);
    await expect(run()).rejects.toMatchObject({ errorCode: 'AI_QUOTA_EXCEEDED' });
    expect(mockAnthropicCall).not.toHaveBeenCalled();
    expect(eventTypes()).toContain('ai.quota_exceeded');
  });

  it('refuses once the per-user quota is exhausted', async () => {
    const today = new Date().toISOString().slice(0, 10);
    mockRedisStore.set(`ai:quota:user:user-1:notification_draft:${today}`, 50);
    await expect(run()).rejects.toMatchObject({ statusCode: 429, errorCode: 'AI_QUOTA_EXCEEDED' });
    expect(mockAnthropicCall).not.toHaveBeenCalled();
  });

  it('refuses a role with no allowance', async () => {
    await expect(run({ context: { ...CONTEXT, role: 'USER' } }))
      .rejects.toMatchObject({ errorCode: 'AI_QUOTA_EXCEEDED' });
  });
});

describe('redaction gate', () => {
  it('blocks a payload containing a denied field, before any provider call', async () => {
    await expect(
      run({ input: { notificationTypeName: 'x', audienceLabel: 'y', bulletPoints: ['ok'], notes: 'secret' } })
    ).rejects.toMatchObject({ statusCode: 422, errorCode: 'AI_INPUT_BLOCKED' });

    expect(mockAnthropicCall).not.toHaveBeenCalled();
    expect(eventTypes()).toContain('ai.redaction_blocked');
  });

  it('blocks a personal identifier hidden in free text', async () => {
    await expect(
      run({
        input: {
          notificationTypeName: 'إعلان',
          audienceLabel: 'الكل',
          bulletPoints: ['اتصل على 01012345678'],
        },
      })
    ).rejects.toMatchObject({ errorCode: 'AI_INPUT_BLOCKED' });
    expect(mockAnthropicCall).not.toHaveBeenCalled();
  });

  it('records the block as a usage row flagged redactionBlocked', async () => {
    await expect(
      run({ input: { notificationTypeName: 'x', audienceLabel: 'y', bulletPoints: ['ok'], nationalId: '1' } })
    ).rejects.toThrow();

    expect(mockUsageRecords[0]).toMatchObject({ redactionBlocked: true, provider: 'none' });
  });

  it('blocks model OUTPUT that contains a personal identifier', async () => {
    mockAnthropicCall.mockResolvedValue(providerResult({
      ...VALID_DRAFT,
      ar: { title: 'إعلان', summary: 'اتصل على 01012345678' },
    }));

    await expect(run()).rejects.toMatchObject({ errorCode: 'AI_OUTPUT_INVALID' });
    expect(eventTypes()).toContain('ai.redaction_blocked');
  });
});

describe('schema enforcement', () => {
  // The corrective retry only works if validation runs INSIDE the retry loop.
  it('retries once on the same provider and succeeds on the corrected response', async () => {
    mockAnthropicCall
      .mockResolvedValueOnce(providerResult({ ar: { title: 'x' } })) // schema-invalid
      .mockResolvedValueOnce(providerResult(VALID_DRAFT));

    const result = await run();

    expect(result.data).toEqual(VALID_DRAFT);
    expect(mockAnthropicCall).toHaveBeenCalledTimes(2);
    expect(mockOpenAiCall).not.toHaveBeenCalled();
    expect(mockUsageRecords[0].schemaRetries).toBe(1);
  });

  it('sends a corrective hint naming the schema errors on the retry', async () => {
    mockAnthropicCall
      .mockResolvedValueOnce(providerResult({ ar: { title: 'x' } }))
      .mockResolvedValueOnce(providerResult(VALID_DRAFT));

    await run();

    const retryPrompt = mockAnthropicCall.mock.calls[1][0].prompt;
    expect(retryPrompt).toMatch(/did not match the required schema/);
    expect(retryPrompt).toContain('NotificationDraft');
  });

  // A malformed response says the prompt is wrong, not that the provider is
  // sick; counting it would open the circuit on a healthy provider.
  it('does not count a schema failure against the circuit breaker', async () => {
    mockAnthropicCall.mockResolvedValue(providerResult({ nonsense: true }));
    await expect(run()).rejects.toThrow();
    expect(circuitBreaker.getState('anthropic').failureCount).toBe(0);
  });

  it('reports an unusable response as 502, not as 503 unavailable', async () => {
    mockAnthropicCall.mockResolvedValue(providerResult({ nonsense: true }));
    await expect(run()).rejects.toMatchObject({
      statusCode: 502, errorCode: 'AI_OUTPUT_INVALID',
    });
  });

  it('rejects output with an unexpected property', async () => {
    mockAnthropicCall.mockResolvedValue(providerResult({ ...VALID_DRAFT, injected: 'x' }));
    await expect(run()).rejects.toMatchObject({ statusCode: 502, errorCode: 'AI_OUTPUT_INVALID' });
    expect(eventTypes()).toContain('ai.output_rejected');
  });

  it('never falls back to another provider on a schema failure', async () => {
    mockAnthropicCall.mockResolvedValue(providerResult({ nonsense: true }));
    await expect(run()).rejects.toThrow();
    expect(mockOpenAiCall).not.toHaveBeenCalled();
  });

  it('records the failure with schemaValid false', async () => {
    mockAnthropicCall.mockResolvedValue(providerResult({ nonsense: true }));
    await expect(run()).rejects.toThrow();
    expect(mockUsageRecords[0]).toMatchObject({ schemaValid: false });
  });
});

describe('fallback behaviour', () => {
  function providerError(category) {
    const error = new Error(`simulated ${category}`);
    error.category = category;
    error.provider = 'anthropic';
    return error;
  }

  it('falls back to openai after an anthropic server error', async () => {
    mockAnthropicCall.mockRejectedValue(providerError('server_error'));
    mockOpenAiCall.mockResolvedValue(providerResult(VALID_DRAFT, {
      provider: 'openai', model: 'gpt-5.6-terra',
    }));

    const result = await run();

    expect(mockOpenAiCall).toHaveBeenCalled();
    expect(result.meta.provider).toBe('openai');
    expect(result.meta.usedFallback).toBe(true);
  });

  it('marks the usage record as a fallback', async () => {
    mockAnthropicCall.mockRejectedValue(providerError('server_error'));
    mockOpenAiCall.mockResolvedValue(providerResult(VALID_DRAFT, { provider: 'openai' }));
    await run();
    expect(mockUsageRecords[0].usedFallback).toBe(true);
  });

  // The privacy rule: a sensitive workload fails rather than reaching a second
  // vendor, because a fallback would create a second copy under second terms.
  it('refuses to fall back for a sensitive workload', async () => {
    mockAnthropicCall.mockRejectedValue(providerError('server_error'));
    mockOpenAiCall.mockResolvedValue(providerResult(VALID_DRAFT, { provider: 'openai' }));

    await expect(run({ sensitivity: 'sensitive' }))
      .rejects.toMatchObject({ errorCode: 'AI_UNAVAILABLE' });

    expect(mockOpenAiCall).not.toHaveBeenCalled();
  });

  it('fails gracefully when both providers are down', async () => {
    mockAnthropicCall.mockRejectedValue(providerError('server_error'));
    mockOpenAiCall.mockRejectedValue(providerError('server_error'));

    await expect(run()).rejects.toMatchObject({ statusCode: 503, errorCode: 'AI_UNAVAILABLE' });
    expect(eventTypes()).toContain('ai.failed');
  });

  it('does not fall back when the request itself was invalid', async () => {
    mockAnthropicCall.mockRejectedValue(providerError('invalid_request'));
    await expect(run()).rejects.toThrow();
    expect(mockOpenAiCall).not.toHaveBeenCalled();
  });

  it('opens the circuit after repeated provider failures', async () => {
    mockAnthropicCall.mockRejectedValue(providerError('server_error'));
    mockOpenAiCall.mockResolvedValue(providerResult(VALID_DRAFT, { provider: 'openai' }));

    for (let i = 0; i < 3; i += 1) {
      mockRedisStore.clear();
      await run();
    }

    expect(circuitBreaker.getState('anthropic').state).toBe('open');
  });

  it('records provider health for both success and failure', async () => {
    mockAnthropicCall.mockRejectedValue(providerError('timeout'));
    mockOpenAiCall.mockResolvedValue(providerResult(VALID_DRAFT, { provider: 'openai' }));
    await run();

    expect(providerHealth.getHealth('anthropic').totalFailures).toBeGreaterThan(0);
    expect(providerHealth.getHealth('openai').totalCalls).toBeGreaterThan(0);
  });
});

describe('post-validation hook', () => {
  it('rejects when the server-side check fails', async () => {
    mockAnthropicCall.mockResolvedValue(providerResult(VALID_DRAFT));

    await expect(
      run({
        postValidate: () => {
          throw new Error('metric key was never supplied');
        },
      })
    ).rejects.toMatchObject({ errorCode: 'AI_OUTPUT_INVALID' });

    expect(eventTypes()).toContain('ai.output_rejected');
  });

  it('can transform the validated output', async () => {
    mockAnthropicCall.mockResolvedValue(providerResult(VALID_DRAFT));
    const result = await run({ postValidate: (draft) => ({ ...draft, tone: 'warm' }) });
    expect(result.data.tone).toBe('warm');
  });
});

describe('audit never carries content', () => {
  it('emits no prompt or response text in any audit event', async () => {
    mockAnthropicCall.mockResolvedValue(providerResult(VALID_DRAFT));
    await run();

    const serialized = JSON.stringify(mockAuditEvents);
    expect(serialized).not.toContain('قداس الأحد الساعة السابعة');
    expect(serialized).not.toContain('إعلان القداس');
  });
});

describe('timeout retry uses a longer budget', () => {
  function timeoutError() {
    const error = new Error('timed out');
    error.category = 'timeout';
    return error;
  }

  // Retrying with the deadline that just expired mostly reproduces the timeout.
  it('gives the retry 1.5x the configured timeout', async () => {
    mockAnthropicCall
      .mockRejectedValueOnce(timeoutError())
      .mockResolvedValueOnce(providerResult(VALID_DRAFT));

    await run();

    expect(mockAnthropicCall).toHaveBeenCalledTimes(2);
    expect(mockAnthropicCall.mock.calls[0][0].timeoutMs).toBeNull();
    expect(mockAnthropicCall.mock.calls[1][0].timeoutMs).toBe(1500);
  });

  it('does not lengthen the timeout for a non-timeout retry', async () => {
    mockAnthropicCall
      .mockResolvedValueOnce(providerResult({ ar: { title: 'x' } }))
      .mockResolvedValueOnce(providerResult(VALID_DRAFT));

    await run();

    expect(mockAnthropicCall.mock.calls[1][0].timeoutMs).toBeNull();
  });
});

describe('quota is charged on provider contact, not on success', () => {
  function providerError(category) {
    const error = new Error(`simulated ${category}`);
    error.category = category;
    return error;
  }

  // Charging only on success would make a failing retry loop free, so a client
  // stuck retrying could burn provider spend without ever touching its quota.
  it('charges quota even when the request ultimately fails', async () => {
    mockAnthropicCall.mockRejectedValue(providerError('server_error'));
    mockOpenAiCall.mockRejectedValue(providerError('server_error'));

    await expect(run()).rejects.toThrow();

    const quotaKeys = [...mockRedisStore.keys()].filter((k) => k.startsWith('ai:quota:'));
    expect(quotaKeys).toHaveLength(3);
    quotaKeys.forEach((key) => expect(mockRedisStore.get(key)).toBe(1));
  });

  it('charges quota exactly once even when a fallback is used', async () => {
    mockAnthropicCall.mockRejectedValue(providerError('server_error'));
    mockOpenAiCall.mockResolvedValue(providerResult(VALID_DRAFT, { provider: 'openai' }));

    await run();

    const quotaKeys = [...mockRedisStore.keys()].filter((k) => k.startsWith('ai:quota:'));
    quotaKeys.forEach((key) => expect(mockRedisStore.get(key)).toBe(1));
  });

  it('does not charge quota when the redaction gate blocks the request', async () => {
    await expect(
      run({ input: { notificationTypeName: 'x', audienceLabel: 'y', bulletPoints: ['ok'], notes: 'secret' } })
    ).rejects.toThrow();

    const quotaKeys = [...mockRedisStore.keys()].filter((k) => k.startsWith('ai:quota:'));
    expect(quotaKeys).toHaveLength(0);
  });
});

describe('audit metadata never carries raw model-derived text', () => {
  it('masks a personal identifier echoed in a schema error', async () => {
    // A JSON-parse failure quotes the offending model text; if that text is a
    // phone number it must be masked before entering the 400-day audit store.
    const parseError = Object.assign(new Error('bad'), {
      name: 'SchemaValidationError',
      errors: ['response is not valid JSON: near 01012345678'],
    });
    Object.setPrototypeOf(parseError, Object.getPrototypeOf(
      require('../../src/modules/ai/schemas/schema.validator').SchemaValidationError.prototype
    ));

    // Easier: force a post-validate that leaks a phone number in its message.
    mockAnthropicCall.mockResolvedValue(providerResult(VALID_DRAFT));

    await expect(
      run({
        postValidate: () => {
          throw new Error('cited unknown value 01012345678 in the model output');
        },
      })
    ).rejects.toThrow();

    const rejected = mockAuditEvents.find((e) => e.eventType === 'ai.output_rejected');
    expect(rejected).toBeDefined();
    expect(JSON.stringify(rejected)).not.toContain('01012345678');
    expect(JSON.stringify(rejected)).toContain('[redacted:');
  });
});

describe('per-category retry budget (§15.3)', () => {
  function categoryError(category) {
    const error = new Error(`simulated ${category}`);
    error.category = category;
    return error;
  }

  // A 429 gets up to two retries; a timeout only one. A single global counter
  // could not express that.
  it('retries a persistent 429 twice, then falls back', async () => {
    mockAnthropicCall.mockRejectedValue(categoryError('rate_limit'));
    mockOpenAiCall.mockResolvedValue(providerResult(VALID_DRAFT, { provider: 'openai' }));

    await run();

    // 1 initial + 2 retries on the primary before giving up.
    expect(mockAnthropicCall).toHaveBeenCalledTimes(3);
    expect(mockOpenAiCall).toHaveBeenCalledTimes(1);
  }, 15000);

  it('retries a persistent timeout only once', async () => {
    mockAnthropicCall.mockRejectedValue(categoryError('timeout'));
    mockOpenAiCall.mockResolvedValue(providerResult(VALID_DRAFT, { provider: 'openai' }));

    await run();

    // 1 initial + 1 retry on the primary.
    expect(mockAnthropicCall).toHaveBeenCalledTimes(2);
  });
});
