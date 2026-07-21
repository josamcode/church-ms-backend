/**
 * Provider adapters, against a mocked transport.
 *
 * No network call is made and no provider key exists in this environment.
 * The placeholder key below is a literal string, never a real credential.
 */

const mockConfig = {
  env: 'test',
  isProduction: false,
  ai: {
    enabled: true,
    features: {},
    providers: {
      anthropic: {
        enabled: true, apiKey: 'placeholder-not-a-real-key',
        baseUrl: 'https://api.anthropic.test', version: '2023-06-01',
      },
      openai: {
        enabled: true, apiKey: 'placeholder-not-a-real-key',
        baseUrl: 'https://api.openai.test',
      },
      gemini: { enabled: false, apiKey: '', billingAccountVerified: false },
    },
    limits: { requestTimeoutMs: 200, maxRetries: 1, dailySpendUsd: 5, monthlySpendUsd: 100 },
    circuitBreaker: { failureThreshold: 3, resetTimeoutMs: 50 },
  },
};

jest.mock('../../src/config/env', () => mockConfig);

const { anthropicAdapter } = require('../../src/modules/ai/providers/anthropic.adapter');
const { openaiAdapter, toStrictSchema } = require('../../src/modules/ai/providers/openai.adapter');
const { geminiAdapter } = require('../../src/modules/ai/providers/gemini.adapter');
const { assertValidAdapter } = require('../../src/modules/ai/providers/provider.interface');
const { NOTIFICATION_DRAFT_SCHEMA } = require('../../src/modules/ai/schemas/notificationDraft.schema');

const DRAFT = {
  ar: { title: 'إعلان', summary: 'ملخص' },
  en: { title: 'Notice', summary: 'Summary' },
  tone: 'formal',
  confidence: 'high',
};

function jsonResponse(body, { ok = true, status = 200 } = {}) {
  return { ok, status, json: async () => body };
}

beforeEach(() => {
  global.fetch = jest.fn();
});

afterEach(() => {
  delete global.fetch;
});

describe('adapter contract', () => {
  it.each([
    ['anthropic', () => anthropicAdapter],
    ['openai', () => openaiAdapter],
    ['gemini', () => geminiAdapter],
  ])('%s satisfies the mandatory contract', (_name, get) => {
    expect(() => assertValidAdapter(get())).not.toThrow();
  });

  it('rejects a malformed adapter at construction rather than at first use', () => {
    expect(() => assertValidAdapter({})).toThrow(/non-empty name/);
    expect(() => assertValidAdapter({ name: 'x' })).toThrow(/supports/);
    expect(() => assertValidAdapter({ name: 'x', supports: () => true })).toThrow(/isConfigured/);
  });

  // Unsupported capabilities are absent, not present-and-throwing, so
  // `supports()` is the single source of truth.
  it('omits capabilities Anthropic does not provide', () => {
    expect(anthropicAdapter.embed).toBeUndefined();
    expect(anthropicAdapter.transcribe).toBeUndefined();
    expect(anthropicAdapter.generateSpeech).toBeUndefined();
    expect(anthropicAdapter.supports('embed')).toBe(false);
  });

  it('reports the capabilities it does provide', () => {
    expect(anthropicAdapter.supports('generateStructured')).toBe(true);
    expect(openaiAdapter.supports('embed')).toBe(true);
  });
});

