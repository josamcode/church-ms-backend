/**
 * The orchestrator — the single path every AI request takes.
 *
 * Gate order is deliberate and each gate is cheap-before-expensive:
 *
 *   1. kill switch / feature flag   — no work if the feature is off
 *   2. spend ceiling                — no work if the budget is gone
 *   3. quota                        — no work if this caller is over allowance
 *   4. prompt render                — build the exact outbound payload
 *   5. REDACTION HARD GATE          — nothing leaves without passing this
 *   6. route selection              — workload → provider + model
 *   7. provider call, with retries  — timeout, backoff, circuit breaker
 *   8. schema validation HARD GATE  — model output is untrusted input
 *   9. output redaction check       — reverse-leak protection
 *  10. metering, audit, usage record
 *
 * The redaction gate sits before route selection on purpose: an unsafe payload
 * must be rejected before any provider is chosen, not after.
 */

const crypto = require('crypto');
const config = require('../../config/env');
const logger = require('../../utils/logger');
const ApiError = require('../../utils/ApiError');
const auditService = require('../audit/audit.service');
const { AUDIT_EVENTS, AUDIT_OUTCOMES } = require('../audit/audit.constants');

const AiUsage = require('./aiUsage.model');
const { AI_ERROR_CATEGORIES, AI_ERROR_CODES } = require('./ai.constants');
const featureFlags = require('./ops/featureFlags');
const quotaService = require('./ops/quota.service');
const costMeter = require('./ops/cost.meter');
const circuitBreaker = require('./ops/circuitBreaker');
const providerHealth = require('./ops/providerHealth');
const { selectRoute, selectFallbackRoute } = require('./routing/model.router');
const { shouldAttemptFallback } = require('./routing/fallback.policy');
const { renderPrompt } = require('./prompts/prompt.registry');
const { assertPayloadSafe, assertOutputSafe, maskText, RedactionBlockedError } = require('./safety/redaction.service');
const { detectInjectionInPayload } = require('./safety/injectionHeuristics');
const { validateAgainstSchema, SchemaValidationError } = require('./schemas/schema.validator');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Persist a usage record. Never throws — metering must not fail a request. */
async function writeUsage(record) {
  try {
    await AiUsage.create(record);
  } catch (error) {
    logger.warn('Failed to write AI usage record', { reason: error.message });
  }
}

/**
 * Call one provider with retry-on-same-provider semantics.
 *
 * Retries here are for transient failures only. A schema failure is retried
 * once with a corrective hint but never moved to another provider — a malformed
 * response almost always means the prompt is wrong, and switching vendors just
 * sends the data somewhere else to fail again.
 */
/**
 * Per-category retry budget (§15.3).
 *
 * A single global retry count cannot express the report's table, which grants a
 * rate-limited call two retries but a timeout only one. `config.ai.limits.
 * maxRetries` is the floor; a category may ask for more but never fewer, so an
 * operator lowering the config still tightens every category.
 */
function retryBudgetFor(category, configuredMax) {
  const PER_CATEGORY = {
    [AI_ERROR_CATEGORIES.RATE_LIMIT]: 2,
    [AI_ERROR_CATEGORIES.TIMEOUT]: 1,
    [AI_ERROR_CATEGORIES.SCHEMA_INVALID]: 1,
  };
  return Math.max(configuredMax, PER_CATEGORY[category] || 0);
}

