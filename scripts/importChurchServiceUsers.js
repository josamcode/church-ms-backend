#!/usr/bin/env node
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const config = require('../src/config/env');
const User = require('../src/modules/users/user.model');
const importedUserService = require('../src/modules/users/importedUser.service');
const { parseWorkbook } = require('./churchServiceImport/workbook');
const { sha256File, assertPlanChecksum } = require('./churchServiceImport/integrity');
const { buildUsersImportPlan, calculateUserStateFingerprint } = require('./churchServiceUsersImport/planner');
const { writeUsersPreflightReports } = require('./churchServiceUsersImport/reports');
const { ApplyReportWriter, loadCheckpoint } = require('./churchServiceUsersImport/applyReports');
const { loadManualMappings, incorporateManualMappings } = require('./churchServiceUsersImport/manualMappings');
const {
  UserIndex,
  baseRecord,
  revalidateWithIndex,
  applyUsersResilient,
  timestampedLog,
  sleep,
} = require('./churchServiceUsersImport/applyEngine');

const DEFAULT_INPUT = path.resolve(__dirname, '..', '..', 'بيانات الخدمة الكنسيه.xlsx');
const REPORTS_ROOT = path.resolve(__dirname, '..', 'reports');
const DEFAULTS = Object.freeze({
  userTimeoutMs: 30000,
  userRetries: 2,
  userRetryDelayMs: 1000,
  dbRetries: 5,
  dbRetryDelayMs: 2000,
  heartbeatMs: 15000,
  serverSelectionTimeoutMS: 10000,
  connectTimeoutMS: 10000,
  socketTimeoutMS: 30000,
});

function positiveInteger(value, name, { min = 0, max = 600000 } = {}) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new Error(`--${name} must be an integer between ${min} and ${max}`);
  return parsed;
}

function parseArgs(argv) {
  const options = { mode: 'dry-run', input: DEFAULT_INPUT, planFile: '', confirm: '', actorUserId: '', familyMappingFile: '', resumeFrom: '', ...DEFAULTS };
  for (const token of argv) {
    if (token === '--dry-run') options.mode = 'dry-run';
    else if (token === '--apply-users-only') options.mode = 'apply-users-only';
    else if (token === '--apply-families-only') options.mode = 'apply-families-only';
    else if (token === '--apply') throw new Error('The combined --apply mode is disabled; use --apply-users-only or --apply-families-only');
    else if (token.startsWith('--input=')) options.input = path.resolve(token.slice(8).replace(/^"|"$/g, ''));
    else if (token.startsWith('--plan-file=')) options.planFile = path.resolve(token.slice(12).replace(/^"|"$/g, ''));
    else if (token.startsWith('--confirm=')) options.confirm = token.slice(10).replace(/^"|"$/g, '');
    else if (token.startsWith('--actor-user-id=')) options.actorUserId = token.slice(16).replace(/^"|"$/g, '');
    else if (token.startsWith('--family-mapping-file=')) options.familyMappingFile = path.resolve(token.slice(22).replace(/^"|"$/g, ''));
    else if (token.startsWith('--resume-from=')) options.resumeFrom = path.resolve(token.slice(14).replace(/^"|"$/g, ''));
    else if (token.startsWith('--user-timeout-ms=')) options.userTimeoutMs = positiveInteger(token.slice(18), 'user-timeout-ms', { min: 1000 });
    else if (token.startsWith('--user-retries=')) options.userRetries = positiveInteger(token.slice(15), 'user-retries', { max: 10 });
    else if (token.startsWith('--user-retry-delay-ms=')) options.userRetryDelayMs = positiveInteger(token.slice(22), 'user-retry-delay-ms', { max: 60000 });
    else if (token.startsWith('--db-retries=')) options.dbRetries = positiveInteger(token.slice(13), 'db-retries', { max: 20 });
    else if (token.startsWith('--db-retry-delay-ms=')) options.dbRetryDelayMs = positiveInteger(token.slice(20), 'db-retry-delay-ms', { max: 60000 });
    else if (token.startsWith('--heartbeat-ms=')) options.heartbeatMs = positiveInteger(token.slice(15), 'heartbeat-ms', { min: 1000 });
    else throw new Error(`Unknown argument: ${token}`);
  }
  if (options.resumeFrom && options.mode !== 'apply-users-only') throw new Error('--resume-from is supported only with --apply-users-only');
  if (options.mode.startsWith('apply-')) {
    if (!options.planFile) throw new Error(`${options.mode} requires --plan-file=<path>`);
    if (!options.confirm) throw new Error(`${options.mode} requires --confirm=<checksum>`);
    if (!options.actorUserId) throw new Error(`${options.mode} requires --actor-user-id=<approved-super-admin-user-id>`);
  }
  return options;
}

