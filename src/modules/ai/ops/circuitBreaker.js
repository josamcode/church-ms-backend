/**
 * Per-provider circuit breaker.
 *
 * Stops hammering a provider that is already failing: after N consecutive
 * failures the circuit opens and calls skip straight to the fallback path
 * until a cooldown elapses, then a single probe decides whether to close it.
 *
 * Deliberately in-process rather than Redis-backed. A breaker reflects what
 * *this* instance is observing about *its* connection to the provider; sharing
 * the state would let one unhealthy instance open the circuit for everyone.
 */

const config = require('../../../config/env');
const logger = require('../../../utils/logger');

const STATES = Object.freeze({
  CLOSED: 'closed',
  OPEN: 'open',
  HALF_OPEN: 'half_open',
});

const breakers = new Map();

function getBreaker(provider) {
  if (!breakers.has(provider)) {
    breakers.set(provider, {
      provider,
      state: STATES.CLOSED,
      failureCount: 0,
      successCount: 0,
      openedAt: null,
      lastFailureReason: null,
    });
  }
  return breakers.get(provider);
}

/**
 * May a call to this provider proceed?
 * Transitions OPEN → HALF_OPEN once the cooldown has elapsed.
 */
function canAttempt(provider) {
  const breaker = getBreaker(provider);

  if (breaker.state === STATES.CLOSED) return true;

  if (breaker.state === STATES.OPEN) {
    const elapsed = Date.now() - (breaker.openedAt || 0);
    if (elapsed >= config.ai.circuitBreaker.resetTimeoutMs) {
      breaker.state = STATES.HALF_OPEN;
      logger.info('AI circuit breaker half-open', { provider });
      return true;
    }
    return false;
  }

  // HALF_OPEN: allow the single probe through.
  return true;
}

function recordSuccess(provider) {
  const breaker = getBreaker(provider);
  breaker.successCount += 1;
  breaker.failureCount = 0;

  if (breaker.state !== STATES.CLOSED) {
    logger.info('AI circuit breaker closed', { provider });
    breaker.state = STATES.CLOSED;
    breaker.openedAt = null;
    breaker.lastFailureReason = null;
  }
}

function recordFailure(provider, reason = 'unknown') {
  const breaker = getBreaker(provider);
  breaker.failureCount += 1;
  breaker.lastFailureReason = reason;

  // A failed probe re-opens immediately rather than spending the full
  // threshold again — the provider just told us it is still unhealthy.
  if (breaker.state === STATES.HALF_OPEN) {
    breaker.state = STATES.OPEN;
    breaker.openedAt = Date.now();
    logger.warn('AI circuit breaker re-opened after failed probe', { provider, reason });
    return;
  }

  if (breaker.failureCount >= config.ai.circuitBreaker.failureThreshold) {
    breaker.state = STATES.OPEN;
    breaker.openedAt = Date.now();
    logger.warn('AI circuit breaker opened', {
      provider,
      failureCount: breaker.failureCount,
      reason,
    });
  }
}

function getState(provider) {
  const { state, failureCount, openedAt, lastFailureReason } = getBreaker(provider);
  return { provider, state, failureCount, openedAt, lastFailureReason };
}

function describeAll() {
  return [...breakers.keys()].map((provider) => getState(provider));
}

/** Test hook — resets all breaker state. */
function reset() {
  breakers.clear();
}

module.exports = { canAttempt, recordSuccess, recordFailure, getState, describeAll, reset, STATES };
