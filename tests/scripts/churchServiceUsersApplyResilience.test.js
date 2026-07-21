const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const {
  UserTimeoutError,
  isTransientMongoError,
  runAbortableWithTimeout,
  UserIndex,
  revalidateWithIndex,
  startHeartbeat,
  logProgress,
  applyUsersResilient,
} = require('../../scripts/churchServiceUsersImport/applyEngine');
const { ApplyReportWriter, atomicWriteJson, loadCheckpoint } = require('../../scripts/churchServiceUsersImport/applyReports');
const { buildUsersImportPlan, calculateUserStateFingerprint } = require('../../scripts/churchServiceUsersImport/planner');
const {
  DEFAULTS,
  parseArgs,
  connectDatabaseWithRetry,
  disconnectDatabase,
  createProcessHandlers,
  assertDatabaseUserState,
  assertResumeCheckpoint,
} = require('../../scripts/importChurchServiceUsers');

const objectId = (number) => String(number).padStart(24, '0');
const identity = (number, name = `Person ${number}`) => ({
  stablePersonKey: `person-${number}`,
  importSourceKey: `church-service-users::person-${number}`,
  canonicalFullName: name,
  normalizedName: name.toLowerCase(),
  originalSpellings: [name],
  roles: ['member'],
  meetings: ['Meeting'],
  groups: ['Group'],
  warnings: [],
  blockers: [],
  classification: 'MISSING_SAFE_TO_CREATE',
  operation: 'CREATE',
  gender: null,
  education: null,
  plannedUser: { fullName: name, hasLogin: false, role: 'USER', accountStatus: 'approved', isLocked: false, isDeleted: false, tags: ['review'], customDetails: { importSourceKey: `church-service-users::person-${number}` } },
});

function stateFor(identities) {
  return { schemaVersion: 1, mode: 'APPLY_USERS_ONLY', status: 'IN_PROGRESS', planChecksum: 'plan', inputHash: 'excel', databaseName: 'db', actorUserId: objectId(9), startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), finishedAt: '', currentIndex: 0, totalUsers: identities.length, processedSourceKeys: [], records: [], retries: 0, timeouts: 0, lastSuccessfullyCommittedSourceKey: '', familyRelationshipsChanged: false, meetingOrGroupAssignmentsChanged: false };
}

function fakeSession(commit = async () => undefined) {
  let transaction = false;
  return {
    startTransaction: jest.fn(() => { transaction = true; }),
    commitTransaction: jest.fn(async () => { await commit(); transaction = false; }),
    abortTransaction: jest.fn(async () => { transaction = false; }),
    endSession: jest.fn(async () => undefined),
    inTransaction: jest.fn(() => transaction),
  };
}

function adapterFactory(overrides = {}) {
  const users = overrides.users || [];
  return {
    isConnected: jest.fn(() => true),
    loadUsers: jest.fn(async () => users),
    probeIdentity: jest.fn(async () => []),
    startSession: jest.fn(async () => fakeSession()),
    createUser: jest.fn(async (item) => ({ id: objectId(Number(item.stablePersonKey.split('-')[1])) })),
    abortActive: jest.fn(async (context) => { if (context.rejectActive) context.rejectActive(new Error('aborted')); context.closed = true; }),
    closeContext: jest.fn(async (context) => { context.closed = true; }),
    reconnect: jest.fn(async () => undefined),
    setRuntime: jest.fn(),
    ...overrides,
  };
}

function memoryWriter() {
  return { flush: jest.fn(), finalize: jest.fn() };
}

const fastOptions = { ...DEFAULTS, userTimeoutMs: 50, userRetries: 0, userRetryDelayMs: 1, heartbeatMs: 100000 };

describe('progress and heartbeat', () => {
  test('progress logging includes counters and current user', () => {
    const output = [];
    const state = stateFor([identity(1)]);
    state.currentIndex = 1;
    state.records = [{ status: 'CREATED' }];
    logProgress(state, 'Current Person', (stage, message) => output.push(`[${stage}] ${message}`));
    expect(output.join(' ')).toMatch(/Processed 1 \/ 1.*Created: 1.*Current: Current Person/);
  });

  test('heartbeat reports liveness, elapsed time, and MongoDB status', () => {
    jest.useFakeTimers();
    const output = [];
    const state = stateFor([identity(1)]);
    const stop = startHeartbeat({ state, runtime: { currentStartedAt: Date.now() - 8000, isConnected: () => true }, intervalMs: 1000, log: (stage, message) => output.push(`[${stage}] ${message}`) });
    jest.advanceTimersByTime(1000);
    stop();
    expect(output[0]).toMatch(/\[HEARTBEAT\].*Process alive.*MongoDB: connected/);
    jest.useRealTimers();
  });
});

