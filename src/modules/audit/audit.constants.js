/**
 * Central audit event vocabulary.
 *
 * Event types are `domain.action` strings. They are stable identifiers written
 * to the database and queried by operators — rename one only with a migration.
 */

const AUDIT_EVENTS = Object.freeze({
  // ── Authentication ──
  AUTH_LOGIN: 'auth.login',
  AUTH_LOGIN_FAILED: 'auth.login_failed',
  AUTH_LOGOUT: 'auth.logout',
  AUTH_PASSWORD_CHANGED: 'auth.password_changed',

  // ── Authorization ──
  PERMISSION_DENIED: 'permission.denied',

  // ── Privileged mutations ──
  USER_ROLE_CHANGED: 'user.role_changed',
  USER_PERMISSIONS_CHANGED: 'user.permissions_changed',
  USER_ACCOUNT_STATUS_CHANGED: 'user.account_status_changed',

  // ── AI ──
  AI_REQUESTED: 'ai.requested',
  AI_COMPLETED: 'ai.completed',
  AI_FAILED: 'ai.failed',
  AI_BLOCKED: 'ai.blocked',
  AI_REDACTION_BLOCKED: 'ai.redaction_blocked',
  AI_QUOTA_EXCEEDED: 'ai.quota_exceeded',
  AI_OUTPUT_REJECTED: 'ai.output_rejected',
});

const AUDIT_EVENT_VALUES = Object.freeze(Object.values(AUDIT_EVENTS));

const AUDIT_OUTCOMES = Object.freeze({
  SUCCESS: 'success',
  FAILURE: 'failure',
  BLOCKED: 'blocked',
});

const AUDIT_OUTCOME_VALUES = Object.freeze(Object.values(AUDIT_OUTCOMES));

/**
 * Metadata keys that must never be persisted, even if a caller passes them.
 * This is a defence-in-depth backstop behind `sanitizeMetadata`; the primary
 * control is that callers pass identifiers, not content.
 */
const AUDIT_METADATA_DENYLIST = Object.freeze([
  'password',
  'currentPassword',
  'newPassword',
  'passwordHash',
  'token',
  'accessToken',
  'refreshToken',
  'apiKey',
  'api_key',
  'secret',
  'authorization',
  'cookie',
  'nationalId',
  'notes',
  'note',
  'content',
  'prompt',
  'completion',
  'response',
  'message',
  'phonePrimary',
  'phoneSecondary',
  'address',
  'email',
]);

// Retention: long enough for an annual review cycle plus investigation lead time.
const AUDIT_RETENTION_DAYS = 400;

module.exports = {
  AUDIT_EVENTS,
  AUDIT_EVENT_VALUES,
  AUDIT_OUTCOMES,
  AUDIT_OUTCOME_VALUES,
  AUDIT_METADATA_DENYLIST,
  AUDIT_RETENTION_DAYS,
};