describe('anthropic adapter', () => {
  it('extracts structured data from a forced tool call', async () => {
    global.fetch.mockResolvedValue(jsonResponse({
      content: [{ type: 'tool_use', name: 'NotificationDraft', input: DRAFT }],
      usage: { input_tokens: 800, output_tokens: 400, cache_read_input_tokens: 100 },
    }));

    const result = await anthropicAdapter.generateStructured({
      prompt: 'p', system: 's', schema: NOTIFICATION_DRAFT_SCHEMA,
      schemaName: 'NotificationDraft', model: 'claude-sonnet-5',
    });

    expect(result.data).toEqual(DRAFT);
    expect(result.usage).toMatchObject({
      inputTokens: 800, outputTokens: 400, cachedInputTokens: 100,
    });
    expect(result.provider).toBe('anthropic');
  });

  it('pins tool_choice to the single schema tool', async () => {
    global.fetch.mockResolvedValue(jsonResponse({
      content: [{ type: 'tool_use', input: DRAFT }], usage: {},
    }));

    await anthropicAdapter.generateStructured({
      prompt: 'p', schema: NOTIFICATION_DRAFT_SCHEMA,
      schemaName: 'NotificationDraft', model: 'm',
    });

    const body = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(body.tool_choice).toEqual({ type: 'tool', name: 'NotificationDraft' });
    expect(body.tools).toHaveLength(1);
    expect(body.tools[0].input_schema).toEqual(NOTIFICATION_DRAFT_SCHEMA);
  });

  it('sends the API key as a header, never in the URL', async () => {
    global.fetch.mockResolvedValue(jsonResponse({ content: [{ type: 'tool_use', input: DRAFT }], usage: {} }));
    await anthropicAdapter.generateStructured({
      prompt: 'p', schema: {}, schemaName: 'S', model: 'm',
    });

    const [url, options] = global.fetch.mock.calls[0];
    expect(url).not.toContain('placeholder-not-a-real-key');
    expect(options.headers['x-api-key']).toBe('placeholder-not-a-real-key');
  });

  it('falls back to parsing text when the model answered in prose', async () => {
    global.fetch.mockResolvedValue(jsonResponse({
      content: [{ type: 'text', text: JSON.stringify(DRAFT) }], usage: {},
    }));

    const result = await anthropicAdapter.generateStructured({
      prompt: 'p', schema: {}, schemaName: 'S', model: 'm',
    });
    expect(result.data).toEqual(DRAFT);
  });

  describe('error categorization', () => {
    it.each([
      [401, 'auth_error'],
      [403, 'auth_error'],
      [429, 'rate_limit'],
      [500, 'server_error'],
      [503, 'server_error'],
      [400, 'invalid_request'],
    ])('maps HTTP %i to %s', async (status, category) => {
      global.fetch.mockResolvedValue(jsonResponse({ error: { message: 'x' } }, { ok: false, status }));

      await expect(
        anthropicAdapter.generateStructured({ prompt: 'p', schema: {}, schemaName: 'S', model: 'm' })
      ).rejects.toMatchObject({ category, statusCode: status });
    });

    it('categorizes an aborted request as a timeout', async () => {
      global.fetch.mockImplementation(() => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        return Promise.reject(error);
      });

      await expect(
        anthropicAdapter.generateStructured({ prompt: 'p', schema: {}, schemaName: 'S', model: 'm' })
      ).rejects.toMatchObject({ category: 'timeout' });
    });

    // An error is logged; putting the request body in it would defeat the
    // redaction gate that just cleared that payload.
    it('never includes the request payload in the error message', async () => {
      global.fetch.mockResolvedValue(jsonResponse({ error: { message: 'bad' } }, { ok: false, status: 400 }));

      let thrown = null;
      try {
        await anthropicAdapter.generateStructured({
          prompt: 'SENSITIVE-PROMPT-TEXT', schema: {}, schemaName: 'S', model: 'm',
        });
      } catch (error) {
        thrown = error;
      }
      expect(thrown.message).not.toContain('SENSITIVE-PROMPT-TEXT');
    });
  });
});

