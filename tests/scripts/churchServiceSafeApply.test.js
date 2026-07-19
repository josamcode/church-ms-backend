const fs = require('fs');
const os = require('os');
const path = require('path');
const { calculatePlanChecksum, assertApplyPreconditions } = require('../../scripts/churchServiceImport/integrity');
const {
  assertSafeOnlyPreconditions,
  extractSafeOperations,
  revalidateTargetGroup,
  SafeApplyReportWriter,
  loadSafeCheckpoint,
  assertResumeCheckpoint,
  summarizeRecords,
  applySafeOperations,
} = require('../../scripts/churchServiceSafeApply');
const { parseArgs } = require('../../scripts/importChurchService');

const id = (number) => String(number).padStart(24, '0');

function planFixture() {
  const plan = {
    schemaVersion: 2,
    mode: 'RESOLUTION_AWARE_DRY_RUN',
    input: { sha256: 'excel' },
    database: { name: 'db' },
    databaseFingerprint: 'fingerprint',
    resolutionWorkbook: { sha256: 'workbook' },
    groups: [{
      sourceKey: 'source-1',
      sector: 'Sector',
      meeting: 'Meeting',
      meetingId: id(10),
      grade: '',
      originalGroupName: 'Group',
      targetGroupName: 'Group',
      groupAction: 'CREATE',
      requestedServantIds: [id(1)],
      requestedMemberIds: [id(2), id(3)],
      operations: {
        group: 'CREATE',
        servantAssignments: { ADD: 1, NO_OP: 0, BLOCKED: 1 },
        memberAssignments: { ADD: 2, NO_OP: 0, BLOCKED: 1 },
      },
    }],
    blockingErrors: [
      { type: 'UNRESOLVED_IDENTITY_DECISION', identityKey: 'identity-x', message: 'manual identity unresolved' },
      { type: 'UNRESOLVED_MEMBER_OPERATION', sourceKey: 'source-x', message: 'blocked member excluded from requested IDs' },
    ],
    totals: { groupsToCreate: 1, groupsToReuse: 0, safeServantAssignments: 1, safeMemberAssignments: 2 },
    safeOperationsAvailable: true,
    safeForFullApply: false,
    safeToApply: false,
    planChecksum: null,
  };
  plan.planChecksum = calculatePlanChecksum(plan);
  return plan;
}

function stateFor(safePlan) {
  return {
    status: 'IN_PROGRESS',
    planChecksum: 'plan',
    inputHash: 'excel',
    resolutionWorkbookHash: 'workbook',
    databaseName: 'db',
    databaseFingerprint: 'fingerprint',
    actorUserId: id(99),
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    finishedAt: '',
    currentTargetIndex: 0,
    totalTargets: safePlan.targets.length,
    currentOperationKey: '',
    retries: 0,
    timeouts: 0,
    attemptedOperationKeys: [],
    recordsByKey: {},
  };
}

function fakeSession() {
  let transaction = false;
  return {
    startTransaction: jest.fn(() => { transaction = true; }),
    commitTransaction: jest.fn(async () => { transaction = false; }),
    abortTransaction: jest.fn(async () => { transaction = false; }),
    endSession: jest.fn(async () => undefined),
    inTransaction: jest.fn(() => transaction),
  };
}

function memoryWriter() {
  return {
    upsert: jest.fn((state, record) => { state.recordsByKey[record.operationKey] = record; }),
    flushCheckpoint: jest.fn(),
    flushReports: jest.fn(),
  };
}

const fastOptions = { operationTimeoutMs: 1000, operationRetries: 0, operationRetryDelayMs: 1, heartbeatMs: 100000 };

