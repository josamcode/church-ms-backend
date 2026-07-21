/**
 * Central audit module — behaviour and privacy guarantees.
 */

const mockCreate = jest.fn();

jest.mock('../../src/modules/audit/auditLog.model', () => ({
  create: (...args) => mockCreate(...args),
  find: jest.fn(),
}));

jest.mock('../../src/utils/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

const auditService = require('../../src/modules/audit/audit.service');
const { sanitizeMetadata, fingerprint } = require('../../src/modules/audit/audit.service');
const { AUDIT_EVENTS, AUDIT_OUTCOMES } = require('../../src/modules/audit/audit.constants');
const logger = require('../../src/utils/logger');

/** The document that would have been persisted by the Nth create() call. */
function persisted(index = 0) {
  return mockCreate.mock.calls[index][0];
}

function fakeRequest(overrides = {}) {
  return {
    user: { id: 'user-1', role: 'ADMIN' },
    requestId: 'req-abc',
    ip: '10.0.0.1',
    method: 'POST',
    originalUrl: '/api/users/user-2',
    headers: { 'user-agent': 'jest' },
    userPermissions: ['USERS_VIEW', 'USERS_UPDATE'],
    ...overrides,
  };
}

beforeEach(() => {
  mockCreate.mockReset();
  mockCreate.mockResolvedValue({ _id: 'audit-1' });
});

describe('sanitizeMetadata', () => {
  it('redacts denylisted keys regardless of case', () => {
    const result = sanitizeMetadata({
      password: 'hunter2',
      PassWord: 'hunter2',
      accessToken: 'abc',
      apiKey: 'sk-test',
      nationalId: '12345678901234',
      safeField: 'kept',
    });

    expect(result.password).toBe('[redacted]');
    expect(result.PassWord).toBe('[redacted]');
    expect(result.accessToken).toBe('[redacted]');
    expect(result.apiKey).toBe('[redacted]');
    expect(result.nationalId).toBe('[redacted]');
    expect(result.safeField).toBe('kept');
  });

  it('redacts denylisted keys nested inside objects', () => {
    const result = sanitizeMetadata({ outer: { inner: { password: 'x', ok: 1 } } });
    expect(result.outer.inner.password).toBe('[redacted]');
    expect(result.outer.inner.ok).toBe(1);
  });

  it('redacts model prompt and completion keys', () => {
    const result = sanitizeMetadata({ prompt: 'secret prompt', completion: 'model output' });
    expect(result.prompt).toBe('[redacted]');
    expect(result.completion).toBe('[redacted]');
  });

  it('truncates long strings', () => {
    // `label` is deliberately NOT on the denylist — redaction would otherwise
    // mask whether truncation works at all.
    const result = sanitizeMetadata({ label: 'x'.repeat(2000) });
    expect(result.label.length).toBeLessThan(600);
    expect(result.label).toContain('[truncated]');
  });

  it('redacts rather than truncates a long denylisted value', () => {
    expect(sanitizeMetadata({ note: 'x'.repeat(2000) }).note).toBe('[redacted]');
  });

  it('caps arrays and reports how many were dropped', () => {
    const result = sanitizeMetadata({ ids: Array.from({ length: 120 }, (_, i) => i) });
    expect(result.ids.length).toBe(51);
    expect(result.ids[50]).toBe('[truncated: 70 more]');
  });

  it('stops recursing past the depth limit', () => {
    let deep = 'bottom';
    for (let i = 0; i < 12; i += 1) deep = { nested: deep };
    expect(JSON.stringify(sanitizeMetadata(deep))).toContain('max depth');
  });

  it('passes through primitives and dates', () => {
    expect(sanitizeMetadata({ n: 5, b: true })).toEqual({ n: 5, b: true });
    expect(sanitizeMetadata({ d: new Date('2026-01-01T00:00:00Z') }).d)
      .toBe('2026-01-01T00:00:00.000Z');
  });

  it('drops functions rather than serializing them', () => {
    expect(sanitizeMetadata({ fn: () => 'x' })).toEqual({ fn: null });
  });
});

describe('fingerprint', () => {
  it('is stable and case/whitespace insensitive', () => {
    expect(fingerprint('User@Example.com ')).toBe(fingerprint('user@example.com'));
  });

  it('differs for different identifiers', () => {
    expect(fingerprint('a@example.com')).not.toBe(fingerprint('b@example.com'));
  });

  it('is not reversible — it never contains the input', () => {
    const identifier = 'secret@example.com';
    expect(fingerprint(identifier)).not.toContain('secret');
    expect(fingerprint(identifier)).toMatch(/^[a-f0-9]{16}$/);
  });

  it('returns null for empty input', () => {
    expect(fingerprint('')).toBeNull();
    expect(fingerprint(null)).toBeNull();
  });
});

describe('record', () => {
  it('persists the core envelope', async () => {
    await auditService.record({
      eventType: AUDIT_EVENTS.AUTH_LOGIN,
      actorUserId: 'user-1',
      actorRole: 'ADMIN',
      requestId: 'req-1',
      outcome: AUDIT_OUTCOMES.SUCCESS,
      resource: 'auth',
    });

    expect(persisted()).toMatchObject({
      eventType: 'auth.login',
      actorUserId: 'user-1',
      actorRole: 'ADMIN',
      requestId: 'req-1',
      outcome: 'success',
      resource: 'auth',
    });
    expect(persisted().createdAt).toBeInstanceOf(Date);
  });

  // The single most important property: auditing is observability, and a
  // failing audit backend must never turn a working request into a 500.
  it('never throws when the database write fails', async () => {
    mockCreate.mockRejectedValue(new Error('mongo down'));

    await expect(
      auditService.record({ eventType: AUDIT_EVENTS.AUTH_LOGIN })
    ).resolves.toBeNull();

    expect(logger.error).toHaveBeenCalledWith(
      'Failed to write audit log',
      expect.objectContaining({ reason: 'mongo down' })
    );
  });

  it('skips and warns when eventType is missing', async () => {
    await expect(auditService.record({})).resolves.toBeNull();
    expect(mockCreate).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
  });

  it('normalizes and caps resourceIds', async () => {
    await auditService.record({
      eventType: 'x.y',
      resourceIds: Array.from({ length: 250 }, (_, i) => i),
    });
    expect(persisted().resourceIds.length).toBe(100);
    expect(typeof persisted().resourceIds[0]).toBe('string');
  });

  it('accepts a single resourceId that is not an array', async () => {
    await auditService.record({ eventType: 'x.y', resourceIds: 'abc' });
    expect(persisted().resourceIds).toEqual(['abc']);
  });

  it('truncates an over-long client-supplied requestId', async () => {
    await auditService.record({ eventType: 'x.y', requestId: 'r'.repeat(500) });
    expect(persisted().requestId.length).toBe(128);
  });
});

describe('authentication events', () => {
  it('records a successful login with actor and request context', async () => {
    await auditService.recordLoginSuccess(fakeRequest({ user: null }), {
      userId: 'user-9',
      role: 'ADMIN',
    });

    expect(persisted()).toMatchObject({
      eventType: 'auth.login',
      actorUserId: 'user-9',
      actorRole: 'ADMIN',
      outcome: 'success',
      requestId: 'req-abc',
      ip: '10.0.0.1',
      userAgent: 'jest',
    });
  });

  it('records a failed login without storing the identifier', async () => {
    await auditService.recordLoginFailure(fakeRequest({ user: null }), {
      identifier: 'victim@example.com',
      reason: 'AUTH_INVALID_CREDENTIALS',
    });

    const doc = persisted();
    expect(doc.eventType).toBe('auth.login_failed');
    expect(doc.outcome).toBe('failure');
    expect(doc.actorUserId).toBeNull();
    expect(doc.metadata.reason).toBe('AUTH_INVALID_CREDENTIALS');

    // The raw identifier must not appear anywhere in the persisted document.
    expect(JSON.stringify(doc)).not.toContain('victim@example.com');
    expect(doc.metadata.identifierFingerprint).toMatch(/^[a-f0-9]{16}$/);
  });

  it('correlates repeated failures against the same identifier', async () => {
    const req = fakeRequest({ user: null });
    await auditService.recordLoginFailure(req, { identifier: 'a@b.com', reason: 'x' });
    await auditService.recordLoginFailure(req, { identifier: 'A@B.COM ', reason: 'x' });

    expect(persisted(0).metadata.identifierFingerprint)
      .toBe(persisted(1).metadata.identifierFingerprint);
  });

  it('records logout and password change', async () => {
    await auditService.recordLogout(fakeRequest());
    expect(persisted(0)).toMatchObject({
      eventType: 'auth.logout', actorUserId: 'user-1', outcome: 'success',
    });

    await auditService.recordPasswordChanged(fakeRequest());
    expect(persisted(1)).toMatchObject({
      eventType: 'auth.password_changed', outcome: 'success',
    });
  });
});

describe('permission denials', () => {
  it('records the required permissions and the route, as blocked', async () => {
    await auditService.recordPermissionDenied(fakeRequest(), {
      requiredPermissions: ['USERS_DELETE'],
      mode: 'all',
    });

    expect(persisted()).toMatchObject({
      eventType: 'permission.denied',
      outcome: 'blocked',
      actorUserId: 'user-1',
      actorRole: 'ADMIN',
      resource: 'authorization',
    });
    expect(persisted().metadata).toMatchObject({
      requiredPermissions: ['USERS_DELETE'],
      mode: 'all',
      method: 'POST',
      path: '/api/users/user-2',
    });
  });

  // Recording the whole effective set would copy an authorization snapshot into
  // a 400-day store on every denial; the count is enough to spot anomalies.
  it('records only the count of effective permissions, not the list', async () => {
    await auditService.recordPermissionDenied(fakeRequest(), {
      requiredPermissions: ['USERS_DELETE'],
    });

    expect(persisted().metadata.effectivePermissionCount).toBe(2);
    expect(JSON.stringify(persisted().metadata)).not.toContain('USERS_VIEW');
  });
});

describe('privilege changes', () => {
  const actor = { actorUserId: 'admin-1', targetUserId: 'user-2' };

  it('classifies a role change', async () => {
    await auditService.recordPrivilegeChange({
      ...actor,
      changes: [{ field: 'role', from: 'USER', to: 'ADMIN' }],
    });

    expect(persisted()).toMatchObject({
      eventType: 'user.role_changed',
      actorUserId: 'admin-1',
      resource: 'user',
      resourceIds: ['user-2'],
    });
    expect(persisted().metadata.changes).toEqual([
      { field: 'role', from: 'USER', to: 'ADMIN' },
    ]);
  });

  it('classifies a permission-override change', async () => {
    await auditService.recordPrivilegeChange({
      ...actor,
      changes: [{ field: 'extraPermissions', from: [], to: ['AI_DRAFT_CONTENT'] }],
    });
    expect(persisted().eventType).toBe('user.permissions_changed');
  });

  it('sorts permission arrays so diffs are comparable', async () => {
    await auditService.recordPrivilegeChange({
      ...actor,
      changes: [{ field: 'deniedPermissions', from: ['b', 'a'], to: ['c', 'a', 'b'] }],
    });
    expect(persisted().metadata.changes[0].from).toEqual(['a', 'b']);
    expect(persisted().metadata.changes[0].to).toEqual(['a', 'b', 'c']);
  });

  it('ignores changes with no security-relevant field', async () => {
    await expect(
      auditService.recordPrivilegeChange({
        ...actor,
        changes: [{ field: 'fullName', from: 'A', to: 'B' }],
      })
    ).resolves.toBeNull();
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('drops non-security fields from a mixed diff', async () => {
    await auditService.recordPrivilegeChange({
      ...actor,
      changes: [
        { field: 'fullName', from: 'A', to: 'B' },
        { field: 'role', from: 'USER', to: 'ADMIN' },
      ],
    });

    const fields = persisted().metadata.changes.map((c) => c.field);
    expect(fields).toEqual(['role']);
  });

  it('handles an empty or missing changes list', async () => {
    await expect(auditService.recordPrivilegeChange({ ...actor, changes: [] }))
      .resolves.toBeNull();
    await expect(auditService.recordPrivilegeChange({ ...actor }))
      .resolves.toBeNull();
  });
});

describe('AI events', () => {
  it('records the feature and outcome', async () => {
    await auditService.recordAiEvent({
      eventType: AUDIT_EVENTS.AI_COMPLETED,
      actorUserId: 'user-1',
      requestId: 'req-1',
      feature: 'notification_draft',
      metadata: { provider: 'anthropic', model: 'claude-sonnet-5', inputTokens: 800 },
    });

    expect(persisted()).toMatchObject({
      eventType: 'ai.completed',
      resource: 'ai',
      resourceIds: ['notification_draft'],
      outcome: 'success',
    });
    expect(persisted().metadata).toMatchObject({
      feature: 'notification_draft',
      provider: 'anthropic',
      inputTokens: 800,
    });
  });

  it('redacts prompt text a careless caller passes in', async () => {
    await auditService.recordAiEvent({
      eventType: AUDIT_EVENTS.AI_REQUESTED,
      feature: 'notification_draft',
      metadata: { prompt: 'Members: Mina, Marina, phone 01000000000' },
    });

    expect(persisted().metadata.prompt).toBe('[redacted]');
    expect(JSON.stringify(persisted())).not.toContain('01000000000');
  });

  it('records a redaction block as blocked', async () => {
    await auditService.recordAiEvent({
      eventType: AUDIT_EVENTS.AI_REDACTION_BLOCKED,
      feature: 'notification_draft',
      outcome: AUDIT_OUTCOMES.BLOCKED,
      metadata: { matchedRule: 'nationalId' },
    });

    expect(persisted()).toMatchObject({
      eventType: 'ai.redaction_blocked',
      outcome: 'blocked',
    });
  });
});