describe('timeout and retry safety', () => {
  test('timeout aborts the operation and waits for cancellation', async () => {
    let rejectOperation;
    const operation = new Promise((resolve, reject) => { rejectOperation = reject; });
    const abort = jest.fn(async () => rejectOperation(new Error('cancelled')));
    await expect(runAbortableWithTimeout({ operation, abort, timeoutMs: 10 })).rejects.toBeInstanceOf(UserTimeoutError);
    expect(abort).toHaveBeenCalledTimes(1);
  });

  test('a timed-out user is recorded and processing continues', async () => {
    const items = [identity(1), identity(2)];
    let first = true;
    const sessions = [];
    const adapter = adapterFactory({
      startSession: jest.fn(async () => { const session = fakeSession(); sessions.push(session); return session; }),
      createUser: jest.fn(async (item, context) => {
        if (first) {
          first = false;
          return new Promise((resolve, reject) => { context.rejectActive = reject; });
        }
        return { id: objectId(2) };
      }),
      abortActive: jest.fn(async (context) => {
        if (context.session?.inTransaction()) await context.session.abortTransaction();
        if (context.rejectActive) context.rejectActive(new Error('aborted'));
        context.closed = true;
      }),
    });
    const state = stateFor(items);
    await applyUsersResilient({ identities: items, state, writer: memoryWriter(), adapter, options: fastOptions, log: jest.fn() });
    expect(state.records.map((record) => record.status)).toEqual(['FAILED_TIMEOUT', 'CREATED']);
    expect(adapter.abortActive).toHaveBeenCalled();
    expect(sessions[0].abortTransaction).toHaveBeenCalled();
  });

  test('transient transaction failure retries only the current user', async () => {
    const item = identity(1);
    const transient = Object.assign(new Error('network reset'), { name: 'MongoNetworkError' });
    const adapter = adapterFactory({ createUser: jest.fn().mockRejectedValueOnce(transient).mockResolvedValueOnce({ id: objectId(1) }) });
    const state = stateFor([item]);
    await applyUsersResilient({ identities: [item], state, writer: memoryWriter(), adapter, options: { ...fastOptions, userRetries: 1 }, log: jest.fn() });
    expect(adapter.createUser).toHaveBeenCalledTimes(2);
    expect(state.retries).toBe(1);
    expect(state.records[0].status).toBe('CREATED');
  });

  test('validation failures are never retried', async () => {
    const error = Object.assign(new Error('invalid'), { name: 'ValidationError' });
    const adapter = adapterFactory({ createUser: jest.fn().mockRejectedValue(error) });
    const state = stateFor([identity(1)]);
    await applyUsersResilient({ identities: [identity(1)], state, writer: memoryWriter(), adapter, options: { ...fastOptions, userRetries: 2 }, log: jest.fn() });
    expect(adapter.createUser).toHaveBeenCalledTimes(1);
    expect(adapter.reconnect).not.toHaveBeenCalled();
    expect(state.records[0].status).toBe('FAILED_VALIDATION');
  });

  test('recognizes transaction and network errors but not validation errors', () => {
    expect(isTransientMongoError({ errorLabels: ['TransientTransactionError'] })).toBe(true);
    expect(isTransientMongoError({ name: 'ValidationError', message: 'bad input' })).toBe(false);
  });

  test('bounded MongoDB reconnect uses exponential delays and stops', async () => {
    const connect = jest.fn().mockRejectedValue(new Error('offline'));
    const started = Date.now();
    await expect(connectDatabaseWithRetry({ ...DEFAULTS, dbRetries: 2, dbRetryDelayMs: 1 }, jest.fn(), { connect, disconnect: jest.fn(), connectionState: () => 0, databaseName: () => 'db' })).rejects.toThrow(/3 attempts/);
    expect(connect).toHaveBeenCalledTimes(3);
    expect(Date.now() - started).toBeGreaterThanOrEqual(2);
  });

  test('disconnect helper always closes a connected MongoDB client', async () => {
    const disconnect = jest.fn();
    await disconnectDatabase({ readyState: () => 1, disconnect });
    expect(disconnect).toHaveBeenCalledTimes(1);
  });
});

