#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const config = require('../src/config/env');
const Sector = require('../src/modules/meetings/sector.model');
const Meeting = require('../src/modules/meetings/meeting.model');
const User = require('../src/modules/users/user.model');
const { normalizeArabicComparison } = require('../src/utils/arabicNormalization');
const { parseWorkbook } = require('./churchServiceImport/workbook');
const { buildImportPlan, buildPeopleMatches } = require('./churchServiceImport/planner');
const { sha256File, assertPlanChecksum, assertApplyPreconditions, assertResolutionApplyPreconditions } = require('./churchServiceImport/integrity');
const { writePreflightReports } = require('./churchServiceImport/reports');
const { loadIdentityMappings, validateIdentityMappings } = require('./churchServiceResolution/identityMappings');
const { databaseFingerprint } = require('./churchServiceResolution/workbookSupport');
const { loadResolutionWorkbookMetadata, parseAndValidateResolutionWorkbook } = require('./churchServiceResolution/workbookValidator');
const { buildWorkbookData } = require('./churchServiceResolution/workbookData');
const { buildResolutionAwarePlan } = require('./churchServiceResolution/resolutionPlanner');
const { writeResolutionAwareReports } = require('./churchServiceResolution/resolutionReports');
const {
  assertSafeOnlyPreconditions,
  extractSafeOperations,
  revalidateTargetGroup,
  SafeApplyReportWriter,
  loadSafeCheckpoint,
  assertResumeCheckpoint,
  summarizeRecords,
  applySafeOperations,
} = require('./churchServiceSafeApply');
const { timestampedLog, sleep } = require('./churchServiceUsersImport/applyEngine');

const DEFAULT_INPUT = path.resolve(__dirname, '..', '..', 'بيانات الخدمة الكنسيه.xlsx');
const REPORTS_ROOT = path.resolve(__dirname, '..', 'reports');

function parseArgs(argv) {
  const options = {
    mode: 'dry-run', input: DEFAULT_INPUT, planFile: '', confirm: '', actorUserId: '', identityMappingFile: '', resolutionWorkbook: '', resumeFrom: '',
    operationTimeoutMs: 60000, operationRetries: 2, operationRetryDelayMs: 2000, heartbeatMs: 15000, dbRetries: 5, dbRetryDelayMs: 2000,
  };
  for (const token of argv) {
    if (token === '--dry-run') options.mode = 'dry-run';
    else if (token === '--apply') options.mode = 'apply';
    else if (token === '--apply-safe-only') options.mode = 'apply-safe-only';
    else if (token === '--validate-safe-only') options.mode = 'validate-safe-only';
    else if (token === '--validate-resolution-workbook') options.mode = 'validate-resolution-workbook';
    else if (token.startsWith('--input=')) options.input = path.resolve(token.slice('--input='.length).replace(/^"|"$/g, ''));
    else if (token.startsWith('--plan-file=')) options.planFile = path.resolve(token.slice('--plan-file='.length).replace(/^"|"$/g, ''));
    else if (token.startsWith('--confirm=')) options.confirm = token.slice('--confirm='.length).replace(/^"|"$/g, '');
    else if (token.startsWith('--actor-user-id=')) options.actorUserId = token.slice('--actor-user-id='.length).replace(/^"|"$/g, '');
    else if (token.startsWith('--identity-mapping-file=')) options.identityMappingFile = path.resolve(token.slice('--identity-mapping-file='.length).replace(/^"|"$/g, ''));
    else if (token.startsWith('--resolution-workbook=')) options.resolutionWorkbook = path.resolve(token.slice('--resolution-workbook='.length).replace(/^"|"$/g, ''));
    else if (token.startsWith('--resume-from=')) options.resumeFrom = path.resolve(token.slice('--resume-from='.length).replace(/^"|"$/g, ''));
    else if (token.startsWith('--operation-timeout-ms=')) options.operationTimeoutMs = Number(token.slice('--operation-timeout-ms='.length));
    else if (token.startsWith('--operation-retries=')) options.operationRetries = Number(token.slice('--operation-retries='.length));
    else if (token.startsWith('--operation-retry-delay-ms=')) options.operationRetryDelayMs = Number(token.slice('--operation-retry-delay-ms='.length));
    else if (token.startsWith('--heartbeat-ms=')) options.heartbeatMs = Number(token.slice('--heartbeat-ms='.length));
    else if (token.startsWith('--db-retries=')) options.dbRetries = Number(token.slice('--db-retries='.length));
    else if (token.startsWith('--db-retry-delay-ms=')) options.dbRetryDelayMs = Number(token.slice('--db-retry-delay-ms='.length));
    else throw new Error(`Unknown argument: ${token}`);
  }
  if (['apply', 'apply-safe-only', 'validate-safe-only'].includes(options.mode)) {
    const prefix = options.mode === 'apply' ? '--apply' : options.mode === 'apply-safe-only' ? '--apply-safe-only' : '--validate-safe-only';
    if (!options.planFile) throw new Error(`${prefix} requires --plan-file=<path>`);
    if (!options.confirm) throw new Error(`${prefix} requires --confirm=<checksum>`);
    if (!options.actorUserId) throw new Error(`${prefix} requires --actor-user-id=<existing-user-id>`);
  }
  if (['apply-safe-only', 'validate-safe-only'].includes(options.mode) && !options.resolutionWorkbook) {
    throw new Error(`--${options.mode} requires --resolution-workbook=<exact-reviewed-workbook>`);
  }
  for (const [label, value, minimum] of [
    ['operation-timeout-ms', options.operationTimeoutMs, 1000], ['operation-retries', options.operationRetries, 0],
    ['operation-retry-delay-ms', options.operationRetryDelayMs, 0], ['heartbeat-ms', options.heartbeatMs, 1000],
    ['db-retries', options.dbRetries, 0], ['db-retry-delay-ms', options.dbRetryDelayMs, 0],
  ]) {
    if (!Number.isInteger(value) || value < minimum) throw new Error(`--${label} must be an integer >= ${minimum}`);
  }
  if (options.mode === 'validate-resolution-workbook' && !options.resolutionWorkbook) throw new Error('--validate-resolution-workbook requires --resolution-workbook=<path>');
  return options;
}

