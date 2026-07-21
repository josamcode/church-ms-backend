/**
 * Resolves `workload + capability + sensitivity` to a concrete provider and
 * model. This is the indirection that keeps provider and model names out of
 * every feature file.
 *
 * Selection order, applied in sequence:
 *   sensitivity → capability → language → context size → cost ceiling → health
 */

const { MODEL_REGISTRY, ROUTING_POLICY, getModelEntry } = require('./model.registry');
const { isFallbackAllowed } = require('./fallback.policy');
const { anthropicAdapter } = require('../providers/anthropic.adapter');
const { openaiAdapter } = require('../providers/openai.adapter');
const { geminiAdapter } = require('../providers/gemini.adapter');
const { assertValidAdapter } = require('../providers/provider.interface');
const { REJECTED_PROVIDERS } = require('../providers/capabilities');
const featureFlags = require('../ops/featureFlags');
const circuitBreaker = require('../ops/circuitBreaker');
const providerHealth = require('../ops/providerHealth');

const ADAPTERS = Object.freeze({
  anthropic: assertValidAdapter(anthropicAdapter),
  openai: assertValidAdapter(openaiAdapter),
  gemini: assertValidAdapter(geminiAdapter),
});

/**
 * @throws if the provider is rejected or unknown — never returns a usable
 * adapter for a provider the project has ruled out.
 */
function resolveAdapter(provider) {
  if (REJECTED_PROVIDERS[provider]) {
    throw new Error(`Provider "${provider}" is rejected: ${REJECTED_PROVIDERS[provider]}`);
  }
  const adapter = ADAPTERS[provider];
  if (!adapter) {
    throw new Error(`Unknown AI provider "${provider}"`);
  }
  return adapter;
}

/** Is this model key usable for this capability and language right now? */
function isCandidateUsable(
  modelKey,
  { capability, language, estimatedInputTokens = 0, maxOutputTokens = 2048, policy = null }
) {
  const entry = getModelEntry(modelKey);
  if (!entry) return { usable: false, reason: 'unknown model key' };
  if (entry.enabled === false) return { usable: false, reason: 'model disabled in registry' };

  if (!entry.capabilities.includes(capability)) {
    return { usable: false, reason: `model does not support ${capability}` };
  }

  // Context window. A prompt that cannot fit is a guaranteed provider error;
  // rejecting here turns it into a routing decision that can fall through to a
  // larger-context model instead of a failed call.
  if (estimatedInputTokens > 0 && estimatedInputTokens > entry.contextWindow) {
    return {
      usable: false,
      reason: `prompt ~${estimatedInputTokens} tokens exceeds ${entry.contextWindow} context window`,
    };
  }

  // Per-call cost ceiling. Distinct from the daily/monthly spend caps: those
  // stop the aggregate, this stops one pathological request. Projected against
  // the estimated input plus the response budget this call actually requested —
  // assuming a fixed worst-case output would make cheap workloads unroutable.
  if (policy?.maxCostPerCall && estimatedInputTokens > 0) {
    const projectedUsd =
      (estimatedInputTokens / 1000000) * entry.pricing.input
      + (maxOutputTokens / 1000000) * entry.pricing.output;
    if (projectedUsd > policy.maxCostPerCall) {
      return {
        usable: false,
        reason: `projected cost $${projectedUsd.toFixed(4)} exceeds ceiling $${policy.maxCostPerCall}`,
      };
    }
  }

  if (!featureFlags.isProviderEnabled(entry.provider)) {
    return { usable: false, reason: `provider ${entry.provider} disabled or unconfigured` };
  }

  const adapter = ADAPTERS[entry.provider];
  if (!adapter || !adapter.supports(capability)) {
    return { usable: false, reason: `adapter ${entry.provider} lacks ${capability}` };
  }

  // A documented Arabic quality gap disqualifies a model from Arabic work even
  // though it is otherwise capable and cheaper.
  if (language === 'ar' && Array.isArray(entry.notRecommendedFor)) {
    const arabicWorkloads = entry.notRecommendedFor.filter((w) => w.startsWith('arabic'));
    if (arabicWorkloads.length > 0) {
      return { usable: false, reason: 'model not recommended for Arabic output' };
    }
  }

  if (!circuitBreaker.canAttempt(entry.provider)) {
    return { usable: false, reason: `circuit open for ${entry.provider}` };
  }

  return { usable: true };
}