describe('uncertain commits and idempotency', () => {
  test('source-key recovery prevents duplication after a lost commit response', async () => {
    const item = identity(1);
    const createdUser = { _id: objectId(1), fullName: item.canonicalFullName, customDetails: { importSourceKey: item.importSourceKey }, isDeleted: false };
    const unknownCommit = Object.assign(new Error('unknown transaction commit result'), { errorLabels: ['UnknownTransactionCommitResult'] });
    let loads = 0;
    const session = fakeSession(async () => { throw unknownCommit; });
    const adapter = adapterFactory({
      loadUsers: jest.fn(async () => (loads++ === 0 ? [] : [createdUser])),
      startSession: jest.fn(async () => session),
      createUser: jest.fn(async () => ({ id: objectId(1) })),
    });
    const state = stateFor([item]);
    await applyUsersResilient({ identities: [item], state, writer: memoryWriter(), adapter, options: { ...fastOptions, userRetries: 1 }, log: jest.fn() });
    expect(state.records[0].status).toBe('RECOVERED_AFTER_UNCERTAIN_COMMIT');
    expect(adapter.createUser).toHaveBeenCalledTimes(1);
  });

  test('existing partial-import source keys are classified as no-ops', () => {
    const item = identity(1);
    const index = new UserIndex([{ _id: objectId(1), fullName: item.canonicalFullName, customDetails: { importSourceKey: item.importSourceKey }, isDeleted: false }]);
    expect(revalidateWithIndex(item, index).status).toBe('SKIPPED_ALREADY_IMPORTED');
  });
});

describe('durable checkpoints and resume', () => {
  let root;
  afterEach(() => { if (root) fs.rmSync(root, { recursive: true, force: true }); });

  test('checkpoint and partial reports are atomically updated after every user', async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'church-import-checkpoint-'));
    const items = [identity(1), identity(2)];
    const state = stateFor(items);
    const writer = new ApplyReportWriter({ reportsRoot: root, state });
    const originalFlush = writer.flush.bind(writer);
    writer.flush = jest.fn(originalFlush);
    await applyUsersResilient({ identities: items, state, writer, adapter: adapterFactory(), options: fastOptions, log: jest.fn() });
    const checkpoint = loadCheckpoint(writer.checkpointPath);
    expect(checkpoint.processedSourceKeys).toHaveLength(2);
    expect(writer.flush.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(fs.existsSync(path.join(writer.reportDir, 'created-users.csv'))).toBe(true);
    expect(fs.readdirSync(writer.reportDir).some((name) => name.endsWith('.tmp'))).toBe(false);
  });

  test('atomic JSON replacement leaves a valid complete file', () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'church-import-atomic-'));
    const target = path.join(root, 'checkpoint.json');
    atomicWriteJson(target, { generation: 1 });
    atomicWriteJson(target, { generation: 2, complete: true });
    expect(JSON.parse(fs.readFileSync(target))).toEqual({ generation: 2, complete: true });
  });

  test('resume skips confirmed completed users and retries failed users', async () => {
    const items = [identity(1), identity(2)];
    const existing = { _id: objectId(1), fullName: items[0].canonicalFullName, customDetails: { importSourceKey: items[0].importSourceKey }, isDeleted: false };
    const state = stateFor(items);
    state.records = [
      { ...identity(1), status: 'CREATED', importSourceKey: items[0].importSourceKey, databaseUserId: objectId(1), reason: '' },
      { ...identity(2), status: 'FAILED_TIMEOUT', importSourceKey: items[1].importSourceKey, reason: 'timeout' },
    ];
    state.processedSourceKeys = items.map((item) => item.importSourceKey);
    const adapter = adapterFactory({ users: [existing] });
    await applyUsersResilient({ identities: items, state, writer: memoryWriter(), adapter, options: fastOptions, log: jest.fn() });
    expect(adapter.createUser).toHaveBeenCalledTimes(1);
    expect(state.records.find((record) => record.importSourceKey === items[0].importSourceKey).resumeConfirmed).toBe(true);
    expect(state.records.find((record) => record.importSourceKey === items[1].importSourceKey).status).toBe('CREATED');
  });

  test('resume verifies plan, Excel, database, and actor metadata', () => {
    const checkpoint = { planChecksum: 'p', inputHash: 'x', databaseName: 'db', actorUserId: 'a' };
    const args = { plan: { planChecksum: 'p' }, inputHash: 'x', databaseName: 'db', actorUserId: 'a' };
    expect(() => assertResumeCheckpoint(checkpoint, args)).not.toThrow();
    expect(() => assertResumeCheckpoint(checkpoint, { ...args, databaseName: 'other' })).toThrow(/database target mismatch/);
  });

  test('corrupt checkpoint checksum is rejected', () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'church-import-corrupt-'));
    const file = path.join(root, 'checkpoint.json');
    fs.writeFileSync(file, JSON.stringify({ planChecksum: 'changed', checkpointChecksum: 'invalid' }));
    expect(() => loadCheckpoint(file)).toThrow(/checksum is invalid/);
  });
});