describe('openai adapter', () => {
  it('requests strict json_schema structured output', async () => {
    global.fetch.mockResolvedValue(jsonResponse({
      choices: [{ message: { content: JSON.stringify(DRAFT) } }],
      usage: { prompt_tokens: 700, completion_tokens: 300 },
    }));

    const result = await openaiAdapter.generateStructured({
      prompt: 'p', schema: NOTIFICATION_DRAFT_SCHEMA,
      schemaName: 'NotificationDraft', model: 'gpt-5.6-terra',
    });

    const body = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(body.response_format.type).toBe('json_schema');
    expect(body.response_format.json_schema.strict).toBe(true);
    expect(result.data).toEqual(DRAFT);
    expect(result.usage.inputTokens).toBe(700);
  });

  it('sends the key as a bearer token', async () => {
    global.fetch.mockResolvedValue(jsonResponse({
      choices: [{ message: { content: '{}' } }], usage: {},
    }));
    await openaiAdapter.generateStructured({ prompt: 'p', schema: {}, schemaName: 'S', model: 'm' });

    const [url, options] = global.fetch.mock.calls[0];
    expect(url).not.toContain('placeholder-not-a-real-key');
    expect(options.headers.authorization).toBe('Bearer placeholder-not-a-real-key');
  });

  describe('toStrictSchema', () => {
    // OpenAI strict mode requires every property in `required`. Rather than
    // weakening the shared schema, optional properties are promoted and made
    // nullable here.
    it('promotes optional properties to required and nullable', () => {
      const strict = toStrictSchema(NOTIFICATION_DRAFT_SCHEMA);
      expect(strict.required).toEqual(Object.keys(NOTIFICATION_DRAFT_SCHEMA.properties));
      expect(strict.properties.warnings.type).toBeDefined();
    });

    it('keeps genuinely required properties non-nullable', () => {
      const strict = toStrictSchema(NOTIFICATION_DRAFT_SCHEMA);
      expect(strict.properties.tone.type).toBe('string');
    });

    it('recurses into nested objects and arrays', () => {
      const strict = toStrictSchema(NOTIFICATION_DRAFT_SCHEMA);
      expect(strict.properties.ar.additionalProperties).toBe(false);
      expect(strict.properties.ar.required).toEqual(['title', 'summary', 'details']);
    });

    it('does not mutate the source schema shared with Anthropic', () => {
      const before = JSON.stringify(NOTIFICATION_DRAFT_SCHEMA);
      toStrictSchema(NOTIFICATION_DRAFT_SCHEMA);
      expect(JSON.stringify(NOTIFICATION_DRAFT_SCHEMA)).toBe(before);
    });
  });
});

describe('gemini adapter', () => {
  it('is not configured without a verified billing account', () => {
    expect(geminiAdapter.isConfigured()).toBe(false);
  });

  // The two-key rule: on the unpaid tier the terms permit training on prompts,
  // so a key alone must not be enough to make the adapter usable.
  it('stays unconfigured with a key but unverified billing', () => {
    mockConfig.ai.providers.gemini.apiKey = 'placeholder-not-a-real-key';
    mockConfig.ai.providers.gemini.billingAccountVerified = false;
    expect(geminiAdapter.isConfigured()).toBe(false);
  });

  it('becomes configured only once billing is verified', () => {
    mockConfig.ai.providers.gemini.apiKey = 'placeholder-not-a-real-key';
    mockConfig.ai.providers.gemini.billingAccountVerified = true;
    expect(geminiAdapter.isConfigured()).toBe(true);

    mockConfig.ai.providers.gemini.apiKey = '';
    mockConfig.ai.providers.gemini.billingAccountVerified = false;
  });

  it('refuses to send anything while unconfigured', async () => {
    mockConfig.ai.providers.gemini.apiKey = '';
    mockConfig.ai.providers.gemini.billingAccountVerified = false;

    await expect(
      geminiAdapter.generateStructured({ prompt: 'p', schema: {}, model: 'm' })
    ).rejects.toMatchObject({ category: 'disabled' });

    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe('no DeepSeek adapter exists', () => {
  it('has no adapter module in the providers directory', () => {
    const fs = require('fs');
    const path = require('path');
    const files = fs.readdirSync(path.resolve(__dirname, '../../src/modules/ai/providers'));
    expect(files.filter((f) => /deepseek/i.test(f))).toEqual([]);
  });
});
