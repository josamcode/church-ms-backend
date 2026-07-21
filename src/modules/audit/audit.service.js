const crypto = require('crypto');
const AuditLog = require('./auditLog.model');
const logger = require('../../utils/logger');
const {
  AUDIT_EVENTS,
  AUDIT_OUTCOMES,
  AUDIT_METADATA_DENYLIST,
} = require('./audit.constants');

const MAX_STRING_LENGTH = 512;
const MAX_ARRAY_LENGTH = 50;
const MAX_OBJECT_KEYS = 50;
const MAX_DEPTH = 4;
const MAX_RESOURCE_IDS = 100;

const DENYLIST = new Set(AUDIT_METADATA_DENYLIST.map((key) => key.toLowerCase()));

/**
 * One-way identifier fingerprint.
 *
 * Failed logins must be attributable ("the same identifier was tried 40 times")
 * without persisting the identifier itself, which is PII and often a real email
 * or phone number. A truncated SHA-256 correlates attempts without being
 * reversible or directly readable.
 */
function fingerprint(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return null;
  return crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 16);
}

/**
 * Recursively strip denylisted keys and cap the size of an audit metadata blob.
 *
 * Audit metadata is meant to hold identifiers, counts, and enum values. This
 * sanitizer is the backstop that keeps a careless caller from persisting record
 * contents, credentials, or personal fields into a 400-day retention store.
 */
function sanitizeMetadata(value, depth = 0) {
  if (value === null || value === undefined) return null;

  if (depth > MAX_DEPTH) return '[truncated: max depth]';

  if (typeof value === 'string') {
    return value.length > MAX_STRING_LENGTH
      ? `${value.slice(0, MAX_STRING_LENGTH)}…[truncated]`
      : value;
  }

  if (typeof value === 'number' || typeof value === 'boolean') return value;

  if (value instanceof Date) return value.toISOString();

  if (Array.isArray(value)) {
    const capped = value.slice(0, MAX_ARRAY_LENGTH).map((entry) => sanitizeMetadata(entry, depth + 1));
    if (value.length > MAX_ARRAY_LENGTH) {
      capped.push(`[truncated: ${value.length - MAX_ARRAY_LENGTH} more]`);
    }
    return capped;
  }

  if (typeof value === 'object') {
    const out = {};
    let keyCount = 0;

    for (const [key, entry] of Object.entries(value)) {
      if (keyCount >= MAX_OBJECT_KEYS) {
        out['[truncated]'] = true;
        break;
      }
      if (DENYLIST.has(String(key).toLowerCase())) {
        out[key] = '[redacted]';
        keyCount += 1;
        continue;
      }
      out[key] = sanitizeMetadata(entry, depth + 1);
      keyCount += 1;
    }

    return out;
  }

  // Functions, symbols, bigints: not audit data.
  return null;
}

function normalizeResourceIds(resourceIds) {
  if (!resourceIds) return [];
  const list = Array.isArray(resourceIds) ? resourceIds : [resourceIds];
  return list
    .filter((id) => id !== null && id !== undefined)
    .slice(0, MAX_RESOURCE_IDS)
    .map((id) => String(id).slice(0, 128));
}

class AuditService {
  /**
   * Write one audit entry.
   *
   * **Never throws and never rejects.** An audit backend problem must not turn
   * a successful login into a 500. Failures are logged at `error` so they are
   * still visible in the application logs and to alerting.
   *
   * @returns {Promise<object|null>} the persisted document, or null on failure.
   */
  async record({
    eventType,
    actorUserId = null,
    actorRole = null,
    requestId = null,
    outcome = AUDIT_OUTCOMES.SUCCESS,
    resource = null,
    resourceIds = [],
    metadata = null,
    ip = null,
    userAgent = null,
  } = {}) {
    try {
      if (!eventType) {
        logger.warn('Audit record skipped: missing eventType');
        return null;
      }

      return await AuditLog.create({
        eventType,
        actorUserId: actorUserId || null,
        actorRole: actorRole || null,
        requestId: requestId ? String(requestId).slice(0, 128) : null,
        outcome,
        resource,
        resourceIds: normalizeResourceIds(resourceIds),
        metadata: sanitizeMetadata(metadata),
        ip: ip ? String(ip).slice(0, 64) : null,
        userAgent: userAgent ? String(userAgent).slice(0, 256) : null,
        createdAt: new Date(),
      });
    } catch (error) {
      // Swallow: auditing is observability, not a request precondition.
      logger.error('Failed to write audit log', {
        eventType,
        reason: error.message,
      });
      return null;
    }
  }

  /** Extract the standard actor/request fields from an Express request. */
  _contextFromRequest(req = {}) {
    return {
      actorUserId: req.user?.id || null,
      actorRole: req.user?.role || null,
      requestId: req.requestId || null,
      ip: req.ip || req.socket?.remoteAddress || null,
      userAgent: req.headers?.['user-agent'] || null,
    };
  }

  /** Write an entry, filling actor and request context from `req`. */
  async recordFromRequest(req, entry = {}) {
    return this.record({ ...this._contextFromRequest(req), ...entry });
  }

  // ── Authentication ────────────────────────────────────────────────────────

  async recordLoginSuccess(req, { userId, role }) {
    return this.record({
      ...this._contextFromRequest(req),
      eventType: AUDIT_EVENTS.AUTH_LOGIN,
      actorUserId: userId,
      actorRole: role,
      outcome: AUDIT_OUTCOMES.SUCCESS,
      resource: 'auth',
    });
  }

