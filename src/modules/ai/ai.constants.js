/**
 * Stable identifiers for the AI module.
 */

/** Feature keys. Used for flags, quotas, audit, and usage metering. */
const AI_FEATURES = Object.freeze({
  NOTIFICATION_DRAFT: 'notification_draft',
  ANALYTICS_NARRATIVE: 'analytics_narrative',
  IMPORT_AMBIGUITY: 'import_ambiguity',
});

const AI_FEATURE_VALUES = Object.freeze(Object.values(AI_FEATURES));

/**
 * Workload classes. Business code asks for a workload, never a model —
 * that indirection is what keeps provider names out of feature files.
 */
const AI_WORKLOADS = Object.freeze({
  ARABIC_DRAFTING: 'arabic_drafting',
  ARABIC_SUMMARIZATION: 'arabic_summarization',
  STRUCTURED_EXTRACTION: 'structured_extraction',
  BATCH_ANALYSIS: 'batch_analysis',
  LOW_COST_BULK: 'low_cost_bulk',
});

/**
 * Sensitivity bands. Drive which providers are eligible and whether a failed
 * call may fall back to a second provider at all.
 */
const AI_SENSITIVITY = Object.freeze({
  PUBLIC: 'public',
  INTERNAL: 'internal',
  SENSITIVE: 'sensitive',
});

const AI_CAPABILITIES = Object.freeze({
  GENERATE_TEXT: 'generateText',
  GENERATE_STRUCTURED: 'generateStructured',
  STREAM_TEXT: 'streamText',
  EMBED: 'embed',
  TRANSCRIBE: 'transcribe',
  GENERATE_SPEECH: 'generateSpeech',
  ANALYZE_IMAGE: 'analyzeImage',
  RUN_TOOL_LOOP: 'runToolLoop',
});

/** Normalized provider failure categories, for metrics and retry decisions. */
const AI_ERROR_CATEGORIES = Object.freeze({
  TIMEOUT: 'timeout',
  RATE_LIMIT: 'rate_limit',
  SERVER_ERROR: 'server_error',
  INVALID_REQUEST: 'invalid_request',
  AUTH_ERROR: 'auth_error',
  SCHEMA_INVALID: 'schema_invalid',
  CIRCUIT_OPEN: 'circuit_open',
  DISABLED: 'disabled',
  QUOTA_EXCEEDED: 'quota_exceeded',
  REDACTION_BLOCKED: 'redaction_blocked',
});

/** Error codes returned to clients. Mirrored in the frontend i18n. */
const AI_ERROR_CODES = Object.freeze({
  AI_DISABLED: 'AI_DISABLED',
  AI_UNAVAILABLE: 'AI_UNAVAILABLE',
  AI_QUOTA_EXCEEDED: 'AI_QUOTA_EXCEEDED',
  AI_OUTPUT_INVALID: 'AI_OUTPUT_INVALID',
  AI_INPUT_BLOCKED: 'AI_INPUT_BLOCKED',
});

/**
 * Per-user, per-role and per-feature daily quotas, plus hard spend ceilings.
 * Set roughly ten times expected usage: these protect against anomalies, they
 * are not a throttle on normal work.
 */
const AI_QUOTAS = Object.freeze({
  perUser: Object.freeze({
    [AI_FEATURES.NOTIFICATION_DRAFT]: 50,
    [AI_FEATURES.ANALYTICS_NARRATIVE]: 30,
    [AI_FEATURES.IMPORT_AMBIGUITY]: 5,
  }),
  perRole: Object.freeze({
    SUPER_ADMIN: 200,
    ADMIN: 100,
    USER: 0,
  }),
  perFeature: Object.freeze({
    [AI_FEATURES.NOTIFICATION_DRAFT]: 500,
    [AI_FEATURES.ANALYTICS_NARRATIVE]: 300,
    [AI_FEATURES.IMPORT_AMBIGUITY]: 50,
  }),
});

/** Server-side output length caps, matched to the Mongoose schema limits. */
const AI_OUTPUT_LIMITS = Object.freeze({
  notificationTitle: 160,
  notificationSummary: 500,
  narrativeLength: 4000,
  reasoningLength: 1000,
});

module.exports = {
  AI_FEATURES,
  AI_FEATURE_VALUES,
  AI_WORKLOADS,
  AI_SENSITIVITY,
  AI_CAPABILITIES,
  AI_ERROR_CATEGORIES,
  AI_ERROR_CODES,
  AI_QUOTAS,
  AI_OUTPUT_LIMITS,
};
