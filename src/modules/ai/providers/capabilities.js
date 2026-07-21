/**
 * What each provider actually supports.
 *
 * Verified against official provider documentation on 2026-07-20.
 * Re-verify before editing — a wrong `true` here becomes a runtime failure on
 * a user-facing path, and a wrong `false` silently disables a working route.
 */

const PROVIDER_CAPABILITIES = Object.freeze({
  anthropic: Object.freeze({
    generateText: true,
    generateStructured: true,
    streamText: true,
    runToolLoop: true,
    analyzeImage: true,
    // Anthropic does not offer an embeddings endpoint; the official guidance
    // is to use a third-party embedding provider.
    embed: false,
    transcribe: false,
    generateSpeech: false,
  }),
  openai: Object.freeze({
    generateText: true,
    generateStructured: true,
    streamText: true,
    runToolLoop: true,
    analyzeImage: true,
    embed: true,
    transcribe: true,
    generateSpeech: true,
  }),
  gemini: Object.freeze({
    generateText: true,
    generateStructured: true,
    streamText: true,
    runToolLoop: true,
    analyzeImage: true,
    embed: true,
    transcribe: true,
    generateSpeech: true,
  }),

  // DeepSeek is intentionally absent. It is rejected on privacy grounds (PRC
  // storage, trains on input by default, open-ended retention, no ZDR/DPA) and
  // is additionally text-only with no strict JSON-Schema output mode. Absence
  // here means `resolveAdapter('deepseek')` cannot succeed by construction.
});

const KNOWN_PROVIDERS = Object.freeze(Object.keys(PROVIDER_CAPABILITIES));

/** Providers that must never be used, with the reason, for clear errors. */
const REJECTED_PROVIDERS = Object.freeze({
  deepseek: 'PRC data storage, trains on input by default, open-ended retention, no DPA',
});

/**
 * @param {string} provider
 * @param {string} capability
 * @returns {boolean}
 */
function providerSupports(provider, capability) {
  const table = PROVIDER_CAPABILITIES[provider];
  return Boolean(table && table[capability] === true);
}

module.exports = {
  PROVIDER_CAPABILITIES,
  KNOWN_PROVIDERS,
  REJECTED_PROVIDERS,
  providerSupports,
};
