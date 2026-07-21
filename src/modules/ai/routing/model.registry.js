/**
 * Model registry — the only place model names and prices live.
 *
 * Model identifiers resolve through `AI_MODEL_*` environment variables, so
 * swapping a model *within* a provider is a secret change plus a restart, with
 * no deploy. Swapping the *provider* deliberately requires a code change: that
 * is a privacy decision and should not be reachable through an env var.
 *
 * Pricing verified 2026-07-20, in USD per million tokens. Re-check monthly.
 */

const MODEL_REGISTRY = Object.freeze({
  'anthropic:sonnet-5': Object.freeze({
    provider: 'anthropic',
    model: process.env.AI_MODEL_ANTHROPIC_SONNET || 'claude-sonnet-5',
    contextWindow: 1000000,
    // Promotional pricing through 2026-08-31, then 3.00 / 15.00.
    pricing: Object.freeze({ input: 2.0, output: 10.0, cachedInput: 0.2 }),
    capabilities: Object.freeze([
      'generateText', 'generateStructured', 'streamText', 'runToolLoop', 'analyzeImage',
    ]),
    strengths: Object.freeze(['arabic', 'structured_output', 'long_document']),
    enabled: true,
  }),

  'anthropic:haiku-4-5': Object.freeze({
    provider: 'anthropic',
    model: process.env.AI_MODEL_ANTHROPIC_HAIKU || 'claude-haiku-4-5',
    contextWindow: 200000,
    pricing: Object.freeze({ input: 1.0, output: 5.0, cachedInput: 0.1 }),
    capabilities: Object.freeze(['generateText', 'generateStructured', 'streamText']),
    strengths: Object.freeze(['low_latency', 'low_cost']),
    // Documented Arabic quality gap versus Sonnet; excluded from Arabic work.
    notRecommendedFor: Object.freeze(['arabic_drafting', 'arabic_summarization']),
    enabled: true,
  }),

  'openai:main': Object.freeze({
    provider: 'openai',
    model: process.env.AI_MODEL_OPENAI_MAIN || 'gpt-5.6-terra',
    contextWindow: 1050000,
    pricing: Object.freeze({ input: 2.5, output: 15.0, cachedInput: 0.25 }),
    capabilities: Object.freeze([
      'generateText', 'generateStructured', 'streamText', 'runToolLoop', 'analyzeImage', 'embed',
    ]),
    strengths: Object.freeze(['structured_output', 'fallback']),
    // Input ×2 and output ×1.5 above this token count.
    longContextSurchargeAbove: 272000,
    enabled: true,
  }),

  'gemini:flash': Object.freeze({
    provider: 'gemini',
    model: process.env.AI_MODEL_GEMINI_MAIN || 'gemini-3.5-flash',
    contextWindow: 1050000,
    pricing: Object.freeze({ input: 1.5, output: 9.0, cachedInput: 0.15 }),
    capabilities: Object.freeze([
      'generateText', 'generateStructured', 'streamText', 'runToolLoop',
      'analyzeImage', 'embed', 'transcribe',
    ]),
    strengths: Object.freeze(['multimodal', 'document_understanding', 'cost']),
    // Off until a feature needs it AND a paid billing account is verified.
    enabled: false,
    requiresBillingAccount: true,
  }),
});

/**
 * Workload → model policy.
 * Selection order applied by the router: sensitivity → capability → language →
 * context size → cost ceiling → provider health.
 */
const ROUTING_POLICY = Object.freeze({
  arabic_drafting: Object.freeze({
    primary: 'anthropic:sonnet-5', fallback: 'openai:main', maxCostPerCall: 0.05,
  }),
  arabic_summarization: Object.freeze({
    primary: 'anthropic:sonnet-5', fallback: 'openai:main', maxCostPerCall: 0.1,
  }),
  structured_extraction: Object.freeze({
    primary: 'anthropic:sonnet-5', fallback: 'openai:main', maxCostPerCall: 0.05,
  }),
  batch_analysis: Object.freeze({
    primary: 'anthropic:sonnet-5', fallback: null, batch: true, maxCostPerCall: 0.02,
  }),
  low_cost_bulk: Object.freeze({
    primary: 'anthropic:haiku-4-5', fallback: 'openai:main', maxCostPerCall: 0.01,
  }),
});

/**
 * Which provider-to-provider transfers a fallback may perform.
 *
 * The governing rule: a fallback must never move a request from a provider
 * with stronger guarantees to one with weaker guarantees. This is a privacy
 * boundary, not a reliability preference.
 */
const FALLBACK_RULES = Object.freeze({
  'anthropic->openai': Object.freeze({ allowed: true }),
  'openai->anthropic': Object.freeze({ allowed: true }),
  'anthropic->gemini': Object.freeze({
    allowed: false,
    reason: 'requires verified paid tier; free tier permits training on prompts',
  }),
  'openai->gemini': Object.freeze({
    allowed: false,
    reason: 'requires verified paid tier; free tier permits training on prompts',
  }),
  '*->deepseek': Object.freeze({
    allowed: false,
    reason: 'PRC storage, trains by default, open-ended retention',
  }),
});

function getModelEntry(key) {
  return MODEL_REGISTRY[key] || null;
}

module.exports = { MODEL_REGISTRY, ROUTING_POLICY, FALLBACK_RULES, getModelEntry };
