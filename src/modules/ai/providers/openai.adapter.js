/**
 * OpenAI adapter — the fallback provider.
 *
 * Same design as the Anthropic adapter: HTTP via platform `fetch`, no vendor
 * SDK, capabilities absent rather than throwing.
 *
 * Structured output uses `response_format: { type: 'json_schema', strict: true }`,
 * which requires `additionalProperties: false` and every property listed in
 * `required` — the schemas in this module already satisfy the first, and
 * `toStrictSchema` below satisfies the second without mutating the source
 * schema that Anthropic also consumes.
 */

const config = require('../../../config/env');
const { AI_ERROR_CATEGORIES } = require('../ai.constants');
const { providerSupports } = require('./capabilities');
const { parseModelJson } = require('../schemas/schema.validator');

const PROVIDER = 'openai';

class OpenAiProviderError extends Error {
  constructor(message, category, statusCode = null) {
    super(message);
    this.name = 'AiProviderError';
    this.category = category;
    this.statusCode = statusCode;
    this.provider = PROVIDER;
  }
}

function categorizeStatus(status) {
  if (status === 401 || status === 403) return AI_ERROR_CATEGORIES.AUTH_ERROR;
  if (status === 429) return AI_ERROR_CATEGORIES.RATE_LIMIT;
  if (status >= 500) return AI_ERROR_CATEGORIES.SERVER_ERROR;
  return AI_ERROR_CATEGORIES.INVALID_REQUEST;
}

/**
 * OpenAI strict mode requires every property to appear in `required`, while
 * Anthropic accepts genuinely optional properties. Rather than weaken the
 * shared schema, optional properties are promoted to required here and made
 * nullable, which is the transformation OpenAI documents for this case.
 */
function toStrictSchema(schema) {
  if (!schema || typeof schema !== 'object') return schema;

  if (schema.type === 'object' && schema.properties) {
    return {
      ...schema,
      additionalProperties: false,
      required: Object.keys(schema.properties),
      properties: Object.fromEntries(
        Object.entries(schema.properties).map(([key, value]) => {
          const isOptional = !(schema.required || []).includes(key);
          const converted = toStrictSchema(value);
          if (isOptional && typeof converted.type === 'string') {
            return [key, { ...converted, type: [converted.type, 'null'] }];
          }
          return [key, converted];
        })
      ),
    };
  }

  if (schema.type === 'array' && schema.items) {
    return { ...schema, items: toStrictSchema(schema.items) };
  }

  return schema;
}

async function callOpenAi(body, { timeoutMs }) {
  const providerConfig = config.ai.providers[PROVIDER];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${providerConfig.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${providerConfig.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      let detail = '';
      try {
        const errorBody = await response.json();
        detail = errorBody?.error?.message || '';
      } catch {
        detail = '';
      }
      throw new OpenAiProviderError(
        `OpenAI request failed (${response.status})${detail ? `: ${detail}` : ''}`,
        categorizeStatus(response.status),
        response.status
      );
    }

    return await response.json();
  } catch (error) {
    if (error instanceof OpenAiProviderError) throw error;
    if (error.name === 'AbortError') {
      throw new OpenAiProviderError('OpenAI request timed out', AI_ERROR_CATEGORIES.TIMEOUT);
    }
    throw new OpenAiProviderError(
      `OpenAI request failed: ${error.message}`,
      AI_ERROR_CATEGORIES.SERVER_ERROR
    );
  } finally {
    clearTimeout(timer);
  }
}

function extractUsage(response) {
  const usage = response?.usage || {};
  return {
    inputTokens: Number(usage.prompt_tokens) || 0,
    outputTokens: Number(usage.completion_tokens) || 0,
    cachedInputTokens: Number(usage.prompt_tokens_details?.cached_tokens) || 0,
    estimatedCostUsd: 0,
  };
}

function extractText(response) {
  return String(response?.choices?.[0]?.message?.content || '').trim();
}

const openaiAdapter = {
  name: PROVIDER,

  supports(capability) {
    return providerSupports(PROVIDER, capability);
  },

  isConfigured() {
    const providerConfig = config.ai.providers[PROVIDER];
    return Boolean(providerConfig && providerConfig.apiKey);
  },

  async generateText({ prompt, system, model, maxTokens = 2048, temperature = 0.3, timeoutMs = null }) {
    const startedAt = Date.now();
    const response = await callOpenAi(
      {
        model,
        max_completion_tokens: maxTokens,
        temperature,
        messages: [
          ...(system ? [{ role: 'system', content: system }] : []),
          { role: 'user', content: prompt },
        ],
      },
      { timeoutMs: timeoutMs || config.ai.limits.requestTimeoutMs }
    );

    return {
      data: extractText(response),
      usage: extractUsage(response),
      provider: PROVIDER,
      model,
      latencyMs: Date.now() - startedAt,
      usedFallback: false,
    };
  },

  async generateStructured({ prompt, system, schema, schemaName, model, maxTokens = 2048, timeoutMs = null }) {
    const startedAt = Date.now();
    const response = await callOpenAi(
      {
        model,
        max_completion_tokens: maxTokens,
        temperature: 0,
        messages: [
          ...(system ? [{ role: 'system', content: system }] : []),
          { role: 'user', content: prompt },
        ],
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: schemaName || 'structured_output',
            strict: true,
            schema: toStrictSchema(schema),
          },
        },
      },
      { timeoutMs: timeoutMs || config.ai.limits.requestTimeoutMs }
    );

    return {
      data: parseModelJson(extractText(response)),
      usage: extractUsage(response),
      provider: PROVIDER,
      model,
      latencyMs: Date.now() - startedAt,
      usedFallback: false,
    };
  },
};

module.exports = { openaiAdapter, OpenAiProviderError, toStrictSchema, categorizeStatus };