async function connect({ readOnly }) {
  await mongoose.connect(config.mongo.uri, {
    autoIndex: false,
    autoCreate: false,
    serverSelectionTimeoutMS: 10000,
    connectTimeoutMS: 10000,
    socketTimeoutMS: 60000,
    ...(readOnly ? {} : {}),
  });
  return mongoose.connection.name;
}

async function connectWithRetry(options, log = timestampedLog) {
  let lastError;
  for (let attempt = 0; attempt <= options.dbRetries; attempt += 1) {
    try {
      if (mongoose.connection.readyState === 1) return mongoose.connection.name;
      if (mongoose.connection.readyState !== 0) await mongoose.disconnect().catch(() => {});
      return await connect({ readOnly: false });
    } catch (error) {
      lastError = error;
      if (attempt >= options.dbRetries) break;
      const delay = options.dbRetryDelayMs * (2 ** attempt);
      log('RETRY', `MongoDB connection retry ${attempt + 1}/${options.dbRetries} in ${delay}ms: ${error.message}`);
      await sleep(delay);
    }
  }
  throw new Error(`MongoDB connection failed after ${options.dbRetries + 1} attempts: ${lastError?.message || 'unknown error'}`);
}

async function databaseCounts() {
  const [usersTotal, usersActive, sectors, meetings] = await Promise.all([
    User.countDocuments({}).setOptions({ includeDeleted: true }),
    User.countDocuments({ isDeleted: { $ne: true } }),
    Sector.countDocuments({ isDeleted: { $ne: true } }),
    Meeting.find({ isDeleted: { $ne: true } }).select('_id groups groupAssignments servants').lean(),
  ]);
  let groups = 0;
  let servantAssignments = 0;
  let memberAssignments = 0;
  for (const meeting of meetings) {
    const groupNames = new Set([
      ...(meeting.groups || []),
      ...(meeting.groupAssignments || []).map((entry) => entry.group),
      ...(meeting.servants || []).flatMap((servant) => [
        ...(servant.groupsManaged || []),
        ...(servant.groupAssignments || []).map((entry) => entry.group),
      ]),
    ].map(normalizeGroupName).filter(Boolean));
    groups += groupNames.size;
    const servantKeys = new Set();
    for (const servant of meeting.servants || []) {
      const userId = String(servant.userId || '');
      for (const group of [
        ...(servant.groupsManaged || []),
        ...(servant.groupAssignments || []).map((entry) => entry.group),
      ]) servantKeys.add(`${userId}\u001f${normalizeGroupName(group)}`);
    }
    servantAssignments += servantKeys.size;
    const memberKeys = new Set();
    const addMembers = (entry) => {
      for (const userId of entry.servedUserIds || []) memberKeys.add(`${String(userId)}\u001f${normalizeGroupName(entry.group)}`);
    };
    (meeting.groupAssignments || []).forEach(addMembers);
    (meeting.servants || []).forEach((servant) => (servant.groupAssignments || []).forEach(addMembers));
    memberAssignments += memberKeys.size;
  }
  return { usersTotal, usersActive, sectors, meetings: meetings.length, groups, servantAssignments, memberAssignments };
}

function normalizeGroupName(value) {
  return normalizeArabicComparison(value || '');
}

