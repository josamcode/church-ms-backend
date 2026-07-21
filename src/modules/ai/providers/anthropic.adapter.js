/**
 * Anthropic adapter — the primary provider.
 *
 * Implemented against the HTTP API with the platform `fetch` rather than the
 * vendor SDK. Three reasons: no new runtime dependency on a path that handles
 * personal data; retries, timeouts, and circuit breaking already live in this
 * module and would otherwise be duplicated; and the adapter surface stays small
 * enough to test exhaustively with a mocked transport.
 *
 * Capabilities not offered by Anthropic (embeddings, audio) are ABSENT from
 * this object rather than present-and-throwing, so `supports()` is the single
 * source of truth.
 */

const config = require('../../../config/env');
const { AI_ERROR_CATEGORIES } = require('../ai.constants');
const { providerSupports } = require('./capabilities');
const { parseModelJson } = require('../schemas/schema.validator');

const PROVIDER = 'anthropic';

class AiProviderError extends Error {
  constructor(message, category, statusCode = null) {
    super(message);
    this.name = 'AiProviderError';
    this.category = category;
    this.statusCode = statusCode;
    this.provider = PROVIDER;
  }
}

/** Map an HTTP status onto a retry/fallback decision category. */
function categorizeStatus(status) {
  if (status === 401 || status === 403) return AI_ERROR_CATEGORIES.AUTH_ERROR;
  if (status === 429) return AI_ERROR_CATEGORIES.RATE_LIMIT;
  if (status >= 500) return AI_ERROR_CATEGORIES.SERVER_ERROR;
  return AI_ERROR_CATEGORIES.INVALID_REQUEST;
}

async function callAnthropic(body, { timeoutMs }) {
  const providerConfig = config.ai.providers[PROVIDER];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${providerConfig.baseUrl}/v1/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': providerConfig.apiKey,
        'anthropic-version': providerConfig.version,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      let detail = '';
      try {
        const errorBody = await response.json();
        // The provider's message only — never the request body, which would
        // put the payload we just protected into a log line.
        detail = errorBody?.error?.message || '';
      } catch {
        detail = '';
      }
      throw new AiProviderError(
        `Anthropic request failed (${response.status})${detail ? `: ${detail}` : ''}`,
        categorizeStatus(response.status),
        response.status
      );
    }

    return await response.json();
  } catch (error) {
    if (error instanceof AiProviderError) throw error;
    if (error.name === 'AbortError') {
      throw new AiProviderError('Anthropic request timed out', AI_ERROR_CATEGORIES.TIMEOUT);
    }
    throw new AiProviderError(
      `Anthropic request failed: ${error.message}`,
      AI_ERROR_CATEGORIES.SERVER_ERROR
    );
  } finally {
    clearTimeout(timer);
  }
}

function extractUsage(response) {
  const usage = response?.usage || {};
  return {
    inputTokens: Number(usage.input_tokens) || 0,
    outputTokens: Number(usage.output_tokens) || 0,
    cachedInputTokens: Number(usage.cache_read_input_tokens) || 0,
    estimatedCostUsd: 0, // filled in by the orchestrator via cost.meter
  };
}

function extractText(response) {
  const blocks = Array.isArray(response?.content) ? response.content : [];
  return blocks
    .filter((block) => block?.type === 'text')
    .map((block) => block.text)
    .join('')
    .trim();
}

const anthropicAdapter = {
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
    const response = await callAnthropic(
      {
        model,
        max_tokens: maxTokens,
        temperature,
        ...(system ? { system } : {}),
        messages: [{ role: 'user', content: prompt }],
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

  /**
   * Structured output via a forced single-tool call.
   *
   * Anthropic's native structured-output path is tool use with `tool_choice`
   * pinned to one tool whose input_schema is the target schema. The response
   * arrives as a `tool_use` block whose `input` is already parsed JSON, so no
   * text-to-JSON guessing is involved on the happy path.
   */
  async generateStructured({ prompt, system, schema, schemaName, model, maxTokens = 2048, timeoutMs = null }) {
    const startedAt = Date.now();
    const toolName = schemaName || 'structured_output';

    const response = await callAnthropic(
      {
        model,
        max_tokens: maxTokens,
        temperature: 0,
        ...(system ? { system } : {}),
        tools: [
          {
            name: toolName,
            description: 'Return the result using exactly this schema.',
            input_schema: schema,
          },
        ],
        tool_choice: { type: 'tool', name: toolName },
        messages: [{ role: 'user', content: prompt }],
      },
      { timeoutMs: timeoutMs || config.ai.limits.requestTimeoutMs }
    );

    const blocks = Array.isArray(response?.content) ? response.content : [];
    const toolUse = blocks.find((block) => block?.type === 'tool_use');

    // If the model answered in prose despite tool_choice, fall back to parsing
    // the text so the caller still gets a schema-validation error rather than
    // an opaque "no tool_use block" failure.
    const data = toolUse ? toolUse.input : parseModelJson(extractText(response));

    return {
      data,
      usage: extractUsage(response),
      provider: PROVIDER,
      model,
      latencyMs: Date.now() - startedAt,
      usedFallback: false,
    };
  },

  // No `embed`, `transcribe`, or `generateSpeech`: Anthropic does not provide
  // them, and an adapter must not advertise a capability it cannot honour.
};

module.exports = { anthropicAdapter, AiProviderError, categorizeStatus };