async function loadSource(inputPath) {
  if (!fs.existsSync(inputPath)) throw new Error(`Input workbook not found: ${inputPath}`);
  const inputHash = sha256File(inputPath);
  const parsed = await parseWorkbook(inputPath);
  return { inputHash, parsed };
}

function mongoConnectOptions(options) {
  return {
    autoIndex: false,
    autoCreate: false,
    serverSelectionTimeoutMS: options.serverSelectionTimeoutMS,
    connectTimeoutMS: options.connectTimeoutMS,
    socketTimeoutMS: options.socketTimeoutMS,
    retryWrites: true,
    heartbeatFrequencyMS: 10000,
  };
}

async function connectDatabaseWithRetry(options, log = timestampedLog, dependencies = {}) {
  const connect = dependencies.connect || ((uri, connectOptions) => mongoose.connect(uri, connectOptions));
  const disconnect = dependencies.disconnect || (() => mongoose.disconnect());
  const connectionState = dependencies.connectionState || (() => mongoose.connection.readyState);
  const databaseName = dependencies.databaseName || (() => mongoose.connection.name);
  let lastError;
  for (let attempt = 0; attempt <= options.dbRetries; attempt += 1) {
    try {
      if (connectionState() !== 0) await disconnect();
      await connect(config.mongo.uri, mongoConnectOptions(options));
      return databaseName();
    } catch (error) {
      lastError = error;
      if (attempt >= options.dbRetries) break;
      const delay = options.dbRetryDelayMs * (2 ** attempt);
      log('DB RETRY', `MongoDB unavailable; retry ${attempt + 1}/${options.dbRetries} in ${delay}ms: ${error.message}`);
      await sleep(delay);
    }
  }
  throw new Error(`MongoDB connection failed after ${options.dbRetries + 1} attempts: ${lastError?.message || 'unknown error'}`);
}

function usersQuery(session = null) {
  let query = User.find({ includeDeleted: true }).select('_id fullName gender birthDate familyName houseName father mother spouse siblings children familyMembers customDetails accountStatus hasLogin role isLocked isDeleted createdAt updatedAt');
  if (session) query = query.session(session);
  return query;
}

async function loadAllUsers(session = null) {
  return usersQuery(session).lean();
}

async function loadApplyUsers() {
  return User.find({ includeDeleted: true }).select('_id fullName customDetails isDeleted').lean();
}

async function disconnectDatabase(dependencies = {}) {
  const readyState = dependencies.readyState || (() => mongoose.connection.readyState);
  const disconnect = dependencies.disconnect || (() => mongoose.disconnect());
  if (readyState() !== 0) await disconnect();
}

function validateUserPayload(payload) {
  try {
    importedUserService.validateImportedUserData(payload);
  } catch (error) {
    return [error.message];
  }
  const validation = new User(payload).validateSync();
  if (!validation) return [];
  return Object.values(validation.errors || {}).map((error) => `${error.path}: ${error.message}`);
}

async function buildCurrentPlan(source, inputPath, databaseName) {
  const allUsers = await loadAllUsers();
  const activeUsers = allUsers.filter((user) => !user.isDeleted);
  const plan = buildUsersImportPlan({ parsed: source.parsed, activeUsers, allUsers, databaseName, inputPath, inputHash: source.inputHash, generatedAt: new Date().toISOString(), validateUserPayload });
  plan.environment = config.env;
  return { plan, allUsers, activeUsers };
}

function printTotals(plan, reportDir = '') {
  const t = plan.totals;
  console.log('Church service missing-user preflight (READ-ONLY)');
  console.log(`existing exact users: ${t.existingExactUsers}`);
  console.log(`existing normalized users: ${t.existingNormalizedUsers}`);
  console.log(`already imported source identities: ${t.noOpAlreadyImported || 0}`);
  console.log(`existing ambiguous users: ${t.existingAmbiguousUsers}`);
  console.log(`missing identity candidates: ${t.missingIdentityCandidates}`);
  console.log(`safe users to create: ${t.safeUsersToCreate}`);
  console.log(`potential homonyms: ${t.potentialHomonyms}`);
  console.log(`invalid names: ${t.invalidNames}`);
  console.log(`record blockers: ${t.recordBlockers}`);
  console.log(`global execution errors: ${t.globalExecutionErrors}`);
  console.log(`safe to create individually safe users: ${plan.safeToApplyUsersOnly ? 'YES' : 'NO'}`);
  if (reportDir) console.log(`report directory: ${reportDir}`);
}

