/**
 * Gemini adapter — prepared, disabled.
 *
 * Present so the provider layer has a third implementation to prove the
 * abstraction is genuinely provider-independent, and so enabling Gemini later
 * is a configuration review rather than a new integration.
 *
 * It is NOT enabled, and `isConfigured()` additionally requires
 * `AI_GEMINI_BILLING_VERIFIED=true`. On Google's unpaid tier the terms permit
 * using prompts for training and allow human review, and the automatic
 * paid-terms carve-out is limited to the EEA, Switzerland, and the UK — which
 * does not cover this deployment's region. Attaching an active Cloud Billing
 * account is the opt-out, so the flag is a claim that this has been done.
 */

const config = require('../../../config/env');
const { AI_ERROR_CATEGORIES } = require('../ai.constants');
const { providerSupports } = require('./capabilities');
const { parseModelJson } = require('../schemas/schema.validator');

const PROVIDER = 'gemini';

class GeminiProviderError extends Error {
  constructor(message, category, statusCode = null) {
    super(message);
    this.name = 'AiProviderError';
    this.category = category;
    this.statusCode = statusCode;
    this.provider = PROVIDER;
  }
}

const geminiAdapter = {
  name: PROVIDER,

  supports(capability) {
    return providerSupports(PROVIDER, capability);
  },

  /**
   * Two independent conditions, both required. The billing check is not a
   * convenience — without it the adapter would be usable in exactly the
   * configuration whose data terms make it unacceptable.
   */
  isConfigured() {
    const providerConfig = config.ai.providers[PROVIDER];
    return Boolean(
      providerConfig
      && providerConfig.apiKey
      && providerConfig.billingAccountVerified === true
    );
  },

  async generateStructured({ prompt, system, schema, model }) {
    if (!this.isConfigured()) {
      throw new GeminiProviderError(
        'Gemini is not configured: an API key and a verified paid billing account are both required',
        AI_ERROR_CATEGORIES.DISABLED
      );
    }

    const providerConfig = config.ai.providers[PROVIDER];
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.ai.limits.requestTimeoutMs);
    const startedAt = Date.now();

    try {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-goog-api-key': providerConfig.apiKey,
          },
          body: JSON.stringify({
            ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            generationConfig: {
              temperature: 0,
              responseMimeType: 'application/json',
              responseSchema: schema,
            },
          }),
          signal: controller.signal,
        }
      );

      if (!response.ok) {
        throw new GeminiProviderError(
          `Gemini request failed (${response.status})`,
          response.status >= 500
            ? AI_ERROR_CATEGORIES.SERVER_ERROR
            : AI_ERROR_CATEGORIES.INVALID_REQUEST,
          response.status
        );
      }

      const body = await response.json();
      const text = body?.candidates?.[0]?.content?.parts?.[0]?.text || '';
      const usage = body?.usageMetadata || {};

      return {
        data: parseModelJson(text),
        usage: {
          inputTokens: Number(usage.promptTokenCount) || 0,
          outputTokens: Number(usage.candidatesTokenCount) || 0,
          cachedInputTokens: Number(usage.cachedContentTokenCount) || 0,
          estimatedCostUsd: 0,
        },
        provider: PROVIDER,
        model,
        latencyMs: Date.now() - startedAt,
        usedFallback: false,
      };
    } catch (error) {
      if (error instanceof GeminiProviderError) throw error;
      if (error.name === 'AbortError') {
        throw new GeminiProviderError('Gemini request timed out', AI_ERROR_CATEGORIES.TIMEOUT);
      }
      throw new GeminiProviderError(
        `Gemini request failed: ${error.message}`,
        AI_ERROR_CATEGORIES.SERVER_ERROR
      );
    } finally {
      clearTimeout(timer);
    }
  },
};

module.exports = { geminiAdapter, GeminiProviderError };
