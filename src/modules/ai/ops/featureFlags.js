/**
 * Feature flags and kill switches.
 *
 * Every check reads `config` at call time rather than caching a boolean at
 * module load. That is what makes disabling AI a secret change plus a restart
 * instead of a deploy — and it means a kill switch takes effect on the very
 * next request rather than the next release.
 */

const config = require('../../../config/env');
const { AI_FEATURES } = require('../ai.constants');

/** Master switch. False disables every AI path unconditionally. */
function isAiEnabled() {
  return config.ai.enabled === true;
}

const FEATURE_FLAG_KEYS = Object.freeze({
  [AI_FEATURES.NOTIFICATION_DRAFT]: 'notificationDraft',
  [AI_FEATURES.ANALYTICS_NARRATIVE]: 'analyticsNarrative',
  [AI_FEATURES.IMPORT_AMBIGUITY]: 'importAmbiguity',
});

/**
 * Is a specific feature live?
 * The master switch dominates: a feature cannot be on while AI is off.
 */
function isFeatureEnabled(feature) {
  if (!isAiEnabled()) return false;

  const key = FEATURE_FLAG_KEYS[feature];
  // An unknown feature key is off. Failing closed means a typo disables a
  // feature rather than enabling an unintended one.
  if (!key) return false;

  return config.ai.features[key] === true;
}

/**
 * Is a provider usable right now?
 * Requires the flag, a credential, and — for Gemini — verified paid billing.
 */
function isProviderEnabled(provider) {
  const providerConfig = config.ai.providers[provider];
  if (!providerConfig || providerConfig.enabled !== true) return false;
  if (!providerConfig.apiKey) return false;

  if (provider === 'gemini' && providerConfig.billingAccountVerified !== true) {
    return false;
  }

  return true;
}

/** Providers currently usable, in no particular order. */
function enabledProviders() {
  return Object.keys(config.ai.providers).filter((name) => isProviderEnabled(name));
}

/** A snapshot for health endpoints and diagnostics. Never includes secrets. */
function describeFlags() {
  return {
    aiEnabled: isAiEnabled(),
    features: Object.fromEntries(
      Object.values(AI_FEATURES).map((feature) => [feature, isFeatureEnabled(feature)])
    ),
    providers: Object.fromEntries(
      Object.keys(config.ai.providers).map((name) => [name, isProviderEnabled(name)])
    ),
  };
}

module.exports = {
  isAiEnabled,
  isFeatureEnabled,
  isProviderEnabled,
  enabledProviders,
  describeFlags,
};