describe('safe-only preconditions and extraction', () => {
  test('safe-only permits individually safe work while normal full apply remains blocked', () => {
    const plan = planFixture();
    expect(() => assertSafeOnlyPreconditions({
      plan,
      suppliedChecksum: plan.planChecksum,
      currentInputHash: 'excel',
      currentDatabaseName: 'db',
      currentResolutionWorkbookHash: 'workbook',
      currentDatabaseFingerprint: 'fingerprint',
    })).not.toThrow();
    expect(() => assertApplyPreconditions({ plan, suppliedChecksum: plan.planChecksum, currentInputHash: 'excel', currentDatabaseName: 'db' })).toThrow(/blocking errors/);
  });

  test.each([
    ['checksum', { suppliedChecksum: 'wrong' }, /checksum/],
    ['Excel hash', { currentInputHash: 'changed' }, /workbook checksum mismatch/],
    ['database name', { currentDatabaseName: 'other' }, /Database target mismatch/],
    ['database fingerprint', { currentDatabaseFingerprint: 'other' }, /fingerprint mismatch/],
    ['resolution workbook', { currentResolutionWorkbookHash: 'other' }, /Resolution workbook checksum mismatch/],
  ])('rejects global %s changes', (label, override, expected) => {
    const plan = planFixture();
    const args = { plan, suppliedChecksum: plan.planChecksum, currentInputHash: 'excel', currentDatabaseName: 'db', currentResolutionWorkbookHash: 'workbook', currentDatabaseFingerprint: 'fingerprint', ...override };
    expect(() => assertSafeOnlyPreconditions(args)).toThrow(expected);
  });

  test('extracts only safe requested IDs and preserves unresolved blockers as skips', () => {
    const extracted = extractSafeOperations(planFixture());
    expect(extracted.targets).toHaveLength(1);
    expect(extracted.servantOperations.map((operation) => operation.userId)).toEqual([id(1)]);
    expect(extracted.memberOperations.map((operation) => operation.userId)).toEqual([id(2), id(3)]);
    expect(extracted.skippedPlanBlockers).toHaveLength(2);
    expect(extracted.sourceGroupCounts).toEqual({ create: 1, reuse: 0 });
  });

  test('CLI requires the explicit safe-only flag and guarded inputs', () => {
    const options = parseArgs(['--apply-safe-only', '--plan-file=plan.json', '--confirm=sum', `--actor-user-id=${id(9)}`, '--resolution-workbook=review.xlsx']);
    expect(options).toMatchObject({ mode: 'apply-safe-only', operationTimeoutMs: 60000, operationRetries: 2, dbRetries: 5 });
    expect(parseArgs(['--apply', '--plan-file=plan.json', '--confirm=sum', `--actor-user-id=${id(9)}`]).mode).toBe('apply');
  });
});

describe('operation-level revalidation', () => {
  test('classifies additive, no-op, conflicting, and missing users independently', () => {
    const target = {
      targetGroupName: 'Group',
      sources: [{ plannedOperation: 'REUSE' }],
      servantUserIds: [id(1), id(2), id(9)],
      memberUserIds: [id(3), id(4), id(5), id(8)],
    };
    const meeting = {
      groups: ['Group', 'Other'],
      groupAssignments: [
        { group: 'Group', servedUserIds: [id(4)] },
        { group: 'Other', servedUserIds: [id(5)] },
      ],
      servants: [{ userId: id(2), groupsManaged: ['Group'], groupAssignments: [] }],
    };
    const result = revalidateTargetGroup(target, { meeting, activeUserIds: new Set([id(1), id(2), id(3), id(4), id(5)]) });
    expect(result.servantAdds).toEqual([id(1)]);
    expect(result.servantNoOps).toEqual([id(2)]);
    expect(result.servantBlocked).toEqual([{ userId: id(9), reason: 'Target servant user no longer exists or is deleted' }]);
    expect(result.memberAdds).toEqual([id(3)]);
    expect(result.memberNoOps).toEqual([id(4)]);
    expect(result.memberBlocked).toHaveLength(2);
    expect(result.memberBlocked.find((entry) => entry.userId === id(5)).reason).toMatch(/another group/);
  });

  test('does not recreate a group that was approved only for reuse', () => {
    const result = revalidateTargetGroup({ targetGroupName: 'Missing', sources: [{ plannedOperation: 'REUSE' }], servantUserIds: [], memberUserIds: [] }, { meeting: { groups: [], groupAssignments: [], servants: [] }, activeUserIds: new Set() });
    expect(result.targetError).toMatch(/planned for reuse no longer exists/);
  });
});