async function runDryRun(options) {
  const source = await loadSource(options.input);
  const databaseName = await connectDatabaseWithRetry(options);
  const { plan, allUsers } = await buildCurrentPlan(source, options.input, databaseName);
  if (options.familyMappingFile) incorporateManualMappings(plan, loadManualMappings(options.familyMappingFile), allUsers.filter((user) => !user.isDeleted));
  const output = writeUsersPreflightReports(plan, REPORTS_ROOT);
  printTotals(plan, output.reportDir);
  console.log(`plan checksum: ${output.checksum}`);
  return { plan, output };
}

function isIndividuallySafe(identity) {
  return Boolean(identity && identity.operation === 'CREATE' && identity.classification === 'MISSING_SAFE_TO_CREATE' && Array.isArray(identity.blockers) && identity.blockers.length === 0 && validateUserPayload(identity.plannedUser).length === 0);
}

function selectSafeUserIdentities(plan) {
  return (plan.identities || []).filter(isIndividuallySafe);
}

async function processUsersOnlyRecords({ plan, actorUserId, loadUsers, createUser, runInTransaction }) {
  const index = new UserIndex(await loadUsers(null));
  const records = [];
  for (const identity of selectSafeUserIdentities(plan)) {
    const resolution = revalidateWithIndex(identity, index);
    if (resolution.status !== 'READY_TO_CREATE') { records.push(resolution); continue; }
    try {
      const created = await runInTransaction((session) => createUser(identity.plannedUser, actorUserId, { session }));
      const record = baseRecord(identity, 'CREATED', { databaseUserId: String(created.id || created._id), reason: 'Created through imported-user domain service' });
      records.push(record);
      index.add({ _id: record.databaseUserId, fullName: identity.canonicalFullName, customDetails: { importSourceKey: identity.importSourceKey }, isDeleted: false });
    } catch (error) {
      records.push(baseRecord(identity, error?.name === 'ValidationError' || error?.errorCode === 'VALIDATION_ERROR' ? 'FAILED_VALIDATION' : 'FAILED_SERVICE', { reason: error.message }));
    }
  }
  return records;
}

function assertPlanStructure(plan) {
  if (!plan || !Array.isArray(plan.identities)) throw new Error('Corrupt plan: identities are missing');
  if (plan.schemaVersion !== 3 || plan.executionModel !== 'RESILIENT_SEPARATE_USERS_FAMILIES_ASSIGNMENTS_V2') throw new Error('Corrupt or obsolete plan: resilient separated execution model is required');
  if (!plan.database?.userStateFingerprint) throw new Error('Corrupt plan: database user-state fingerprint is missing');
  if (!Array.isArray(plan.globalExecutionErrors) || !Array.isArray(plan.recordBlockers)) throw new Error('Corrupt plan: blocker scopes are missing');
  const stable = new Set();
  const source = new Set();
  for (const identity of plan.identities) {
    if (!identity.stablePersonKey || !identity.importSourceKey || stable.has(identity.stablePersonKey) || source.has(identity.importSourceKey)) throw new Error('Corrupt plan: missing or duplicate identity key');
    stable.add(identity.stablePersonKey);
    source.add(identity.importSourceKey);
  }
  if (Number(plan.totals?.safeUsersToCreate) !== selectSafeUserIdentities(plan).length) throw new Error('Corrupt plan: safe-user total does not match identities');
}

function assertGlobalExecutionPreconditions({ plan, suppliedChecksum, currentInputHash, currentDatabaseName }) {
  assertPlanStructure(plan);
  assertPlanChecksum(plan, suppliedChecksum);
  if (plan.input.sha256 !== currentInputHash) throw new Error('Input workbook checksum mismatch');
  if (plan.database.name !== currentDatabaseName) throw new Error('Database target mismatch');
  if (plan.globalExecutionErrors.length) throw new Error('Apply is blocked by global execution errors');
}

