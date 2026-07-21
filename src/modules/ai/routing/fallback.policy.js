/**
 * Fallback admissibility.
 *
 * Separated from the router so the privacy rule can be read, reviewed, and
 * tested on its own. Two independent gates must both pass:
 *
 *   1. The workload's sensitivity must tolerate a fallback at all.
 *   2. The specific provider transfer must be on the allow-list.
 */

const { FALLBACK_RULES } = require('./model.registry');
const { REJECTED_PROVIDERS } = require('../providers/capabilities');
const { AI_SENSITIVITY } = require('../ai.constants');

/**
 * @param {object} params
 * @param {string} params.from        - originating provider
 * @param {string} params.to          - candidate provider
 * @param {string} params.sensitivity - workload sensitivity band
 * @returns {{ allowed: boolean, reason?: string }}
 */
function isFallbackAllowed({ from, to, sensitivity }) {
  if (!to) {
    return { allowed: false, reason: 'no fallback configured for this workload' };
  }

  if (REJECTED_PROVIDERS[to]) {
    return { allowed: false, reason: `provider rejected: ${REJECTED_PROVIDERS[to]}` };
  }

  // Normalize before the sensitivity comparison. A strict `=== 'sensitive'`
  // check fails OPEN on `'Sensitive'`, `' sensitive '`, or a stray casing —
  // the wrong direction for a privacy gate. Treat any unrecognized value as
  // sensitive too, so a typo blocks a fallback rather than permitting one.
  const band = String(sensitivity ?? '').trim().toLowerCase();
  const KNOWN_BANDS = new Set([
    AI_SENSITIVITY.PUBLIC, AI_SENSITIVITY.INTERNAL, AI_SENSITIVITY.SENSITIVE,
  ]);
  if (band === AI_SENSITIVITY.SENSITIVE || !KNOWN_BANDS.has(band)) {
    return {
      allowed: false,
      reason: band === AI_SENSITIVITY.SENSITIVE
        ? 'sensitive workloads must not be retried on a different provider'
        : `unrecognized sensitivity "${sensitivity}" treated as sensitive; fallback refused`,
    };
  }

  if (from === to) {
    return { allowed: false, reason: 'fallback target equals origin' };
  }

  const wildcard = FALLBACK_RULES[`*->${to}`];
  if (wildcard && wildcard.allowed === false) {
    return { allowed: false, reason: wildcard.reason };
  }

  const rule = FALLBACK_RULES[`${from}->${to}`];
  if (!rule) {
    // Unlisted transfers are denied. An allow-list that defaults to "permit"
    // is not an allow-list.
    return { allowed: false, reason: `no fallback rule defined for ${from}->${to}` };
  }

  return rule.allowed
    ? { allowed: true }
    : { allowed: false, reason: rule.reason };
}

/**
 * Whether a given provider failure should be retried elsewhere at all.
 *
 * A schema-validation failure is excluded deliberately: it almost always
 * indicates a prompt problem rather than a provider problem, so moving vendors
 * changes nothing and costs a second copy of the data.
 */
function shouldAttemptFallback(errorCategory) {
  const NON_FALLBACKABLE = new Set(['schema_invalid', 'invalid_request', 'quota_exceeded', 'redaction_blocked']);
  return !NON_FALLBACKABLE.has(errorCategory);
}

module.exports = { isFallbackAllowed, shouldAttemptFallback };