  async recordLoginFailure(req, { identifier, reason }) {
    return this.record({
      ...this._contextFromRequest(req),
      eventType: AUDIT_EVENTS.AUTH_LOGIN_FAILED,
      actorUserId: null,
      outcome: AUDIT_OUTCOMES.FAILURE,
      resource: 'auth',
      // The identifier itself is never stored — only a correlatable fingerprint.
      metadata: { identifierFingerprint: fingerprint(identifier), reason },
    });
  }

  async recordLogout(req) {
    return this.recordFromRequest(req, {
      eventType: AUDIT_EVENTS.AUTH_LOGOUT,
      outcome: AUDIT_OUTCOMES.SUCCESS,
      resource: 'auth',
    });
  }

  async recordPasswordChanged(req) {
    return this.recordFromRequest(req, {
      eventType: AUDIT_EVENTS.AUTH_PASSWORD_CHANGED,
      outcome: AUDIT_OUTCOMES.SUCCESS,
      resource: 'auth',
    });
  }

  // ── Authorization ─────────────────────────────────────────────────────────

  async recordPermissionDenied(req, { requiredPermissions = [], mode = 'all' } = {}) {
    return this.recordFromRequest(req, {
      eventType: AUDIT_EVENTS.PERMISSION_DENIED,
      outcome: AUDIT_OUTCOMES.BLOCKED,
      resource: 'authorization',
      metadata: {
        requiredPermissions: Array.isArray(requiredPermissions) ? requiredPermissions : [],
        mode,
        method: req?.method || null,
        path: req?.originalUrl || req?.path || null,
        // Count only — the full effective permission set is not audit payload.
        effectivePermissionCount: Array.isArray(req?.userPermissions)
          ? req.userPermissions.length
          : 0,
      },
    });
  }

  // ── Privileged mutations ──────────────────────────────────────────────────

  /**
   * Record a change to a user's role or permission overrides.
   *
   * `changes` is the `[{ field, from, to }]` diff that `user.service.js` already
   * computes. Only the security-relevant fields are recorded, and permission
   * arrays are stored as sorted name lists — those are authorization
   * configuration, not personal data.
   */
  async recordPrivilegeChange({
    actorUserId,
    actorRole = null,
    requestId = null,
    targetUserId,
    changes = [],
    ip = null,
  }) {
    const SECURITY_FIELDS = new Set([
      'role',
      'extraPermissions',
      'deniedPermissions',
      'accountStatus',
      'hasLogin',
    ]);

    const relevant = (Array.isArray(changes) ? changes : []).filter((change) =>
      SECURITY_FIELDS.has(change?.field)
    );
    if (relevant.length === 0) return null;

    const roleChanged = relevant.some((change) => change.field === 'role');
    const permissionsChanged = relevant.some(
      (change) => change.field === 'extraPermissions' || change.field === 'deniedPermissions'
    );

    let eventType = AUDIT_EVENTS.USER_ACCOUNT_STATUS_CHANGED;
    if (roleChanged) eventType = AUDIT_EVENTS.USER_ROLE_CHANGED;
    else if (permissionsChanged) eventType = AUDIT_EVENTS.USER_PERMISSIONS_CHANGED;

    return this.record({
      eventType,
      actorUserId,
      actorRole,
      requestId,
      ip,
      outcome: AUDIT_OUTCOMES.SUCCESS,
      resource: 'user',
      resourceIds: [targetUserId],
      metadata: {
        changes: relevant.map((change) => ({
          field: change.field,
          from: this._normalizePrivilegeValue(change.from),
          to: this._normalizePrivilegeValue(change.to),
        })),
      },
    });
  }

  _normalizePrivilegeValue(value) {
    if (Array.isArray(value)) return [...value].map(String).sort();
    if (value === null || value === undefined) return null;
    if (typeof value === 'object') return String(value);
    return value;
  }

  // ── AI ────────────────────────────────────────────────────────────────────

  /**
   * Record an AI lifecycle event.
   *
   * Callers pass identifiers and counters only. Prompt text, model output, and
   * any record contents are never accepted here — the sanitizer's denylist
   * redacts `prompt`, `completion`, `response`, and `content` keys as a backstop.
   */
  async recordAiEvent({
    eventType,
    actorUserId = null,
    actorRole = null,
    requestId = null,
    feature,
    outcome = AUDIT_OUTCOMES.SUCCESS,
    metadata = {},
    ip = null,
  }) {
    return this.record({
      eventType,
      actorUserId,
      actorRole,
      requestId,
      ip,
      outcome,
      resource: 'ai',
      resourceIds: feature ? [feature] : [],
      metadata: { feature, ...metadata },
    });
  }

  /** Read back audit entries. Admin/investigation use. */
  async list({ eventType, actorUserId, outcome, limit = 50 } = {}) {
    const query = {};
    if (eventType) query.eventType = eventType;
    if (actorUserId) query.actorUserId = actorUserId;
    if (outcome) query.outcome = outcome;

    return AuditLog.find(query)
      .sort({ createdAt: -1 })
      .limit(Math.max(Math.min(Number(limit) || 50, 500), 1))
      .lean();
  }
}

const auditService = new AuditService();

module.exports = auditService;
module.exports.sanitizeMetadata = sanitizeMetadata;
module.exports.fingerprint = fingerprint;
module.exports.AuditService = AuditService;