function assertValidApplyActor(actor) {
  if (!actor || actor.role !== 'SUPER_ADMIN' || actor.accountStatus !== 'approved' || actor.isLocked || actor.isDeleted) throw new Error('Apply actor must be an approved, unlocked SUPER_ADMIN');
}

function readApprovedPlan(planFile) {
  if (!fs.existsSync(planFile)) throw new Error(`Plan file not found: ${planFile}`);
  try { return JSON.parse(fs.readFileSync(planFile, 'utf8')); } catch (error) { throw new Error(`Corrupt plan: ${error.message}`); }
}

function assertResumeCheckpoint(checkpoint, { plan, inputHash, databaseName, actorUserId }) {
  if (checkpoint.planChecksum !== plan.planChecksum) throw new Error('Resume checkpoint plan checksum mismatch');
  if (checkpoint.inputHash !== inputHash) throw new Error('Resume checkpoint Excel hash mismatch');
  if (checkpoint.databaseName !== databaseName) throw new Error('Resume checkpoint database target mismatch');
  if (checkpoint.actorUserId !== actorUserId) throw new Error('Resume checkpoint actor mismatch');
}

function assertDatabaseUserState(plan, users, { isResume = false } = {}) {
  const current = calculateUserStateFingerprint(users);
  if (!isResume && current !== plan.database.userStateFingerprint) throw new Error('Stale plan rejected: database user state changed after preflight');
  return current;
}

function createMongoAdapter(options, actorUserId, initialUsers, log = timestampedLog) {
  let cachedUsers = initialUsers;
  let runtime = null;
  return {
    setRuntime(value) { runtime = value; },
    isConnected: () => mongoose.connection.readyState === 1,
    async loadUsers() {
      if (cachedUsers) { const value = cachedUsers; cachedUsers = null; return value; }
      return loadApplyUsers();
    },
    async probeIdentity(identity, context) {
      const maxTimeMS = Math.max(1000, options.userTimeoutMs - 500);
      const [sourceMatches, exactMatches] = await Promise.all([
        User.find({ 'customDetails.importSourceKey': identity.importSourceKey, includeDeleted: true }).select('_id fullName customDetails isDeleted').maxTimeMS(maxTimeMS).lean(),
        User.find({ fullName: identity.canonicalFullName, includeDeleted: true }).select('_id fullName customDetails isDeleted').maxTimeMS(maxTimeMS).lean(),
      ]);
      context.stage = 'revalidation_complete';
      return [...sourceMatches, ...exactMatches];
    },
    startSession: () => mongoose.startSession(),
    createUser: (identity, context) => importedUserService.createImportedUser(identity.plannedUser, actorUserId, { session: context.session, actorAlreadyVerified: true }),
    async abortActive(context) {
      context = context || {};
      if (context.closed) return;
      try {
        const client = mongoose.connection.getClient();
        if (client) await client.close(true);
      } catch (_) { /* best effort forced socket close */ }
      try { if (context.session?.inTransaction()) await context.session.abortTransaction(); } catch (_) { /* connection may already be closed */ }
      try { if (context.session) await context.session.endSession(); } catch (_) { /* best effort */ }
      context.closed = true;
    },
    async closeContext(context) {
      if (context.closed) return;
      try { if (context.session?.inTransaction()) await context.session.abortTransaction(); } finally {
        if (context.session) await context.session.endSession();
        context.closed = true;
      }
    },
    async reconnect() {
      log('WARN', 'MongoDB connection recovery starting');
      const databaseName = await connectDatabaseWithRetry(options, log);
      log('STARTUP', `MongoDB reconnected to ${databaseName}`);
      cachedUsers = null;
    },
  };
}

function initialApplyState({ plan, source, databaseName, actorUserId, identities }) {
  return {
    schemaVersion: 1,
    mode: 'APPLY_USERS_ONLY',
    status: 'IN_PROGRESS',
    planChecksum: plan.planChecksum,
    inputHash: source.inputHash,
    databaseName,
    actorUserId,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    finishedAt: '',
    currentIndex: 0,
    totalUsers: identities.length,
    processedSourceKeys: [],
    records: [],
    retries: 0,
    timeouts: 0,
    lastSuccessfullyCommittedSourceKey: '',
    familyRelationshipsChanged: false,
    meetingOrGroupAssignmentsChanged: false,
  };
}