async function callWithRetries({
  adapter, entry, capability, system, prompt, schema, schemaName, maxTokens, validate = null,
}) {
  const configuredMax = Math.max(Number(config.ai.limits.maxRetries) || 0, 0);
  // Upper bound across all categories; the per-attempt check below still gates
  // each retry on its specific category's budget.
  const maxRetries = Math.max(
    configuredMax,
    retryBudgetFor(AI_ERROR_CATEGORIES.RATE_LIMIT, configuredMax)
  );
  let attempt = 0;
  let lastError = null;

  while (attempt <= maxRetries) {
    try {
      // A retry after a timeout gets a longer budget. Retrying with the same
      // deadline that just expired mostly reproduces the timeout — the point of
      // the retry is to survive a slow response, not to re-run an identical one.
      const timedOut = lastError?.category === AI_ERROR_CATEGORIES.TIMEOUT;
      const timeoutMs = attempt > 0 && timedOut
        ? Math.round(config.ai.limits.requestTimeoutMs * 1.5)
        : null;

      const params = {
        prompt: attempt > 0 && lastError instanceof SchemaValidationError
          ? `${prompt}\n\nYour previous response did not match the required schema (${lastError.errors.join('; ')}). Return only valid data matching the schema.`
          : prompt,
        system,
        model: entry.model,
        maxTokens,
        timeoutMs,
        ...(capability === 'generateStructured' ? { schema, schemaName } : {}),
      };

      const result = await adapter[capability](params);

      // Validation happens INSIDE the retry loop. A malformed response is a
      // provider-attempt failure like any other, so it earns the one corrective
      // retry — validating after the loop would silently skip that.
      if (typeof validate === 'function') {
        result.data = validate(result.data);
      }

      circuitBreaker.recordSuccess(adapter.name);
      return { result, retryCount: attempt };
    } catch (error) {
      lastError = error;
      const isSchemaFailure = error instanceof SchemaValidationError;
      const category = isSchemaFailure
        ? AI_ERROR_CATEGORIES.SCHEMA_INVALID
        : error.category || AI_ERROR_CATEGORIES.SERVER_ERROR;

      // A schema failure says the prompt is wrong, not that the provider is
      // unhealthy. Counting it toward the breaker would open the circuit on a
      // provider that is answering perfectly well.
      if (!isSchemaFailure) {
        circuitBreaker.recordFailure(adapter.name, category);
      }

      const isRetryable =
        category === AI_ERROR_CATEGORIES.TIMEOUT
        || category === AI_ERROR_CATEGORIES.RATE_LIMIT
        || error instanceof SchemaValidationError;

      // `attempt` is 0-based, so "attempt >= budget" means the budget of
      // retries beyond the first try is spent. A 429's budget of 2 permits
      // attempts 1 and 2; a timeout's budget of 1 permits attempt 1 only.
      const budget = retryBudgetFor(category, configuredMax);
      if (attempt >= budget || !isRetryable) throw error;

      // Exponential backoff, only for rate limits.
      if (category === AI_ERROR_CATEGORIES.RATE_LIMIT) {
        await sleep(Math.min(1000 * 2 ** attempt, 8000));
      }
      attempt += 1;
    }
  }

  throw lastError;
}

/**
 * Run one AI feature end to end.
 *
 * @param {object} params
 * @param {string} params.feature
 * @param {string} params.workload
 * @param {string} params.sensitivity
 * @param {string} params.capability
 * @param {object} params.schema
 * @param {string} params.schemaName
 * @param {string} params.promptKey
 * @param {object} params.input        the payload to be sent (pre-redaction-gate)
 * @param {object} params.context      AiRequestContext
 * @param {function} [params.postValidate] server-side checks on the parsed output
 */