async function loadDatabaseSnapshot() {
  const [users, sectors, meetings] = await Promise.all([
    User.find({ isDeleted: { $ne: true } })
      .select('_id fullName accountStatus role isLocked meetingIds')
      .lean(),
    Sector.find({ isDeleted: { $ne: true } }).select('_id name').lean(),
    Meeting.find({ isDeleted: { $ne: true } })
      .select('_id sectorId name groups groupAssignments servants servedUserIds')
      .lean(),
  ]);
  return { users, sectors, meetings };
}

function printTotals(plan, reportDir = '') {
  const t = plan.totals;
  console.log('Church service import preflight (READ-ONLY)');
  console.log(`parsed rows: ${t.parsedRows}`);
  console.log(`groups: ${t.groups}`);
  console.log(`unique names (exact / normalized): ${t.uniqueExactNames} / ${t.uniqueNormalizedNames}`);
  console.log(`exact matches: ${t.exactMatches}`);
  console.log(`normalized matches: ${t.normalizedMatches}`);
  console.log(`missing users: ${t.missingUsers}`);
  console.log(`ambiguous users: ${t.ambiguousUsers}`);
  console.log(`groups to create: ${t.groupsToCreate}`);
  console.log(`groups to reuse: ${t.groupsToReuse}`);
  console.log(`planned servant assignments: ${t.plannedServantAssignments}`);
  console.log(`planned member assignments: ${t.plannedMemberAssignments}`);
  console.log(`conflicts: ${t.conflicts}`);
  console.log(`blockers: ${t.blockers}`);
  console.log(`safe to apply: ${plan.safeToApply ? 'YES' : 'NO'}`);
  if (reportDir) console.log(`report directory: ${reportDir}`);
}

async function loadParsedSource(inputPath) {
  if (!fs.existsSync(inputPath)) throw new Error(`Input workbook not found: ${inputPath}`);
  const inputHash = sha256File(inputPath);
  const parsed = await parseWorkbook(inputPath);
  return { inputHash, parsed };
}

async function createCurrentPlan(inputPath, databaseName, source = null) {
  const { inputHash, parsed } = source || await loadParsedSource(inputPath);
  const snapshot = await loadDatabaseSnapshot();
  const plan = buildImportPlan({
    parsed,
    ...snapshot,
    databaseName,
    inputPath,
    inputHash,
    generatedAt: new Date().toISOString(),
  });
  plan.environment = config.env;
  return { plan, parsed, snapshot };
}

function arraysEqual(a, b) {
  return JSON.stringify([...(a || [])].sort()) === JSON.stringify([...(b || [])].sort());
}

function revalidateApprovedPlan(approvedPlan, currentPlan, parsed, users) {
  const errors = [];
  const currentPeople = buildPeopleMatches(parsed.rows, users).matches;
  const currentPeopleMap = new Map(currentPeople.map((person) => [person.original, person]));
  for (const approved of approvedPlan.peopleMatches || []) {
    const current = currentPeopleMap.get(approved.original);
    if (!current || !['EXACT_MATCH', 'NORMALIZED_MATCH'].includes(current.status) || current.matchedId !== approved.matchedId) {
      errors.push(`User match changed for ${approved.original}`);
    }
  }
  const currentGroups = new Map(currentPlan.groups.map((group) => [group.sourceKey, group]));
  for (const approved of approvedPlan.groups || []) {
    const current = currentGroups.get(approved.sourceKey);
    if (!current) errors.push(`Source group disappeared: ${approved.sourceKey}`);
    else if (
      current.meetingId !== approved.meetingId ||
      current.normalizedGroupName !== approved.normalizedGroupName ||
      !arraysEqual(current.resolvedMemberIds, approved.resolvedMemberIds) ||
      !arraysEqual(current.resolvedServantIds, approved.resolvedServantIds)
    ) errors.push(`Resolved group plan changed: ${approved.sourceKey}`);
  }
  if (!currentPlan.safeToApply) errors.push(`Current revalidation has ${currentPlan.blockingErrors.length} blocking errors`);
  if (errors.length) throw new Error(`Apply revalidation failed:\n- ${errors.join('\n- ')}`);
}