describe('safe-only engine, idempotency, and reporting', () => {
  let root;
  afterEach(() => { if (root) fs.rmSync(root, { recursive: true, force: true }); });

  test('applies only safe group data and checkpoints every outcome', async () => {
    const safePlan = extractSafeOperations(planFixture());
    const state = stateFor(safePlan);
    const writer = memoryWriter();
    const session = fakeSession();
    const adapter = {
      isConnected: () => true,
      setRuntime: jest.fn(),
      revalidateTarget: jest.fn(async (target) => ({ targetError: '', groupExists: false, groupName: target.targetGroupName, servantAdds: target.servantUserIds, servantNoOps: [], servantBlocked: [], memberAdds: target.memberUserIds, memberNoOps: [], memberBlocked: [] })),
      startSession: jest.fn(async () => session),
      applyGroup: jest.fn(async () => undefined),
      abortContext: jest.fn(async () => undefined),
      closeContext: jest.fn(async (context) => context.session?.endSession()),
      reconnect: jest.fn(async () => undefined),
    };
    await applySafeOperations({ safePlan, state, writer, adapter, options: fastOptions, log: jest.fn() });
    expect(adapter.applyGroup).toHaveBeenCalledWith(expect.objectContaining({ servantUserIds: [id(1)], memberUserIds: [id(2), id(3)] }), expect.anything());
    expect(summarizeRecords(state)).toEqual({ createdGroups: 1, reusedGroups: 0, servantsAdded: 1, membersAdded: 2, noOps: 0, skipped: 2, failed: 0 });
    expect(writer.upsert).toHaveBeenCalledTimes(6);
    expect(session.commitTransaction).toHaveBeenCalledTimes(1);
  });

  test('an idempotent rerun records no-ops and never invokes family, user, or assignment-removal services', async () => {
    const safePlan = extractSafeOperations(planFixture());
    const state = stateFor(safePlan);
    const writer = memoryWriter();
    const adapter = {
      isConnected: () => true,
      setRuntime: jest.fn(),
      revalidateTarget: jest.fn(async (target) => ({ targetError: '', groupExists: true, groupName: target.targetGroupName, servantAdds: [], servantNoOps: target.servantUserIds, servantBlocked: [], memberAdds: [], memberNoOps: target.memberUserIds, memberBlocked: [] })),
      startSession: jest.fn(),
      applyGroup: jest.fn(),
      abortContext: jest.fn(),
      closeContext: jest.fn(),
      reconnect: jest.fn(),
    };
    await applySafeOperations({ safePlan, state, writer, adapter, options: fastOptions, log: jest.fn() });
    expect(adapter.applyGroup).not.toHaveBeenCalled();
    expect(adapter.startSession).not.toHaveBeenCalled();
    expect(summarizeRecords(state)).toMatchObject({ servantsAdded: 0, membersAdded: 0, noOps: 3, failed: 0 });
    expect(adapter.createUser).toBeUndefined();
    expect(adapter.applyFamily).toBeUndefined();
    expect(adapter.removeAssignment).toBeUndefined();
  });

  test('resume revalidation preserves previously committed assignment results', async () => {
    const safePlan = extractSafeOperations(planFixture());
    const state = stateFor(safePlan);
    const servantKey = safePlan.servantOperations[0].operationKey;
    const memberKey = safePlan.memberOperations[0].operationKey;
    state.recordsByKey[servantKey] = { ...safePlan.servantOperations[0], category: 'SERVANT_ADDED', status: 'ADDED', reason: '' };
    state.recordsByKey[memberKey] = { ...safePlan.memberOperations[0], category: 'MEMBER_ADDED', status: 'ADDED', reason: '' };
    const adapter = {
      isConnected: () => true,
      setRuntime: jest.fn(),
      revalidateTarget: jest.fn(async (target) => ({ targetError: '', groupExists: true, groupName: target.targetGroupName, servantAdds: [], servantNoOps: target.servantUserIds, servantBlocked: [], memberAdds: [], memberNoOps: target.memberUserIds, memberBlocked: [] })),
      startSession: jest.fn(), applyGroup: jest.fn(), abortContext: jest.fn(), closeContext: jest.fn(), reconnect: jest.fn(),
    };
    await applySafeOperations({ safePlan, state, writer: memoryWriter(), adapter, options: fastOptions, log: jest.fn() });
    expect(state.recordsByKey[servantKey]).toMatchObject({ category: 'SERVANT_ADDED', status: 'RESUME_CONFIRMED' });
    expect(state.recordsByKey[memberKey]).toMatchObject({ category: 'MEMBER_ADDED', status: 'RESUME_CONFIRMED' });
    expect(adapter.applyGroup).not.toHaveBeenCalled();
  });

  test('transient group failure uses bounded reconnect and retries only that target', async () => {
    const safePlan = extractSafeOperations(planFixture());
    const state = stateFor(safePlan);
    const session = fakeSession();
    const transient = Object.assign(new Error('transaction counter mismatch'), { errorLabels: ['TransientTransactionError'] });
    const adapter = {
      isConnected: () => true,
      setRuntime: jest.fn(),
      revalidateTarget: jest.fn(async (target) => ({ targetError: '', groupExists: false, groupName: target.targetGroupName, servantAdds: target.servantUserIds, servantNoOps: [], servantBlocked: [], memberAdds: target.memberUserIds, memberNoOps: [], memberBlocked: [] })),
      startSession: jest.fn(async () => session),
      applyGroup: jest.fn().mockRejectedValueOnce(transient).mockResolvedValueOnce(undefined),
      abortContext: jest.fn(async (context) => { if (context.session?.inTransaction()) await context.session.abortTransaction(); }),
      closeContext: jest.fn(async (context) => context.session?.endSession()),
      reconnect: jest.fn(async () => undefined),
    };
    await applySafeOperations({ safePlan, state, writer: memoryWriter(), adapter, options: { ...fastOptions, operationRetries: 1 }, log: jest.fn() });
    expect(adapter.reconnect).toHaveBeenCalledTimes(1);
    expect(adapter.applyGroup).toHaveBeenCalledTimes(2);
    expect(state.retries).toBe(1);
    expect(summarizeRecords(state).failed).toBe(0);
  });

  test('global integrity changes stop before the domain service is called', async () => {
    const safePlan = extractSafeOperations(planFixture());
    const state = stateFor(safePlan);
    const error = Object.assign(new Error('workbook changed'), { globalExecutionError: true });
    const adapter = {
      isConnected: () => true,
      setRuntime: jest.fn(),
      revalidateTarget: jest.fn(async () => { throw error; }),
      startSession: jest.fn(),
      applyGroup: jest.fn(),
      abortContext: jest.fn(),
      closeContext: jest.fn(),
      reconnect: jest.fn(),
    };
    await expect(applySafeOperations({ safePlan, state, writer: memoryWriter(), adapter, options: fastOptions, log: jest.fn() })).rejects.toThrow(/workbook changed/);
    expect(adapter.applyGroup).not.toHaveBeenCalled();
  });

  test('checkpoint and all required report files are durable and resumable', () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'church-safe-apply-'));
    const safePlan = extractSafeOperations(planFixture());
    const state = stateFor(safePlan);
    const writer = new SafeApplyReportWriter({ reportsRoot: root, state });
    writer.upsert(state, { operationKey: 'one', category: 'NO_OP', kind: 'MEMBER', status: 'NO_OP_ALREADY_EXISTS', reason: 'exists' });
    writer.finalize(state);
    const checkpoint = loadSafeCheckpoint(writer.checkpointPath);
    expect(checkpoint.recordsByKey.one.status).toBe('NO_OP_ALREADY_EXISTS');
    expect(() => assertResumeCheckpoint(checkpoint, { planChecksum: 'plan', inputHash: 'excel', resolutionWorkbookHash: 'workbook', databaseName: 'db', databaseFingerprint: 'fingerprint', actorUserId: id(99) })).not.toThrow();
    for (const file of ['created-groups.csv', 'reused-groups.csv', 'servant-assignments-added.csv', 'member-assignments-added.csv', 'no-op-assignments.csv', 'skipped-unresolved-operations.csv', 'failed-operations.csv', 'summary.partial.md', 'summary.md', 'apply-result.json', 'checkpoint.json']) {
      expect(fs.existsSync(path.join(writer.reportDir, file))).toBe(true);
    }
  });
});