/**
 * Pick the primary route.
 * @returns {{modelKey, entry, adapter, policy}}
 * @throws when no model can serve the request.
 */
function selectRoute({
  workload, capability, language = 'ar', sensitivity,
  estimatedInputTokens = 0, maxOutputTokens = 2048,
}) {
  const policy = ROUTING_POLICY[workload];
  if (!policy) {
    throw new Error(`No routing policy defined for workload "${workload}"`);
  }

  const primaryEntry = getModelEntry(policy.primary);
  const attempts = [];

  for (const modelKey of [policy.primary, policy.fallback].filter(Boolean)) {
    const check = isCandidateUsable(modelKey, {
      capability, language, estimatedInputTokens, maxOutputTokens, policy,
    });
    if (!check.usable) {
      attempts.push(`${modelKey}: ${check.reason}`);
      continue;
    }

    const entry = getModelEntry(modelKey);

    // Reaching the fallback model here means the primary was unusable before a
    // single call was made — an open circuit, a disabled provider, a language
    // exclusion. That is still a provider switch, so it must clear the same
    // privacy gate as a post-failure fallback. Without this check a
    // `sensitive` workload would quietly cross to a second vendor on its FIRST
    // attempt, which §15.4 forbids absolutely.
    if (modelKey !== policy.primary) {
      // Fail closed if the origin provider cannot be identified: a fallback
      // gate that cannot determine what it is moving away from must not permit
      // the move. `from: null` makes `isFallbackAllowed` deny the transfer
      // (no `null->x` rule exists), and a sensitive band is refused outright.
      const fromProvider = primaryEntry ? primaryEntry.provider : null;
      if (fromProvider !== entry.provider) {
        const permission = isFallbackAllowed({
          from: fromProvider,
          to: entry.provider,
          sensitivity,
        });
        if (!permission.allowed) {
          attempts.push(`${modelKey}: ${permission.reason}`);
          continue;
        }
      }
    }

    return { modelKey, entry, adapter: resolveAdapter(entry.provider), policy };
  }

  const error = new Error(
    `No AI model available for workload "${workload}" (${attempts.join('; ')})`
  );
  error.code = 'NO_ROUTE_AVAILABLE';
  throw error;
}

/**
 * Pick the fallback route after a primary failure.
 *
 * Returns null — rather than throwing — when no fallback is permitted, because
 * "no fallback" is an ordinary, expected outcome that the orchestrator turns
 * into a graceful degradation.
 */
function selectFallbackRoute({ workload, capability, language = 'ar', sensitivity, failedProvider }) {
  const policy = ROUTING_POLICY[workload];
  if (!policy || !policy.fallback) return null;

  const entry = getModelEntry(policy.fallback);
  if (!entry) return null;

  const permission = isFallbackAllowed({
    from: failedProvider,
    to: entry.provider,
    sensitivity,
  });
  if (!permission.allowed) {
    return { blocked: true, reason: permission.reason };
  }

  const check = isCandidateUsable(policy.fallback, { capability, language });
  if (!check.usable) {
    return { blocked: true, reason: check.reason };
  }

  return {
    modelKey: policy.fallback,
    entry,
    adapter: resolveAdapter(entry.provider),
    policy,
  };
}

/** Diagnostics for a health endpoint. Contains no secrets. */
function describeRouting() {
  return {
    models: Object.entries(MODEL_REGISTRY).map(([key, entry]) => ({
      key,
      provider: entry.provider,
      enabled: entry.enabled !== false,
      providerEnabled: featureFlags.isProviderEnabled(entry.provider),
      circuit: circuitBreaker.getState(entry.provider).state,
      health: providerHealth.getHealth(entry.provider).healthy,
    })),
    policies: ROUTING_POLICY,
  };
}

module.exports = {
  resolveAdapter,
  selectRoute,
  selectFallbackRoute,
  isCandidateUsable,
  describeRouting,
  ADAPTERS,
};