async function orchestrate({
  feature,
  workload,
  sensitivity,
  capability = 'generateStructured',
  schema,
  schemaName,
  promptKey,
  input,
  context,
  postValidate = null,
  maxTokens = 2048,
}) {
  const startedAt = Date.now();
  const { userId, role, requestId } = context;

  const auditBase = {
    actorUserId: userId || null,
    actorRole: role || null,
    requestId: requestId || null,
    feature,
  };

  // ── 1. Kill switch and feature flag ──────────────────────────────────────
  if (!featureFlags.isAiEnabled()) {
    throw ApiError.serviceUnavailable('AI features are disabled', AI_ERROR_CODES.AI_DISABLED);
  }
  if (!featureFlags.isFeatureEnabled(feature)) {
    throw ApiError.serviceUnavailable('This AI feature is disabled', AI_ERROR_CODES.AI_DISABLED);
  }

  // ── 2. Spend ceiling ─────────────────────────────────────────────────────
  const spend = await costMeter.checkSpendLimits();
  if (!spend.withinBudget) {
    await auditService.recordAiEvent({
      ...auditBase,
      eventType: AUDIT_EVENTS.AI_QUOTA_EXCEEDED,
      outcome: AUDIT_OUTCOMES.BLOCKED,
      metadata: { scope: 'spend', reason: spend.reason },
    });
    throw ApiError.serviceUnavailable('AI spending limit reached', AI_ERROR_CODES.AI_QUOTA_EXCEEDED);
  }

  // ── 3. Quota ─────────────────────────────────────────────────────────────
  const quota = await quotaService.checkQuota({ userId, role, feature });
  if (!quota.allowed) {
    await auditService.recordAiEvent({
      ...auditBase,
      eventType: AUDIT_EVENTS.AI_QUOTA_EXCEEDED,
      outcome: AUDIT_OUTCOMES.BLOCKED,
      metadata: { scope: quota.scope, limit: quota.limit, used: quota.used },
    });
    throw new ApiError(429, 'AI usage quota exceeded for today', AI_ERROR_CODES.AI_QUOTA_EXCEEDED);
  }

  await auditService.recordAiEvent({
    ...auditBase,
    eventType: AUDIT_EVENTS.AI_REQUESTED,
    outcome: AUDIT_OUTCOMES.SUCCESS,
    metadata: { workload, sensitivity },
  });

  // ── 4. Render the prompt ─────────────────────────────────────────────────
  const rendered = renderPrompt(promptKey, input);

  // ── 5. REDACTION HARD GATE ───────────────────────────────────────────────
  // Applied to the structured input AND to the fully-rendered prompt text,
  // because interpolation is exactly where an unexpected value would appear.
  try {
    assertPayloadSafe(input);
    assertPayloadSafe({ renderedPrompt: rendered.prompt });
  } catch (error) {
    if (error instanceof RedactionBlockedError) {
      // A single occurrence is treated as a security incident, not a metric.
      logger.error('AI redaction gate blocked an outbound payload', {
        feature,
        requestId,
        violations: error.violations,
      });
      await auditService.recordAiEvent({
        ...auditBase,
        eventType: AUDIT_EVENTS.AI_REDACTION_BLOCKED,
        outcome: AUDIT_OUTCOMES.BLOCKED,
        metadata: { violations: error.violations },
      });
      await writeUsage({
        requestId, userId, userRole: role, feature,
        provider: 'none', model: 'none',
        redactionBlocked: true,
        promptVersion: rendered.version,
        promptHash: rendered.promptHash,
      });
      throw new ApiError(422, 'Request contains data that may not be sent to an AI provider', AI_ERROR_CODES.AI_INPUT_BLOCKED);
    }
    throw error;
  }

  // Injection heuristics are advisory: recorded, never blocking. Phase 1 ships
  // zero tools, so an injected instruction has nothing to actuate.
  const injection = detectInjectionInPayload(input);
  if (injection.suspicious) {
    logger.warn('Possible prompt injection in AI input', {
      feature, requestId, matches: injection.matches,
    });
  }

  // ── 6-7. Route, call, fall back ──────────────────────────────────────────
  // Rough token estimate for routing decisions only — never for billing, which
  // uses the provider's own reported counts. ~3 chars/token is conservative for
  // mixed Arabic/English; over-estimating is the safe direction here because it
  // can only reject a model, never smuggle an oversized prompt into one.
  const estimatedInputTokens = Math.ceil(
    (rendered.prompt.length + (rendered.system?.length || 0)) / 3
  );

  const route = selectRoute({
    workload,
    capability,
    language: context.language || 'ar',
    sensitivity,
    estimatedInputTokens,
    maxOutputTokens: maxTokens,
  });

  /**
   * Consume quota the moment a provider is contacted, whatever the outcome.
   *
   * Charging only on success would make a failing request free, so a client
   * stuck in a retry loop could burn provider spend indefinitely without ever
   * touching its daily allowance. Idempotent per call via `quotaConsumed`.
   */
  let quotaConsumed = false;
  const consumeQuotaOnce = async () => {
    if (quotaConsumed) return;
    quotaConsumed = true;
    await quotaService.consumeQuota({ userId, role, feature });
  };

  let result = null;
  let usedFallback = false;
  let retryCount = 0;
  let activeRoute = route;
  let errorCategory = null;

  // ── 8. SCHEMA HARD GATE, applied inside the retry loop ───────────────────
  const validateOutput = capability === 'generateStructured'
    ? (data) => validateAgainstSchema(data, schema, schemaName)
    : null;

  try {
    await consumeQuotaOnce();
    const attempt = await callWithRetries({
      adapter: route.adapter,
      entry: route.entry,
      capability, system: rendered.system, prompt: rendered.prompt,
      schema, schemaName, maxTokens, validate: validateOutput,
    });
    result = attempt.result;
    retryCount = attempt.retryCount;
    providerHealth.recordCall(route.entry.provider, {
      success: true, latencyMs: result.latencyMs,
    });
  } catch (primaryError) {
    errorCategory = primaryError instanceof SchemaValidationError
      ? AI_ERROR_CATEGORIES.SCHEMA_INVALID
      : primaryError.category || AI_ERROR_CATEGORIES.SERVER_ERROR;

    providerHealth.recordCall(route.entry.provider, {
      success: false, latencyMs: Date.now() - startedAt, errorCategory,
    });

    // A schema failure that survived its corrective retry is an unusable
    // response, not an unavailable service. Reporting it as 503 would tell the
    // operator to check the provider when the prompt is what needs attention.
    if (primaryError instanceof SchemaValidationError) {
      await auditService.recordAiEvent({
        ...auditBase,
        eventType: AUDIT_EVENTS.AI_OUTPUT_REJECTED,
        outcome: AUDIT_OUTCOMES.BLOCKED,
        // Schema errors can quote a fragment of model output (a JSON parse
        // error embeds the offending text), so each is masked for value
        // patterns before it enters the 400-day audit store.
        metadata: { reason: 'schema_invalid', errors: (primaryError.errors || []).map(maskText) },
      });
      await writeUsage({
        requestId, userId, userRole: role, feature,
        provider: route.entry.provider, model: route.entry.model,
        schemaValid: false,
        schemaRetries: Math.max(Number(config.ai.limits.maxRetries) || 0, 0),
        providerErrorCategory: AI_ERROR_CATEGORIES.SCHEMA_INVALID,
        latencyMs: Date.now() - startedAt,
        promptVersion: rendered.version, promptHash: rendered.promptHash,
      });
      throw new ApiError(502, 'AI produced an unusable response', AI_ERROR_CODES.AI_OUTPUT_INVALID);
    }

    const fallback = shouldAttemptFallback(errorCategory)
      ? selectFallbackRoute({
          workload, capability,
          language: context.language || 'ar',
          sensitivity,
          failedProvider: route.entry.provider,
        })
      : null;

    if (!fallback || fallback.blocked) {
      logger.warn('AI request failed with no permitted fallback', {
        feature, requestId, errorCategory,
        reason: fallback?.reason || 'fallback not attempted for this error category',
      });
      await auditService.recordAiEvent({
        ...auditBase,
        eventType: AUDIT_EVENTS.AI_FAILED,
        outcome: AUDIT_OUTCOMES.FAILURE,
        metadata: { errorCategory, fallbackReason: fallback?.reason || null },
      });
      await writeUsage({
        requestId, userId, userRole: role, feature,
        provider: route.entry.provider, model: route.entry.model,
        providerErrorCategory: errorCategory,
        latencyMs: Date.now() - startedAt,
        promptVersion: rendered.version, promptHash: rendered.promptHash,
      });
      throw ApiError.serviceUnavailable('AI service is temporarily unavailable', AI_ERROR_CODES.AI_UNAVAILABLE);
    }

    activeRoute = fallback;
    usedFallback = true;

    try {
      const attempt = await callWithRetries({
        adapter: fallback.adapter,
        entry: fallback.entry,
        capability, system: rendered.system, prompt: rendered.prompt,
        schema, schemaName, maxTokens, validate: validateOutput,
      });
      result = attempt.result;
      retryCount = attempt.retryCount;
      providerHealth.recordCall(fallback.entry.provider, {
        success: true, latencyMs: result.latencyMs,
      });
    } catch (fallbackError) {
      const category = fallbackError.category || AI_ERROR_CATEGORIES.SERVER_ERROR;
      providerHealth.recordCall(fallback.entry.provider, {
        success: false, latencyMs: Date.now() - startedAt, errorCategory: category,
      });
      await auditService.recordAiEvent({
        ...auditBase,
        eventType: AUDIT_EVENTS.AI_FAILED,
        outcome: AUDIT_OUTCOMES.FAILURE,
        metadata: { errorCategory: category, usedFallback: true },
      });
      throw ApiError.serviceUnavailable('AI service is temporarily unavailable', AI_ERROR_CODES.AI_UNAVAILABLE);
    }
  }

  // Quota was already charged when the provider was first contacted (see
  // consumeQuotaOnce above). Charging again here would double-count, and
  // charging only on success would make a failing retry loop free.

  // `result.data` is already schema-validated: the gate ran inside the retry
  // loop so a malformed response could earn its one corrective retry.
  let validated = result.data;

  // ── 9. Server-side post-validation and reverse-leak check ────────────────
  if (typeof postValidate === 'function') {
    try {
      validated = postValidate(validated, input);
    } catch (error) {
      await auditService.recordAiEvent({
        ...auditBase,
        eventType: AUDIT_EVENTS.AI_OUTPUT_REJECTED,
        outcome: AUDIT_OUTCOMES.BLOCKED,
        // A post-validation message can echo model-chosen strings (e.g. an
        // invented metric key), so it is masked before being audited.
        metadata: { reason: 'post_validation_failed', detail: maskText(error.message) },
      });
      throw new ApiError(502, error.message || 'AI produced an unusable response', AI_ERROR_CODES.AI_OUTPUT_INVALID);
    }
  }

  try {
    assertOutputSafe(validated);
  } catch (error) {
    logger.error('AI output contained denylisted content', {
      feature, requestId, violations: error.violations,
    });
    await auditService.recordAiEvent({
      ...auditBase,
      eventType: AUDIT_EVENTS.AI_REDACTION_BLOCKED,
      outcome: AUDIT_OUTCOMES.BLOCKED,
      metadata: { direction: 'output', violations: error.violations },
    });
    throw new ApiError(502, 'AI produced an unusable response', AI_ERROR_CODES.AI_OUTPUT_INVALID);
  }

  // ── 10. Meter, audit, record ─────────────────────────────────────────────
  const estimatedCostUsd = costMeter.estimateCostUsd(activeRoute.modelKey, result.usage);
  await costMeter.recordSpend(estimatedCostUsd);

  const latencyMs = Date.now() - startedAt;

  await auditService.recordAiEvent({
    ...auditBase,
    eventType: AUDIT_EVENTS.AI_COMPLETED,
    outcome: AUDIT_OUTCOMES.SUCCESS,
    metadata: {
      provider: result.provider,
      model: result.model,
      usedFallback,
      retryCount,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      estimatedCostUsd,
      latencyMs,
      promptVersion: rendered.version,
    },
  });

  await writeUsage({
    requestId, userId, userRole: role, feature,
    provider: result.provider, model: result.model,
    inputTokens: result.usage.inputTokens,
    outputTokens: result.usage.outputTokens,
    cachedInputTokens: result.usage.cachedInputTokens,
    estimatedCostUsd,
    latencyMs, retryCount, usedFallback,
    schemaValid: true,
    // Non-zero means the model needed a corrective nudge — the leading signal
    // that a prompt revision is drifting out of alignment with its schema.
    schemaRetries: retryCount,
    humanApproval: 'pending',
    promptVersion: rendered.version,
    promptHash: rendered.promptHash,
  });

  return {
    data: validated,
    meta: {
      provider: result.provider,
      model: result.model,
      usedFallback,
      requestId,
      promptVersion: rendered.version,
      tokensUsed: result.usage.inputTokens + result.usage.outputTokens,
    },
  };
}

/** Stable fingerprint helper, exported for tests. */
function hashText(text) {
  return crypto.createHash('sha256').update(String(text)).digest('hex').slice(0, 16);
}

module.exports = { orchestrate, hashText, callWithRetries };