function createProcessHandlers({ getRuntime, getState, getWriter, cleanup, log = timestampedLog }) {
  let handling = false;
  const handle = async (kind, error = null) => {
    if (handling) return;
    handling = true;
    log('SHUTDOWN', `${kind}${error ? `: ${error.message || error}` : ''}`);
    const state = getState();
    if (state) state.status = kind === 'SIGINT' || kind === 'SIGTERM' ? 'INTERRUPTED' : 'FAILED_UNHANDLED';
    try { await getRuntime()?.abortActive?.(); } catch (_) { /* cleanup continues */ }
    try { getWriter()?.flush(state); } catch (_) { /* cleanup continues */ }
    await cleanup();
    process.exitCode = kind === 'SIGINT' ? 130 : 1;
  };
  return {
    unhandledRejection: (error) => handle('unhandledRejection', error),
    uncaughtException: (error) => handle('uncaughtException', error),
    SIGINT: () => handle('SIGINT'),
    SIGTERM: () => handle('SIGTERM'),
  };
}

function installProcessHandlers(handlers) {
  Object.entries(handlers).forEach(([event, handler]) => process.on(event, handler));
  return () => Object.entries(handlers).forEach(([event, handler]) => process.off(event, handler));
}

function runPostCreationChurchPreflight(inputPath) {
  const result = spawnSync(process.execPath, [path.join(__dirname, 'importChurchService.js'), '--dry-run', `--input=${inputPath}`], { cwd: path.resolve(__dirname, '..'), stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Post-creation church-service dry run exited with code ${result.status}`);
}

async function runUsersOnlyApply(options, lifecycle = {}) {
  let writer;
  let state;
  let runtime;
  timestampedLog('STARTUP', 'Church service users importer starting');
  timestampedLog('STARTUP', 'Mode: apply-users-only');
  timestampedLog('STARTUP', `Input file: ${options.input}`);
  timestampedLog('STARTUP', `Plan file: ${options.planFile}`);
  timestampedLog('STARTUP', `Actor user ID: ${options.actorUserId}`);
  timestampedLog('STARTUP', 'Loading environment');
  timestampedLog('STARTUP', 'Connecting to MongoDB');
  const databaseName = await connectDatabaseWithRetry(options);
  timestampedLog('STARTUP', 'MongoDB connected');
  timestampedLog('STARTUP', 'Loading plan');
  const plan = readApprovedPlan(options.planFile);
  assertPlanChecksum(plan, options.confirm);
  timestampedLog('STARTUP', 'Plan checksum verified');
  const source = await loadSource(options.input);
  if (plan.input.sha256 !== source.inputHash) throw new Error('Input workbook checksum mismatch');
  timestampedLog('STARTUP', 'Excel hash verified');
  assertGlobalExecutionPreconditions({ plan, suppliedChecksum: options.confirm, currentInputHash: source.inputHash, currentDatabaseName: databaseName });
  timestampedLog('STARTUP', 'Database target verified');
  const actor = await importedUserService.assertImportActor(options.actorUserId);
  assertValidApplyActor(actor);
  timestampedLog('STARTUP', 'Actor verified');
  timestampedLog('STARTUP', 'Loading existing users');
  const existingUsers = await loadApplyUsers();
  const checkpoint = options.resumeFrom ? loadCheckpoint(options.resumeFrom) : null;
  assertDatabaseUserState(plan, existingUsers, { isResume: Boolean(checkpoint) });
  if (checkpoint) assertResumeCheckpoint(checkpoint, { plan, inputHash: source.inputHash, databaseName, actorUserId: options.actorUserId });
  timestampedLog('STARTUP', 'Existing-user index ready');

  const identities = selectSafeUserIdentities(plan);
  state = checkpoint || initialApplyState({ plan, source, databaseName, actorUserId: options.actorUserId, identities });
  writer = new ApplyReportWriter({ reportsRoot: REPORTS_ROOT, state, resumeFrom: options.resumeFrom });
  const adapter = createMongoAdapter(options, options.actorUserId, existingUsers);
  const registerRuntime = adapter.setRuntime.bind(adapter);
  adapter.setRuntime = (value) => { runtime = value; registerRuntime(value); };
  const cleanup = lifecycle.cleanup || (async () => {
    try { if (runtime?.activeContext) await adapter.abortActive(runtime.activeContext); } catch (_) { /* continue */ }
    try { if (state && writer) writer.flush(state); } catch (_) { /* continue */ }
    await disconnectDatabase();
    timestampedLog('SHUTDOWN', 'MongoDB disconnected; importer shutdown complete');
  });
  const handlers = createProcessHandlers({ getRuntime: () => runtime, getState: () => state, getWriter: () => writer, cleanup });
  const uninstall = installProcessHandlers(handlers);
  try {
    const output = await applyUsersResilient({ identities, state, writer, adapter, options });
    runtime = output.runtime;
    const failed = state.records.some((record) => ['FAILED_TIMEOUT', 'FAILED_VALIDATION', 'FAILED_SERVICE'].includes(record.status));
    state.status = failed ? 'COMPLETED_WITH_RECORD_FAILURES' : 'COMPLETED';
    state.finishedAt = new Date().toISOString();
    const reports = writer.finalize(state);
    timestampedLog('APPLY', `Users-only apply finished; reports: ${reports.reportDir}`);
    if (!failed) runPostCreationChurchPreflight(options.input);
    return { state, reports };
  } catch (error) {
    state.status = 'PARTIAL_FAILED';
    state.finishedAt = new Date().toISOString();
    writer.finalize(state);
    throw error;
  } finally {
    uninstall();
    await cleanup();
  }
}

async function runFamiliesOnlyApply(options) {
  const plan = readApprovedPlan(options.planFile);
  const source = await loadSource(options.input);
  const databaseName = await connectDatabaseWithRetry(options);
  assertGlobalExecutionPreconditions({ plan, suppliedChecksum: options.confirm, currentInputHash: source.inputHash, currentDatabaseName: databaseName });
  await importedUserService.assertImportActor(options.actorUserId);
  const approvedLinks = plan.approvedManualFamilyRelationships || [];
  if (!approvedLinks.length) throw new Error('Family-only apply requires manually approved relationships in a separately reviewed plan');
  const userService = require('../src/modules/users/user.service'); // Lazy: never loaded by dry-run or users-only mode.
  for (const link of approvedLinks) {
    const identity = plan.identities.find((entry) => entry.stablePersonKey === link.stablePersonKey);
    if (!identity) throw new Error(`Approved family identity is absent: ${link.stablePersonKey}`);
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        const child = await User.findOne({ 'customDetails.importSourceKey': identity.importSourceKey, isDeleted: { $ne: true } }).session(session).select('_id').lean();
        if (!child) throw new Error(`Created child user was not found: ${identity.stablePersonKey}`);
        await userService.linkImportedParentChild({ childUserId: child._id, parentUserId: link.parentUserId, relation: link.relation, actorUserId: options.actorUserId }, { session });
      });
    } finally { await session.endSession(); }
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  try {
    if (options.mode === 'apply-users-only') await runUsersOnlyApply(options);
    else if (options.mode === 'apply-families-only') await runFamiliesOnlyApply(options);
    else await runDryRun(options);
  } catch (error) {
    console.error(`Church service user import failed: ${error.message}`);
    process.exitCode = 1;
  } finally {
    await disconnectDatabase();
    timestampedLog('SHUTDOWN', 'Final cleanup complete');
  }
}

if (require.main === module) main();

module.exports = {
  DEFAULTS,
  parseArgs,
  mongoConnectOptions,
  connectDatabaseWithRetry,
  disconnectDatabase,
  validateUserPayload,
  isIndividuallySafe,
  selectSafeUserIdentities,
  assertPlanStructure,
  assertGlobalExecutionPreconditions,
  assertValidApplyActor,
  assertResumeCheckpoint,
  assertDatabaseUserState,
  createMongoAdapter,
  createProcessHandlers,
  installProcessHandlers,
  runDryRun,
  runUsersOnlyApply,
  runFamiliesOnlyApply,
  processUsersOnlyRecords,
  revalidateIdentity: (identity, users) => revalidateWithIndex(identity, new UserIndex(users)),
  revalidateApprovedIdentities: (plan, users) => selectSafeUserIdentities(plan).map((identity) => {
    const result = revalidateWithIndex(identity, new UserIndex(users));
    const action = { READY_TO_CREATE: 'CREATE', SKIPPED_ALREADY_IMPORTED: 'NO_OP_ALREADY_IMPORTED', REUSED_EXISTING: 'REUSE_EXISTING', SKIPPED_NEW_AMBIGUITY: 'AMBIGUOUS', BLOCKED: 'BLOCKED' }[result.status] || result.status;
    return { identity, ...result, action, existingUserId: result.databaseUserId };
  }),
};