function writeApplyResult(planFile, result) {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const jsonPath = path.join(path.dirname(planFile), `apply-result-${stamp}.json`);
  const mdPath = path.join(path.dirname(planFile), `apply-result-${stamp}.md`);
  fs.writeFileSync(jsonPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  fs.writeFileSync(mdPath, [
    '# Church service import apply result', '',
    `- Started: ${result.startedAt}`,
    `- Finished: ${result.finishedAt}`,
    `- Plan checksum: \`${result.planChecksum}\``,
    `- Groups completed: ${result.groups.length}`,
    `- Status: ${result.status}`,
    '',
  ].join('\n'), 'utf8');
  return { jsonPath, mdPath };
}

async function runDryRun(options) {
  // Formula-cache and baseline validation must finish before opening a database connection.
  const source = await loadParsedSource(options.input);
  const databaseName = await connect({ readOnly: true });
  const { plan } = await createCurrentPlan(options.input, databaseName, source);
  if (options.resolutionWorkbook) {
    const [allUsers, meetings] = await Promise.all([
      User.find({}).setOptions({ includeDeleted: true }).select('_id fullName gender birthDate nationalId phonePrimary whatsappNumber familyName houseName education father mother spouse siblings children familyMembers meetingIds meetingAttendance divineLiturgyAttendance confessionFatherName confessionFatherUserId confessionSessionIds hasLogin accountStatus isLocked isDeleted customDetails createdAt updatedAt changeLog role').lean(),
      Meeting.find({ isDeleted: { $ne: true } }).select('_id name groups groupAssignments servants servedUserIds attendanceRecords memberNotes').lean(),
    ]);
    const fingerprint = databaseFingerprint({ databaseName, host: mongoose.connection.host, port: mongoose.connection.port });
    const metadata = await loadResolutionWorkbookMetadata(options.resolutionWorkbook);
    const resolutionPlan = JSON.parse(fs.readFileSync(metadata.sourceResolutionPlanPath, 'utf8'));
    const sourceAssignmentPlan = JSON.parse(fs.readFileSync(metadata.sourceAssignmentPlanPath, 'utf8'));
    assertPlanChecksum(resolutionPlan, metadata.sourceResolutionPlanChecksum);
    assertPlanChecksum(sourceAssignmentPlan, metadata.sourceAssignmentPlanChecksum);
    const expectedData = buildWorkbookData({ resolutionPlan, sourceAssignmentPlan, parsedRows: source.parsed.rows, users: allUsers, meetings });
    const validation = await parseAndValidateResolutionWorkbook({ workbookPath: options.resolutionWorkbook, expectedSourceExcelHash: source.inputHash, expectedDatabaseFingerprint: fingerprint, users: allUsers, meetings, parsedRows: source.parsed.rows, expectedData, writeResults: false });
    if (!validation.structurallyValid) throw new Error(`Resolution workbook validation failed:\n- ${validation.errors.join('\n- ')}`);
    const resolvedPlan = buildResolutionAwarePlan({ parsed: source.parsed, currentPlan: plan, validation, users: allUsers, meetings, workbookPath: options.resolutionWorkbook, workbookHash: validation.workbookHash, databaseFingerprint: fingerprint, generatedAt: new Date().toISOString() });
    const output = writeResolutionAwareReports(resolvedPlan, REPORTS_ROOT);
    console.log('Resolution-aware church service preflight (READ-ONLY)');
    console.log(`manual decisions: ${resolvedPlan.totals.manualDecisionsLoaded}; unresolved: ${resolvedPlan.totals.blankUnresolvedDecisions}; invalid: ${resolvedPlan.totals.invalidDecisions}`);
    console.log(`safe servant assignments: ${resolvedPlan.totals.safeServantAssignments}; safe member assignments: ${resolvedPlan.totals.safeMemberAssignments}; no-ops: ${resolvedPlan.totals.existingNoOps}`);
    console.log(`remaining blockers: ${resolvedPlan.totals.remainingBlockers}; safe operations available: ${resolvedPlan.safeOperationsAvailable ? 'YES' : 'NO'}; safe for full apply: ${resolvedPlan.safeForFullApply ? 'YES' : 'NO'}`);
    console.log(`report directory: ${output.reportDir}`);
    console.log(`plan checksum: ${output.checksum}`);
    return { plan: resolvedPlan, output, validation };
  }
  if (options.identityMappingFile) {
    const allUsers = await User.find({}).setOptions({ includeDeleted: true }).select('_id fullName role isDeleted').lean();
    const validation = validateIdentityMappings(loadIdentityMappings(options.identityMappingFile), plan.peopleMatches, allUsers);
    if (!validation.valid) throw new Error(`Identity mapping validation failed:\n- ${validation.errors.join('\n- ')}`);
    plan.manualIdentityMappingValidation = {
      file: options.identityMappingFile,
      approvedCount: validation.approved.length,
      warnings: validation.warnings,
      note: 'Validated only. This dry run does not automatically approve or apply identity mappings.',
    };
  }
  const output = writePreflightReports(plan, REPORTS_ROOT);
  printTotals(plan, output.reportDir);
  console.log(`plan checksum: ${output.checksum}`);
  console.log(`future apply requires manual approval and an explicit actor user ID`);
  return { plan, output };
}

async function loadSafeOnlyContext(options, log = timestampedLog) {
  log('STARTUP', 'Church service importer starting');
  log('STARTUP', `Mode: ${options.mode}`);
  log('STARTUP', `Input file: ${options.input}`);
  log('STARTUP', `Plan file: ${options.planFile}`);
  log('STARTUP', `Resolution workbook: ${options.resolutionWorkbook}`);
  log('STARTUP', `Actor user ID: ${options.actorUserId}`);
  for (const [label, file] of [['input workbook', options.input], ['plan file', options.planFile], ['resolution workbook', options.resolutionWorkbook]]) {
    if (!file || !fs.existsSync(file)) throw new Error(`${label} not found: ${file}`);
  }
  const planFileHash = sha256File(options.planFile);
  const approvedPlan = JSON.parse(fs.readFileSync(options.planFile, 'utf8'));
  const source = await loadParsedSource(options.input);
  log('STARTUP', 'Connecting to MongoDB');
  const databaseName = await connectWithRetry(options, log);
  log('STARTUP', 'MongoDB connected');
  const fingerprint = databaseFingerprint({ databaseName, host: mongoose.connection.host, port: mongoose.connection.port });
  assertSafeOnlyPreconditions({
    plan: approvedPlan,
    suppliedChecksum: options.confirm,
    currentInputHash: source.inputHash,
    currentDatabaseName: databaseName,
    currentResolutionWorkbookHash: sha256File(options.resolutionWorkbook),
    currentDatabaseFingerprint: fingerprint,
  });
  if (path.resolve(approvedPlan.resolutionWorkbook.path) !== path.resolve(options.resolutionWorkbook)) {
    throw new Error('Resolution workbook path differs from the approved plan');
  }
  log('STARTUP', 'Plan checksum, Excel hash, resolution workbook hash, and database target verified');
  const actor = await User.findOne({ _id: options.actorUserId, isDeleted: { $ne: true } })
    .select('_id role accountStatus isLocked')
    .lean();
  if (!actor) throw new Error('Apply actor does not exist');
  if (!['ADMIN', 'SUPER_ADMIN'].includes(actor.role) || actor.accountStatus !== 'approved' || actor.isLocked) {
    throw new Error('Apply actor must be an approved, unlocked administrator');
  }
  log('STARTUP', 'Actor verified');
  const [users, meetings] = await Promise.all([
    User.find({}).setOptions({ includeDeleted: true })
      .select('_id fullName gender birthDate nationalId phonePrimary whatsappNumber familyName houseName education father mother spouse siblings children familyMembers meetingIds meetingAttendance divineLiturgyAttendance confessionFatherName confessionFatherUserId confessionSessionIds hasLogin accountStatus isLocked isDeleted customDetails createdAt updatedAt changeLog role').lean(),
    Meeting.find({ isDeleted: { $ne: true } })
      .select('_id name groups groupAssignments servants servedUserIds attendanceRecords memberNotes').lean(),
  ]);
  const metadata = await loadResolutionWorkbookMetadata(options.resolutionWorkbook);
  const resolutionPlan = JSON.parse(fs.readFileSync(metadata.sourceResolutionPlanPath, 'utf8'));
  const sourceAssignmentPlan = JSON.parse(fs.readFileSync(metadata.sourceAssignmentPlanPath, 'utf8'));
  assertPlanChecksum(resolutionPlan, metadata.sourceResolutionPlanChecksum);
  assertPlanChecksum(sourceAssignmentPlan, metadata.sourceAssignmentPlanChecksum);
  const expectedData = buildWorkbookData({ resolutionPlan, sourceAssignmentPlan, parsedRows: source.parsed.rows, users, meetings });
  const resolutionValidation = await parseAndValidateResolutionWorkbook({
    workbookPath: options.resolutionWorkbook,
    expectedSourceExcelHash: source.inputHash,
    expectedDatabaseFingerprint: fingerprint,
    users,
    meetings,
    parsedRows: source.parsed.rows,
    expectedData,
    writeResults: false,
  });
  if (!resolutionValidation.structurallyValid) {
    throw new Error(`Resolution workbook validation failed:\n- ${resolutionValidation.errors.join('\n- ')}`);
  }
  const safePlan = extractSafeOperations(approvedPlan);
  log('STARTUP', `Safe operation extraction verified | source groups create=${safePlan.sourceGroupCounts.create}, reuse=${safePlan.sourceGroupCounts.reuse}, servants=${safePlan.servantOperations.length}, members=${safePlan.memberOperations.length}, skipped blockers=${safePlan.skippedPlanBlockers.length}`);
  return {
    approvedPlan,
    source,
    databaseName,
    fingerprint,
    actor,
    safePlan,
    resolutionValidation,
    planFileHash,
  };
}

async function runValidateSafeOnly(options) {
  const context = await loadSafeOnlyContext(options);
  console.log('Safe-only plan validation (READ-ONLY DATABASE)');
  console.log(`plan checksum: ${context.approvedPlan.planChecksum}`);
  console.log(`safe operations available: ${context.approvedPlan.safeOperationsAvailable ? 'YES' : 'NO'}`);
  console.log(`safe for full apply: ${context.approvedPlan.safeForFullApply ? 'YES' : 'NO'}`);
  console.log(`groups to create: ${context.safePlan.sourceGroupCounts.create}`);
  console.log(`groups to reuse: ${context.safePlan.sourceGroupCounts.reuse}`);
  console.log(`safe servant operations: ${context.safePlan.servantOperations.length}`);
  console.log(`safe member operations: ${context.safePlan.memberOperations.length}`);
  console.log(`skipped unresolved blocker records: ${context.safePlan.skippedPlanBlockers.length}`);
  return context;
}

function createSafeApplyAdapter({ options, context, meetingsService }) {
  let runtime = null;
  const assertRuntimeIntegrity = () => {
    const fail = (message) => {
      const error = new Error(message);
      error.globalExecutionError = true;
      throw error;
    };
    if (sha256File(options.input) !== context.source.inputHash) fail('Source Excel changed during apply');
    if (sha256File(options.resolutionWorkbook) !== context.approvedPlan.resolutionWorkbook.sha256) fail('Resolution workbook changed during apply');
    if (sha256File(options.planFile) !== context.planFileHash) fail('Plan file changed during apply');
    const currentFingerprint = databaseFingerprint({ databaseName: mongoose.connection.name, host: mongoose.connection.host, port: mongoose.connection.port });
    if (mongoose.connection.name !== context.databaseName || currentFingerprint !== context.fingerprint) fail('Database target changed during apply');
  };
  return {
    setRuntime(value) { runtime = value; },
    isConnected: () => mongoose.connection.readyState === 1,
    async revalidateTarget(target) {
      assertRuntimeIntegrity();
      const candidateIds = [...new Set([...target.servantUserIds, ...target.memberUserIds])];
      const [meeting, users] = await Promise.all([
        Meeting.findOne({ _id: target.meetingId, isDeleted: { $ne: true } })
          .select('_id name groups groupAssignments servants servedUserIds')
          .lean(),
        User.find({ _id: { $in: candidateIds }, isDeleted: { $ne: true } }).select('_id').lean(),
      ]);
      return revalidateTargetGroup(target, { meeting, activeUserIds: new Set(users.map((user) => String(user._id))) });
    },
    startSession: () => mongoose.startSession(),
    applyGroup(payload, operationContext) {
      return meetingsService.applyChurchServiceImportGroup({ ...payload, actorUserId: options.actorUserId }, { session: operationContext.session });
    },
    async abortContext(operationContext) {
      if (operationContext?.session?.inTransaction()) await operationContext.session.abortTransaction().catch(() => {});
    },
    async closeContext(operationContext) {
      if (operationContext?.session?.inTransaction()) await operationContext.session.abortTransaction().catch(() => {});
      if (operationContext?.session) await operationContext.session.endSession().catch(() => {});
    },
    async reconnect() {
      // Reset the driver session pool after transient transaction-number or
      // uncertain-commit errors; a healthy socket can still hold a stale
      // server session and must not be reused for the retry.
      if (mongoose.connection.readyState !== 0) await mongoose.disconnect().catch(() => {});
      await connectWithRetry(options);
      assertRuntimeIntegrity();
    },
    getRuntime: () => runtime,
  };
}

function installSafeApplySignalHandlers({ getRuntime, state, writer }) {
  const handler = (signal) => async () => {
    timestampedLog('SHUTDOWN', `${signal} received; aborting active transaction and flushing checkpoint`);
    state.status = 'INTERRUPTED';
    state.finishedAt = new Date().toISOString();
    const runtime = getRuntime();
    if (runtime?.abortActive) await runtime.abortActive().catch(() => {});
    writer.flushCheckpoint(state);
    writer.flushReports(state);
    process.exitCode = signal === 'SIGINT' ? 130 : 143;
  };
  const sigint = handler('SIGINT');
  const sigterm = handler('SIGTERM');
  process.once('SIGINT', sigint);
  process.once('SIGTERM', sigterm);
  return () => {
    process.removeListener('SIGINT', sigint);
    process.removeListener('SIGTERM', sigterm);
  };
}

async function runApplySafeOnly(options) {
  const context = await loadSafeOnlyContext(options);
  const meetingsService = require('../src/modules/meetings/meetings.service');
  const initialCounts = await databaseCounts();
  let state;
  let reportDir = '';
  if (options.resumeFrom) {
    const checkpoint = loadSafeCheckpoint(options.resumeFrom);
    assertResumeCheckpoint(checkpoint, {
      planChecksum: context.approvedPlan.planChecksum,
      inputHash: context.source.inputHash,
      resolutionWorkbookHash: context.approvedPlan.resolutionWorkbook.sha256,
      databaseName: context.databaseName,
      databaseFingerprint: context.fingerprint,
      actorUserId: options.actorUserId,
    });
    state = {
      ...checkpoint,
      status: 'IN_PROGRESS',
      finishedAt: '',
      attemptedOperationKeys: checkpoint.attemptedOperationKeys || [],
      beforeDatabaseCounts: initialCounts,
    };
    reportDir = path.dirname(options.resumeFrom);
  } else {
    state = {
      schemaVersion: 1,
      mode: 'APPLY_SAFE_ONLY',
      status: 'IN_PROGRESS',
      planChecksum: context.approvedPlan.planChecksum,
      inputHash: context.source.inputHash,
      resolutionWorkbookHash: context.approvedPlan.resolutionWorkbook.sha256,
      databaseName: context.databaseName,
      databaseFingerprint: context.fingerprint,
      actorUserId: options.actorUserId,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      finishedAt: '',
      currentTargetIndex: 0,
      totalTargets: context.safePlan.targets.length,
      currentOperationKey: '',
      retries: 0,
      timeouts: 0,
      attemptedOperationKeys: [],
      recordsByKey: {},
      beforeDatabaseCounts: initialCounts,
      afterDatabaseCounts: null,
      familyRelationshipsChanged: false,
      usersCreatedMergedOrDeleted: 0,
      existingAssignmentsRemovedOrMoved: 0,
    };
  }
  const writer = new SafeApplyReportWriter({ reportsRoot: REPORTS_ROOT, state, reportDir });
  const adapter = createSafeApplyAdapter({ options, context, meetingsService });
  let runtime = null;
  const originalSetRuntime = adapter.setRuntime.bind(adapter);
  adapter.setRuntime = (value) => { runtime = value; originalSetRuntime(value); };
  const removeSignalHandlers = installSafeApplySignalHandlers({ getRuntime: () => runtime, state, writer });
  timestampedLog('APPLY', `Apply report directory created: ${writer.reportDir}`);
  try {
    runtime = await applySafeOperations({ safePlan: context.safePlan, state, writer, adapter, options });
    if (state.status === 'INTERRUPTED' || runtime.stopRequested) {
      state.status = 'INTERRUPTED';
    } else {
      const totals = summarizeRecords(state);
      state.status = totals.failed ? 'COMPLETED_WITH_FAILURES' : 'COMPLETED';
    }
    state.afterDatabaseCounts = await databaseCounts();
    state.finishedAt = new Date().toISOString();
    state.updatedAt = state.finishedAt;
    const output = writer.finalize(state);
    const totals = summarizeRecords(state);
    console.log(`Safe-only apply finished with status ${state.status}`);
    console.log(`groups created: ${totals.createdGroups}; source groups reused: ${totals.reusedGroups}`);
    console.log(`servants added: ${totals.servantsAdded}; members added: ${totals.membersAdded}; no-ops: ${totals.noOps}; skipped: ${totals.skipped}; failed: ${totals.failed}`);
    console.log(`apply report directory: ${output.reportDir}`);
    console.log(`checkpoint: ${output.checkpointPath}`);
    if (state.status !== 'COMPLETED') process.exitCode = 1;
    return { state, output, totals };
  } catch (error) {
    state.status = error.globalExecutionError ? 'FAILED_GLOBAL_INTEGRITY' : 'FAILED_GLOBAL';
    state.finishedAt = new Date().toISOString();
    state.updatedAt = state.finishedAt;
    state.globalError = error.message;
    state.afterDatabaseCounts = await databaseCounts().catch(() => null);
    writer.finalize(state);
    throw error;
  } finally {
    removeSignalHandlers();
  }
}

async function runApply(options) {
  // The broad meeting service can initialize unrelated integrations; load it only in explicit apply mode.
  const meetingsService = require('../src/modules/meetings/meetings.service');
  const approvedPlan = JSON.parse(fs.readFileSync(options.planFile, 'utf8'));
  const source = await loadParsedSource(options.input);
  const databaseName = await connect({ readOnly: false });
  if (approvedPlan.resolutionWorkbook) {
    if (!options.resolutionWorkbook) throw new Error('Approved resolution-aware plan requires --resolution-workbook=<exact-reviewed-workbook>');
    const fingerprint = databaseFingerprint({ databaseName, host: mongoose.connection.host, port: mongoose.connection.port });
    assertResolutionApplyPreconditions({ plan: approvedPlan, currentResolutionWorkbookHash: sha256File(options.resolutionWorkbook), currentDatabaseFingerprint: fingerprint });
  }
  assertApplyPreconditions({
    plan: approvedPlan,
    suppliedChecksum: options.confirm,
    currentInputHash: source.inputHash,
    currentDatabaseName: databaseName,
  });
  const { plan: currentPlan, parsed, snapshot } = await createCurrentPlan(options.input, databaseName, source);
  revalidateApprovedPlan(approvedPlan, currentPlan, parsed, snapshot.users);

  const result = { status: 'IN_PROGRESS', startedAt: new Date().toISOString(), finishedAt: null, planChecksum: approvedPlan.planChecksum, actorUserId: options.actorUserId, groups: [] };
  for (const group of approvedPlan.groups) {
    const session = await mongoose.startSession();
    try {
      let groupResult;
      await session.withTransaction(async () => {
        groupResult = await meetingsService.applyChurchServiceImportGroup({
          meetingId: group.meetingId,
          groupName: group.targetGroupName,
          servantUserIds: group.resolvedServantIds,
          memberUserIds: group.resolvedMemberIds,
          actorUserId: options.actorUserId,
        }, { session });
      });
      result.groups.push({ sourceKey: group.sourceKey, status: 'COMPLETED', result: groupResult });
    } catch (error) {
      result.groups.push({ sourceKey: group.sourceKey, status: 'ROLLED_BACK', error: error.message });
      result.status = 'FAILED';
      result.finishedAt = new Date().toISOString();
      writeApplyResult(options.planFile, result);
      throw error;
    } finally {
      await session.endSession();
    }
  }
  result.status = 'COMPLETED';
  result.finishedAt = new Date().toISOString();
  const paths = writeApplyResult(options.planFile, result);
  console.log(`Apply completed. Result reports: ${paths.jsonPath}, ${paths.mdPath}`);
}

async function runValidateResolutionWorkbook(options) {
  const source = await loadParsedSource(options.input);
  const databaseName = await connect({ readOnly: true });
  const [users, meetings] = await Promise.all([
    User.find({}).setOptions({ includeDeleted: true }).select('_id fullName gender birthDate nationalId phonePrimary whatsappNumber familyName houseName education father mother spouse siblings children familyMembers meetingIds meetingAttendance divineLiturgyAttendance confessionFatherName confessionFatherUserId confessionSessionIds hasLogin accountStatus isLocked isDeleted customDetails createdAt updatedAt changeLog role').lean(),
    Meeting.find({ isDeleted: { $ne: true } }).select('_id name groups groupAssignments servants servedUserIds attendanceRecords memberNotes').lean(),
  ]);
  const fingerprint = databaseFingerprint({ databaseName, host: mongoose.connection.host, port: mongoose.connection.port });
  const metadata = await loadResolutionWorkbookMetadata(options.resolutionWorkbook);
  const resolutionPlan = JSON.parse(fs.readFileSync(metadata.sourceResolutionPlanPath, 'utf8'));
  const sourceAssignmentPlan = JSON.parse(fs.readFileSync(metadata.sourceAssignmentPlanPath, 'utf8'));
  assertPlanChecksum(resolutionPlan, metadata.sourceResolutionPlanChecksum);
  assertPlanChecksum(sourceAssignmentPlan, metadata.sourceAssignmentPlanChecksum);
  const expectedData = buildWorkbookData({ resolutionPlan, sourceAssignmentPlan, parsedRows: source.parsed.rows, users, meetings });
  const result = await parseAndValidateResolutionWorkbook({ workbookPath: options.resolutionWorkbook, expectedSourceExcelHash: source.inputHash, expectedDatabaseFingerprint: fingerprint, users, meetings, parsedRows: source.parsed.rows, expectedData, writeResults: true });
  console.log('Resolution workbook validation (READ-ONLY DATABASE)');
  console.log(`completed decisions: ${result.completedDecisions}`);
  console.log(`unresolved decisions: ${result.unresolvedDecisions}`);
  console.log(`validation errors: ${result.errors.length}`);
  console.log(`validation warnings: ${result.warnings.length}`);
  console.log(`structurally valid: ${result.structurallyValid ? 'YES' : 'NO'}`);
  console.log(`resolution complete: ${result.complete ? 'YES' : 'NO'}`);
  if (!result.structurallyValid) throw new Error(result.errors.join('\n'));
  return result;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  try {
    if (options.mode === 'apply') await runApply(options);
    else if (options.mode === 'apply-safe-only') await runApplySafeOnly(options);
    else if (options.mode === 'validate-safe-only') await runValidateSafeOnly(options);
    else if (options.mode === 'validate-resolution-workbook') await runValidateResolutionWorkbook(options);
    else await runDryRun(options);
  } finally {
    await mongoose.disconnect();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`Church service import failed: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  parseArgs,
  arraysEqual,
  revalidateApprovedPlan,
  connectWithRetry,
  databaseCounts,
  loadSafeOnlyContext,
  runValidateSafeOnly,
  createSafeApplyAdapter,
  installSafeApplySignalHandlers,
  runApplySafeOnly,
  runDryRun,
  runApply,
  runValidateResolutionWorkbook,
};