describe('shutdown and architectural boundaries', () => {
  test.each(['SIGINT', 'SIGTERM'])('%s aborts active work, flushes, and cleans up', async (signal) => {
    const abortActive = jest.fn();
    const flush = jest.fn();
    const cleanup = jest.fn();
    const state = { status: 'IN_PROGRESS' };
    const handlers = createProcessHandlers({ getRuntime: () => ({ abortActive }), getState: () => state, getWriter: () => ({ flush }), cleanup, log: jest.fn() });
    await handlers[signal]();
    expect(abortActive).toHaveBeenCalled();
    expect(flush).toHaveBeenCalledWith(state);
    expect(cleanup).toHaveBeenCalled();
    expect(state.status).toBe('INTERRUPTED');
    process.exitCode = 0;
  });

  test('top-level rejection handler performs cleanup', async () => {
    const cleanup = jest.fn();
    const state = {};
    const handlers = createProcessHandlers({ getRuntime: () => null, getState: () => state, getWriter: () => null, cleanup, log: jest.fn() });
    await handlers.unhandledRejection(new Error('boom'));
    expect(cleanup).toHaveBeenCalled();
    expect(state.status).toBe('FAILED_UNHANDLED');
    process.exitCode = 0;
  });

  test('users-only module load does not initialize R2 or load the broad user service', () => {
    const script = path.resolve(__dirname, '../../scripts/importChurchServiceUsers.js');
    // The subprocess must not inherit Jest's FORCE_COLOR: with it set, Node
    // colorizes the boolean primitive (`console.log(false)` → `[33mfalse[39m`),
    // and `.trim()` does not strip ANSI, so the plain-string compare fails on a
    // value that is actually correct. FORCE_COLOR=0 makes the output
    // deterministic without touching the architectural assertion.
    const output = execFileSync(
      process.execPath,
      ['-e', `require(${JSON.stringify(script)}); console.log(Boolean(require.cache[${JSON.stringify(path.resolve(__dirname, '../../src/modules/users/user.service.js'))}]))`],
      { encoding: 'utf8', env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' } }
    );
    expect(output.trim()).toBe('false');
    expect(output).not.toMatch(/R2 storage/);
  });

  test('CLI resilience defaults and overrides are explicit', () => {
    expect(parseArgs([])).toMatchObject({ userTimeoutMs: 30000, userRetries: 2, dbRetries: 5, dbRetryDelayMs: 2000, heartbeatMs: 15000 });
    expect(parseArgs(['--dry-run', '--user-timeout-ms=45000', '--user-retries=3', '--db-retries=4'])).toMatchObject({ userTimeoutMs: 45000, userRetries: 3, dbRetries: 4 });
  });

  test('stale plan is rejected after user state changes, except validated resume flow', () => {
    const users = [{ _id: objectId(1), fullName: 'One', customDetails: {}, isDeleted: false }];
    const plan = { database: { userStateFingerprint: calculateUserStateFingerprint(users) } };
    const changed = [...users, { _id: objectId(2), fullName: 'Two', customDetails: {}, isDeleted: false }];
    expect(() => assertDatabaseUserState(plan, changed)).toThrow(/Stale plan rejected/);
    expect(() => assertDatabaseUserState(plan, changed, { isResume: true })).not.toThrow();
  });
});

describe('new dry-run planning after interruption', () => {
  const row = (name, rowNumber) => ({ rowNumber, sector: 'Sector', meeting: 'Meeting', grade: '', group: 'Group', servants: [], member: name, declaredServants: '0', declaredMembers: '1' });

  test('plans only remaining users and marks imported source-key identities as no-ops', () => {
    const initial = buildUsersImportPlan({ parsed: { rows: [row('First Person', 2), row('Second Person', 3)], sheetName: 'Sheet2' }, activeUsers: [], allUsers: [], databaseName: 'db', inputPath: 'source.xlsx', inputHash: 'hash', generatedAt: '2026-01-01T00:00:00.000Z', validateUserPayload: () => [] });
    const first = initial.identities.find((entry) => entry.canonicalFullName === 'First Person');
    const imported = { _id: objectId(1), fullName: first.canonicalFullName, customDetails: { importSourceKey: first.importSourceKey }, isDeleted: false };
    const next = buildUsersImportPlan({ parsed: { rows: [row('First Person', 2), row('Second Person', 3)], sheetName: 'Sheet2' }, activeUsers: [imported], allUsers: [imported], databaseName: 'db', inputPath: 'source.xlsx', inputHash: 'hash', generatedAt: '2026-01-02T00:00:00.000Z', validateUserPayload: () => [] });
    expect(next.totals.safeUsersToCreate).toBe(1);
    expect(next.totals.noOpAlreadyImported).toBe(1);
    expect(next.sourceClassifications.find((entry) => entry.original === 'First Person').classification).toBe('NO_OP_ALREADY_IMPORTED');
  });
});
