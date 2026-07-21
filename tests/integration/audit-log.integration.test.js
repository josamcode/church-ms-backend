/**
 * Integration: the audit log against a real MongoDB.
 *
 * Verifies what a mocked model cannot: that the schema actually accepts the
 * documents the service builds, that the declared indexes (including the TTL)
 * are really created, and that schema-level validation rejects a bad outcome.
 */

const mongoose = require('mongoose');
const { withMongo } = require('../helpers/mongo');

withMongo();

let AuditLog;
let auditService;

beforeAll(() => {
  AuditLog = require('../../src/modules/audit/auditLog.model');
  auditService = require('../../src/modules/audit/audit.service');
});

describe('auditLog schema and indexes', () => {
  it('creates the declared indexes, including the TTL', async () => {
    await AuditLog.init();
    const indexes = await AuditLog.collection.indexes();

    const ttl = indexes.find((i) => i.expireAfterSeconds !== undefined);
    expect(ttl).toBeDefined();
    expect(ttl.key).toEqual({ createdAt: 1 });
    expect(ttl.expireAfterSeconds).toBe(400 * 24 * 60 * 60);

    const keys = indexes.map((i) => JSON.stringify(i.key));
    expect(keys).toContain(JSON.stringify({ actorUserId: 1, createdAt: -1 }));
    expect(keys).toContain(JSON.stringify({ eventType: 1, createdAt: -1 }));
  });

  it('rejects an outcome outside the enum', async () => {
    await expect(
      AuditLog.create({ eventType: 'x.y', outcome: 'not-a-real-outcome' })
    ).rejects.toThrow(/validation/i);
  });

  it('requires eventType and outcome', async () => {
    await expect(AuditLog.create({})).rejects.toThrow(/validation/i);
  });
});

describe('audit service against a real collection', () => {
  const actorUserId = new mongoose.Types.ObjectId();

  it('persists and reads back a login event', async () => {
    await auditService.record({
      eventType: 'auth.login',
      actorUserId,
      actorRole: 'ADMIN',
      requestId: 'req-integration-1',
      outcome: 'success',
      resource: 'auth',
      ip: '10.0.0.1',
    });

    const [stored] = await AuditLog.find({ eventType: 'auth.login' }).lean();
    expect(stored).toMatchObject({
      eventType: 'auth.login',
      actorRole: 'ADMIN',
      requestId: 'req-integration-1',
      outcome: 'success',
    });
    expect(String(stored.actorUserId)).toBe(String(actorUserId));
    expect(stored.createdAt).toBeInstanceOf(Date);
  });

  // End-to-end proof of the privacy guarantee: the value never reaches disk.
  it('never writes a denylisted value to the database', async () => {
    await auditService.record({
      eventType: 'ai.requested',
      actorUserId,
      outcome: 'success',
      metadata: {
        feature: 'notification_draft',
        prompt: 'CONFIDENTIAL-PROMPT-TEXT',
        apiKey: 'sk-ant-should-never-persist',
        nationalId: '29001011234567',
        inputTokens: 812,
      },
    });

    const [stored] = await AuditLog.find({ eventType: 'ai.requested' }).lean();
    expect(stored.metadata.feature).toBe('notification_draft');
    expect(stored.metadata.inputTokens).toBe(812);
    expect(stored.metadata.prompt).toBe('[redacted]');
    expect(stored.metadata.apiKey).toBe('[redacted]');
    expect(stored.metadata.nationalId).toBe('[redacted]');

    // Nothing sensitive anywhere in the stored document.
    const raw = JSON.stringify(stored);
    expect(raw).not.toContain('CONFIDENTIAL-PROMPT-TEXT');
    expect(raw).not.toContain('sk-ant-should-never-persist');
    expect(raw).not.toContain('29001011234567');
  });

  it('stores a login failure without the identifier', async () => {
    await auditService.recordLoginFailure(
      { ip: '10.0.0.2', requestId: 'req-2', headers: {} },
      { identifier: 'victim@example.com', reason: 'AUTH_INVALID_CREDENTIALS' }
    );

    const [stored] = await AuditLog.find({ eventType: 'auth.login_failed' }).lean();
    expect(stored.outcome).toBe('failure');
    expect(stored.actorUserId).toBeNull();
    expect(JSON.stringify(stored)).not.toContain('victim@example.com');
    expect(stored.metadata.identifierFingerprint).toMatch(/^[a-f0-9]{16}$/);
  });

  it('records a privilege change with a queryable diff', async () => {
    const targetUserId = new mongoose.Types.ObjectId();
    await auditService.recordPrivilegeChange({
      actorUserId,
      targetUserId,
      changes: [
        { field: 'role', from: 'USER', to: 'ADMIN' },
        { field: 'fullName', from: 'A', to: 'B' },
      ],
    });

    const [stored] = await AuditLog.find({ eventType: 'user.role_changed' }).lean();
    expect(stored.resourceIds).toEqual([String(targetUserId)]);
    expect(stored.metadata.changes).toEqual([
      { field: 'role', from: 'USER', to: 'ADMIN' },
    ]);
  });

  it('lists newest first and honours the limit', async () => {
    for (let i = 0; i < 5; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await auditService.record({
        eventType: 'auth.login',
        actorUserId,
        outcome: 'success',
        metadata: { sequence: i },
      });
    }

    const results = await auditService.list({ eventType: 'auth.login', limit: 3 });
    expect(results).toHaveLength(3);
    expect(results[0].metadata.sequence).toBe(4);
  });

  it('filters by actor and by outcome', async () => {
    const otherActor = new mongoose.Types.ObjectId();
    await auditService.record({ eventType: 'auth.login', actorUserId, outcome: 'success' });
    await auditService.record({ eventType: 'auth.login', actorUserId: otherActor, outcome: 'failure' });

    expect(await auditService.list({ actorUserId })).toHaveLength(1);
    expect(await auditService.list({ outcome: 'failure' })).toHaveLength(1);
  });

  it('survives an oversized metadata payload', async () => {
    const result = await auditService.record({
      eventType: 'ai.completed',
      actorUserId,
      outcome: 'success',
      metadata: {
        label: 'x'.repeat(50000),
        ids: Array.from({ length: 5000 }, (_, i) => `id-${i}`),
      },
    });

    expect(result).not.toBeNull();
    const [stored] = await AuditLog.find({ eventType: 'ai.completed' }).lean();
    expect(stored.metadata.label.length).toBeLessThan(600);
    expect(stored.metadata.ids.length).toBe(51);
  });
});
