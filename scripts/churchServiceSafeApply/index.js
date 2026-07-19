const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { normalizeArabicComparison } = require('../../src/utils/arabicNormalization');
const { assertPlanChecksum } = require('../churchServiceImport/integrity');
const { csvCell } = require('../churchServiceImport/reports');
const {
  GlobalDatabaseUnavailableError,
  isTransientMongoError,
  isUncertainCommitError,
  runAbortableWithTimeout,
  sleep,
  timestampedLog,
} = require('../churchServiceUsersImport/applyEngine');

const idOf = (value) => String(value?._id || value?.id || value || '');
const unique = (values) => [...new Set((values || []).filter(Boolean))];
const groupKey = (meetingId, groupName) => `${meetingId}\u001f${normalizeArabicComparison(groupName)}`;
const assignmentKey = (kind, meetingId, groupName, userId) => `${kind}\u001f${groupKey(meetingId, groupName)}\u001f${userId}`;

function assertSafeOnlyPreconditions({
  plan,
  suppliedChecksum,
  currentInputHash,
  currentDatabaseName,
  currentResolutionWorkbookHash,
  currentDatabaseFingerprint,
}) {
  assertPlanChecksum(plan, suppliedChecksum);
  if (plan.mode !== 'RESOLUTION_AWARE_DRY_RUN' || plan.schemaVersion !== 2) {
    throw new Error('Safe-only apply requires a schemaVersion 2 resolution-aware plan');
  }
  if (!plan.safeOperationsAvailable) throw new Error('Safe-only apply is blocked because no safe operations are available');
  if (plan.input?.sha256 !== currentInputHash) throw new Error('Input workbook checksum mismatch');
  if (plan.database?.name !== currentDatabaseName) throw new Error('Database target mismatch');
  if (!plan.resolutionWorkbook?.sha256 || plan.resolutionWorkbook.sha256 !== currentResolutionWorkbookHash) {
    throw new Error('Resolution workbook checksum mismatch');
  }
  if (!plan.databaseFingerprint || plan.databaseFingerprint !== currentDatabaseFingerprint) {
    throw new Error('Database target fingerprint mismatch');
  }
  return true;
}

function extractSafeOperations(plan) {
  if (!plan?.safeOperationsAvailable) throw new Error('Plan has no individually safe operations');
  const blockedMemberKeys = new Set(
    (plan.blockingErrors || [])
      .filter((entry) => entry.type === 'EXISTING_GROUP_MEMBERSHIP_CONFLICT')
      .map((entry) => assignmentKey('MEMBER', entry.meetingId, entry.group, entry.userId))
  );
  const targets = new Map();
  const servants = new Map();
  const members = new Map();
  for (const source of plan.groups || []) {
    const key = groupKey(source.meetingId, source.targetGroupName);
    if (!targets.has(key)) {
      targets.set(key, {
        operationKey: `GROUP\u001f${key}`,
        meetingId: source.meetingId,
        meetingName: source.meeting,
        sectorName: source.sector,
        targetGroupName: source.targetGroupName,
        sources: [],
        servantUserIds: new Set(),
        memberUserIds: new Set(),
      });
    }
    const target = targets.get(key);
    target.sources.push({
      sourceKey: source.sourceKey,
      sector: source.sector,
      meeting: source.meeting,
      grade: source.grade,
      originalGroupName: source.originalGroupName,
      targetGroupName: source.targetGroupName,
      groupAction: source.groupAction,
      plannedOperation: source.operations?.group || source.groupAction,
    });
    for (const userId of source.requestedServantIds || []) {
      const operationKey = assignmentKey('SERVANT', source.meetingId, source.targetGroupName, userId);
      if (!servants.has(operationKey)) {
        const operation = { operationKey, kind: 'SERVANT', meetingId: source.meetingId, meetingName: source.meeting, groupName: source.targetGroupName, userId };
        servants.set(operationKey, operation);
        target.servantUserIds.add(userId);
      }
    }
    for (const userId of source.requestedMemberIds || []) {
      const operationKey = assignmentKey('MEMBER', source.meetingId, source.targetGroupName, userId);
      if (blockedMemberKeys.has(operationKey)) continue;
      if (!members.has(operationKey)) {
        const operation = { operationKey, kind: 'MEMBER', meetingId: source.meetingId, meetingName: source.meeting, groupName: source.targetGroupName, userId };
        members.set(operationKey, operation);
        target.memberUserIds.add(userId);
      }
    }
  }
  const expectedServants = (plan.groups || []).reduce(
    (sum, group) => sum + Number(group.operations?.servantAssignments?.ADD || 0) + Number(group.operations?.servantAssignments?.NO_OP || 0), 0
  );
  const expectedMembers = (plan.groups || []).reduce(
    (sum, group) => sum + Number(group.operations?.memberAssignments?.ADD || 0) + Number(group.operations?.memberAssignments?.NO_OP || 0), 0
  );
  if (servants.size !== expectedServants || members.size !== expectedMembers) {
    throw new Error(`Safe operation extraction mismatch: servants ${servants.size}/${expectedServants}, members ${members.size}/${expectedMembers}`);
  }
  if (Number(plan.totals?.safeServantAssignments || 0) > servants.size
    || Number(plan.totals?.safeMemberAssignments || 0) > members.size) {
    throw new Error('Plan safe-assignment totals exceed the extracted operation set');
  }
  const sourceCreate = (plan.groups || []).filter((group) => group.groupAction === 'CREATE').length;
  const sourceReuse = (plan.groups || []).filter((group) => group.groupAction === 'REUSE').length;
  if (sourceCreate !== Number(plan.totals?.groupsToCreate || 0) || sourceReuse !== Number(plan.totals?.groupsToReuse || 0)) {
    throw new Error('Plan group totals do not match source group operations');
  }
  return {
    targets: [...targets.values()].map((target) => ({
      ...target,
      servantUserIds: [...target.servantUserIds],
      memberUserIds: [...target.memberUserIds],
    })),
    servantOperations: [...servants.values()],
    memberOperations: [...members.values()],
    skippedPlanBlockers: (plan.blockingErrors || []).map((blocker, index) => ({
      operationKey: `SKIPPED\u001f${index}\u001f${blocker.type}`,
      kind: blocker.type,
      status: 'SKIPPED_UNRESOLVED',
      reason: blocker.message || blocker.type,
      sourceKey: blocker.sourceKey || '',
      identityKey: blocker.identityKey || '',
      conflictKey: blocker.conflictKey || '',
      userId: blocker.userId || '',
      meetingId: blocker.meetingId || '',
      groupName: blocker.group || '',
    })),
    sourceGroupCounts: { create: sourceCreate, reuse: sourceReuse },
  };
}

function existingGroupNames(meeting) {
  return unique([
    ...(meeting.groups || []),
    ...(meeting.groupAssignments || []).map((entry) => entry.group),
    ...(meeting.servants || []).flatMap((servant) => [
      ...(servant.groupsManaged || []),
      ...(servant.groupAssignments || []).map((entry) => entry.group),
    ]),
  ].map((name) => String(name || '').trim()).filter(Boolean));
}

function existingMemberGroups(meeting) {
  const result = new Map();
  const add = (assignment) => {
    const name = String(assignment?.group || '').trim();
    for (const value of assignment?.servedUserIds || []) {
      const userId = idOf(value);
      if (!result.has(userId)) result.set(userId, new Set());
      result.get(userId).add(name);
    }
  };
  (meeting.groupAssignments || []).forEach(add);
  (meeting.servants || []).forEach((servant) => (servant.groupAssignments || []).forEach(add));
  return result;
}

function existingServantGroups(meeting) {
  const result = new Map();
  for (const servant of meeting.servants || []) {
    const userId = idOf(servant.userId);
    result.set(userId, new Set(unique([
      ...(servant.groupsManaged || []),
      ...(servant.groupAssignments || []).map((entry) => entry.group),
    ])));
  }
  return result;
}

function revalidateTargetGroup(target, { meeting, activeUserIds }) {
  if (!meeting) {
    return { globalError: '', targetError: 'Meeting no longer exists', groupExists: false, groupName: target.targetGroupName, servantAdds: [], servantNoOps: [], servantBlocked: target.servantUserIds.map((userId) => ({ userId, reason: 'Meeting no longer exists' })), memberAdds: [], memberNoOps: [], memberBlocked: target.memberUserIds.map((userId) => ({ userId, reason: 'Meeting no longer exists' })) };
  }
  const normalized = normalizeArabicComparison(target.targetGroupName);
  const equivalent = existingGroupNames(meeting).filter((name) => normalizeArabicComparison(name) === normalized);
  if (equivalent.length > 1) {
    return { globalError: '', targetError: 'Multiple current groups normalize to the planned target name', groupExists: true, groupName: target.targetGroupName, servantAdds: [], servantNoOps: [], servantBlocked: target.servantUserIds.map((userId) => ({ userId, reason: 'Ambiguous target group' })), memberAdds: [], memberNoOps: [], memberBlocked: target.memberUserIds.map((userId) => ({ userId, reason: 'Ambiguous target group' })) };
  }
  const groupExists = equivalent.length === 1;
  const groupName = equivalent[0] || target.targetGroupName;
  const plannedReuseOnly = target.sources.every((source) => source.plannedOperation === 'REUSE');
  if (!groupExists && plannedReuseOnly) {
    return { globalError: '', targetError: 'A group planned for reuse no longer exists', groupExists: false, groupName, servantAdds: [], servantNoOps: [], servantBlocked: target.servantUserIds.map((userId) => ({ userId, reason: 'Planned reusable group disappeared' })), memberAdds: [], memberNoOps: [], memberBlocked: target.memberUserIds.map((userId) => ({ userId, reason: 'Planned reusable group disappeared' })) };
  }
  const memberGroups = existingMemberGroups(meeting);
  const servantGroups = existingServantGroups(meeting);
  const servantAdds = [];
  const servantNoOps = [];
  const servantBlocked = [];
  for (const userId of target.servantUserIds) {
    if (!activeUserIds.has(userId)) servantBlocked.push({ userId, reason: 'Target servant user no longer exists or is deleted' });
    else if ([...(servantGroups.get(userId) || [])].some((name) => normalizeArabicComparison(name) === normalized)) servantNoOps.push(userId);
    else servantAdds.push(userId);
  }
  const memberAdds = [];
  const memberNoOps = [];
  const memberBlocked = [];
  for (const userId of target.memberUserIds) {
    if (!activeUserIds.has(userId)) {
      memberBlocked.push({ userId, reason: 'Target member user no longer exists or is deleted' });
      continue;
    }
    const currentGroups = [...(memberGroups.get(userId) || [])];
    if (currentGroups.some((name) => normalizeArabicComparison(name) === normalized)) memberNoOps.push(userId);
    else if (currentGroups.length) memberBlocked.push({ userId, reason: `User is now assigned to another group in this meeting: ${currentGroups.join(' | ')}` });
    else memberAdds.push(userId);
  }
  return { globalError: '', targetError: '', groupExists, groupName, servantAdds, servantNoOps, servantBlocked, memberAdds, memberNoOps, memberBlocked };
}

function checkpointChecksum(checkpoint) {
  const canonicalize = (value) => {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
    return value;
  };
  return crypto.createHash('sha256').update(JSON.stringify(canonicalize({ ...checkpoint, checkpointChecksum: null }))).digest('hex');
}

function atomicWrite(filePath, content) {
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const descriptor = fs.openSync(temporaryPath, 'w');
  try {
    fs.writeFileSync(descriptor, content, 'utf8');
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fs.renameSync(temporaryPath, filePath);
}

function csvText(headers, rows) {
  return `\uFEFF${[headers.map(csvCell).join(','), ...rows.map((row) => headers.map((header) => csvCell(row[header])).join(','))].join('\r\n')}\r\n`;
}

function applyReportDirectoryName(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return `church-service-safe-apply-${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

const GROUP_HEADERS = ['Operation key', 'Source key', 'Sector', 'Meeting', 'Grade', 'Original group', 'Target group', 'Status', 'Reason'];
const ASSIGNMENT_HEADERS = ['Operation key', 'Meeting ID', 'Meeting', 'Group', 'User ID', 'Status', 'Reason'];
const SKIPPED_HEADERS = ['Operation key', 'Type', 'Source key', 'Identity key', 'Conflict key', 'Meeting ID', 'Group', 'User ID', 'Status', 'Reason'];
const FAILED_HEADERS = ['Operation key', 'Type', 'Meeting ID', 'Group', 'User ID', 'Status', 'Attempts', 'Reason'];

function summarizeRecords(state) {
  const records = Object.values(state.recordsByKey || {});
  return {
    createdGroups: records.filter((record) => record.category === 'GROUP_CREATED').length,
    reusedGroups: records.filter((record) => record.category === 'GROUP_REUSED').length,
    servantsAdded: records.filter((record) => record.category === 'SERVANT_ADDED').length,
    membersAdded: records.filter((record) => record.category === 'MEMBER_ADDED').length,
    noOps: records.filter((record) => record.category === 'NO_OP').length,
    skipped: records.filter((record) => record.category === 'SKIPPED').length,
    failed: records.filter((record) => record.category === 'FAILED').length,
  };
}

function summaryMarkdown(state, partial) {
  const totals = summarizeRecords(state);
  return [
    `# Church-service safe-only apply ${partial ? 'partial checkpoint' : 'result'}`, '',
    `- Status: ${state.status}`,
    `- Database: \`${state.databaseName}\``,
    `- Source Excel SHA-256: \`${state.inputHash}\``,
    `- Resolution workbook SHA-256: \`${state.resolutionWorkbookHash}\``,
    `- Plan checksum: \`${state.planChecksum}\``,
    `- Groups created: ${totals.createdGroups}`,
    `- Source groups reused: ${totals.reusedGroups}`,
    `- Servant assignments added: ${totals.servantsAdded}`,
    `- Member assignments added: ${totals.membersAdded}`,
    `- Existing assignment no-ops: ${totals.noOps}`,
    `- Skipped unresolved/apply-time operations: ${totals.skipped}`,
    `- Failed operations: ${totals.failed}`,
    `- Users created/merged/deleted: 0`,
    `- Family relationships changed: NO`,
    `- Existing assignments removed or moved: NO`,
    '',
  ].join('\n');
}

class SafeApplyReportWriter {
  constructor({ reportsRoot, state, reportDir = '' }) {
    this.reportDir = reportDir || path.join(reportsRoot, applyReportDirectoryName());
    if (!fs.existsSync(this.reportDir)) fs.mkdirSync(this.reportDir, { recursive: false });
    this.checkpointPath = path.join(this.reportDir, 'checkpoint.json');
    this.flushCheckpoint(state);
    this.flushReports(state);
  }

  upsert(state, record) {
    state.recordsByKey[record.operationKey] = record;
    state.updatedAt = new Date().toISOString();
    state.currentOperationKey = record.operationKey;
    this.flushCheckpoint(state);
  }

  flushCheckpoint(state) {
    const checkpoint = {
      schemaVersion: 1,
      mode: 'APPLY_SAFE_ONLY',
      status: state.status,
      planChecksum: state.planChecksum,
      inputHash: state.inputHash,
      resolutionWorkbookHash: state.resolutionWorkbookHash,
      databaseName: state.databaseName,
      databaseFingerprint: state.databaseFingerprint,
      actorUserId: state.actorUserId,
      startedAt: state.startedAt,
      updatedAt: state.updatedAt,
      finishedAt: state.finishedAt,
      currentTargetIndex: state.currentTargetIndex,
      totalTargets: state.totalTargets,
      currentOperationKey: state.currentOperationKey,
      retries: state.retries,
      timeouts: state.timeouts,
      attemptedOperationKeys: state.attemptedOperationKeys,
      recordsByKey: state.recordsByKey,
      checkpointChecksum: null,
    };
    checkpoint.checkpointChecksum = checkpointChecksum(checkpoint);
    atomicWrite(this.checkpointPath, `${JSON.stringify(checkpoint, null, 2)}\n`);
    return checkpoint;
  }

  flushReports(state) {
    const records = Object.values(state.recordsByKey || {});
    const groupRow = (record) => ({
      'Operation key': record.operationKey, 'Source key': record.sourceKey || '', Sector: record.sector || '', Meeting: record.meetingName || '', Grade: record.grade || '', 'Original group': record.originalGroupName || '', 'Target group': record.groupName || '', Status: record.status, Reason: record.reason || '',
    });
    const assignmentRow = (record) => ({
      'Operation key': record.operationKey, 'Meeting ID': record.meetingId || '', Meeting: record.meetingName || '', Group: record.groupName || '', 'User ID': record.userId || '', Status: record.status, Reason: record.reason || '',
    });
    const skippedRow = (record) => ({
      'Operation key': record.operationKey, Type: record.kind || '', 'Source key': record.sourceKey || '', 'Identity key': record.identityKey || '', 'Conflict key': record.conflictKey || '', 'Meeting ID': record.meetingId || '', Group: record.groupName || '', 'User ID': record.userId || '', Status: record.status, Reason: record.reason || '',
    });
    const failedRow = (record) => ({
      'Operation key': record.operationKey, Type: record.kind || '', 'Meeting ID': record.meetingId || '', Group: record.groupName || '', 'User ID': record.userId || '', Status: record.status, Attempts: record.attempts || 1, Reason: record.reason || '',
    });
    atomicWrite(path.join(this.reportDir, 'created-groups.csv'), csvText(GROUP_HEADERS, records.filter((record) => record.category === 'GROUP_CREATED').map(groupRow)));
    atomicWrite(path.join(this.reportDir, 'reused-groups.csv'), csvText(GROUP_HEADERS, records.filter((record) => record.category === 'GROUP_REUSED').map(groupRow)));
    atomicWrite(path.join(this.reportDir, 'servant-assignments-added.csv'), csvText(ASSIGNMENT_HEADERS, records.filter((record) => record.category === 'SERVANT_ADDED').map(assignmentRow)));
    atomicWrite(path.join(this.reportDir, 'member-assignments-added.csv'), csvText(ASSIGNMENT_HEADERS, records.filter((record) => record.category === 'MEMBER_ADDED').map(assignmentRow)));
    atomicWrite(path.join(this.reportDir, 'no-op-assignments.csv'), csvText(ASSIGNMENT_HEADERS, records.filter((record) => record.category === 'NO_OP').map(assignmentRow)));
    atomicWrite(path.join(this.reportDir, 'skipped-unresolved-operations.csv'), csvText(SKIPPED_HEADERS, records.filter((record) => record.category === 'SKIPPED').map(skippedRow)));
    atomicWrite(path.join(this.reportDir, 'failed-operations.csv'), csvText(FAILED_HEADERS, records.filter((record) => record.category === 'FAILED').map(failedRow)));
    atomicWrite(path.join(this.reportDir, 'summary.partial.md'), summaryMarkdown(state, true));
  }

  finalize(state) {
    this.flushCheckpoint(state);
    this.flushReports(state);
    atomicWrite(path.join(this.reportDir, 'summary.md'), summaryMarkdown(state, false));
    atomicWrite(path.join(this.reportDir, 'apply-result.json'), `${JSON.stringify({ ...state, totals: summarizeRecords(state) }, null, 2)}\n`);
    return { reportDir: this.reportDir, checkpointPath: this.checkpointPath };
  }
}

function loadSafeCheckpoint(checkpointPath) {
  const checkpoint = JSON.parse(fs.readFileSync(checkpointPath, 'utf8'));
  const actual = checkpointChecksum(checkpoint);
  if (!checkpoint.checkpointChecksum || checkpoint.checkpointChecksum !== actual) throw new Error('Checkpoint checksum is invalid');
  return checkpoint;
}

function assertResumeCheckpoint(checkpoint, expected) {
  if (checkpoint.planChecksum !== expected.planChecksum) throw new Error('Resume checkpoint plan checksum mismatch');
  if (checkpoint.inputHash !== expected.inputHash) throw new Error('Resume checkpoint Excel hash mismatch');
  if (checkpoint.resolutionWorkbookHash !== expected.resolutionWorkbookHash) throw new Error('Resume checkpoint resolution workbook hash mismatch');
  if (checkpoint.databaseName !== expected.databaseName || checkpoint.databaseFingerprint !== expected.databaseFingerprint) throw new Error('Resume checkpoint database target mismatch');
  if (checkpoint.actorUserId !== expected.actorUserId) throw new Error('Resume checkpoint actor mismatch');
  return true;
}

function baseRecord(operation, category, status, reason = '', extra = {}) {
  return { ...operation, category, status, reason, attempts: 1, updatedAt: new Date().toISOString(), ...extra };
}

function startHeartbeat({ state, runtime, intervalMs, log = timestampedLog }) {
  const timer = setInterval(() => {
    const elapsed = runtime.currentStartedAt ? Math.floor((Date.now() - runtime.currentStartedAt) / 1000) : 0;
    log('HEARTBEAT', `Process alive | Target: ${state.currentTargetIndex}/${state.totalTargets} | Current elapsed: ${elapsed}s | MongoDB: ${runtime.isConnected() ? 'connected' : 'disconnected'}`);
  }, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  return () => clearInterval(timer);
}

function recordTargetOutcome({ state, writer, target, validation, committed, uncertain, attempts }) {
  const statusForAdded = uncertain ? 'RECOVERED_AFTER_UNCERTAIN_COMMIT' : 'ADDED';
  if (!validation.targetError) {
    delete state.recordsByKey[target.operationKey];
    for (const source of target.sources) {
      const operationKey = `SOURCE_GROUP\u001f${source.sourceKey}`;
      const previous = state.recordsByKey[operationKey];
      const created = source.groupAction === 'CREATE' && !validation.groupExists && committed;
      if (previous?.category === 'GROUP_CREATED' && validation.groupExists) {
        writer.upsert(state, { ...previous, status: 'RESUME_CONFIRMED', reason: 'Created group confirmed during resume revalidation', updatedAt: new Date().toISOString() });
        continue;
      }
      writer.upsert(state, baseRecord({
        operationKey,
        sourceKey: source.sourceKey,
        sector: source.sector,
        meetingName: source.meeting,
        grade: source.grade,
        originalGroupName: source.originalGroupName,
        groupName: validation.groupName,
        kind: 'GROUP',
      }, created ? 'GROUP_CREATED' : 'GROUP_REUSED', created ? 'CREATED' : 'REUSED', created ? 'Created additively through meeting domain service' : 'Existing canonical group reused', { attempts }));
    }
  }
  for (const userId of validation.servantAdds) {
    const operation = { operationKey: assignmentKey('SERVANT', target.meetingId, target.targetGroupName, userId), kind: 'SERVANT', meetingId: target.meetingId, meetingName: target.meetingName, groupName: validation.groupName, userId };
    writer.upsert(state, baseRecord(operation, 'SERVANT_ADDED', statusForAdded, uncertain ? 'Assignment found after uncertain commit' : 'Added through meeting domain service', { attempts }));
  }
  for (const userId of validation.memberAdds) {
    const operation = { operationKey: assignmentKey('MEMBER', target.meetingId, target.targetGroupName, userId), kind: 'MEMBER', meetingId: target.meetingId, meetingName: target.meetingName, groupName: validation.groupName, userId };
    writer.upsert(state, baseRecord(operation, 'MEMBER_ADDED', statusForAdded, uncertain ? 'Assignment found after uncertain commit' : 'Added through meeting domain service', { attempts }));
  }
  for (const userId of validation.servantNoOps) {
    const key = assignmentKey('SERVANT', target.meetingId, target.targetGroupName, userId);
    const previous = state.recordsByKey[key];
    if (previous?.category === 'SERVANT_ADDED') writer.upsert(state, { ...previous, status: 'RESUME_CONFIRMED', reason: 'Added servant assignment confirmed during resume revalidation', updatedAt: new Date().toISOString() });
    else if (uncertain && state.attemptedOperationKeys.includes(key)) writer.upsert(state, baseRecord({ operationKey: key, kind: 'SERVANT', meetingId: target.meetingId, meetingName: target.meetingName, groupName: validation.groupName, userId }, 'SERVANT_ADDED', 'RECOVERED_AFTER_UNCERTAIN_COMMIT', 'Assignment found after uncertain commit', { attempts }));
    else writer.upsert(state, baseRecord({ operationKey: key, kind: 'SERVANT', meetingId: target.meetingId, meetingName: target.meetingName, groupName: validation.groupName, userId }, 'NO_OP', 'NO_OP_ALREADY_EXISTS', 'Identical servant assignment already exists', { attempts }));
  }
  for (const userId of validation.memberNoOps) {
    const key = assignmentKey('MEMBER', target.meetingId, target.targetGroupName, userId);
    const previous = state.recordsByKey[key];
    if (previous?.category === 'MEMBER_ADDED') writer.upsert(state, { ...previous, status: 'RESUME_CONFIRMED', reason: 'Added member assignment confirmed during resume revalidation', updatedAt: new Date().toISOString() });
    else if (uncertain && state.attemptedOperationKeys.includes(key)) writer.upsert(state, baseRecord({ operationKey: key, kind: 'MEMBER', meetingId: target.meetingId, meetingName: target.meetingName, groupName: validation.groupName, userId }, 'MEMBER_ADDED', 'RECOVERED_AFTER_UNCERTAIN_COMMIT', 'Assignment found after uncertain commit', { attempts }));
    else writer.upsert(state, baseRecord({ operationKey: key, kind: 'MEMBER', meetingId: target.meetingId, meetingName: target.meetingName, groupName: validation.groupName, userId }, 'NO_OP', 'NO_OP_ALREADY_EXISTS', 'Identical member assignment already exists', { attempts }));
  }
  for (const blocked of validation.servantBlocked) {
    const operation = { operationKey: assignmentKey('SERVANT', target.meetingId, target.targetGroupName, blocked.userId), kind: 'SERVANT', meetingId: target.meetingId, meetingName: target.meetingName, groupName: validation.groupName, userId: blocked.userId };
    writer.upsert(state, baseRecord(operation, 'SKIPPED', 'SKIPPED_APPLY_REVALIDATION', blocked.reason, { attempts }));
  }
  for (const blocked of validation.memberBlocked) {
    const operation = { operationKey: assignmentKey('MEMBER', target.meetingId, target.targetGroupName, blocked.userId), kind: 'MEMBER', meetingId: target.meetingId, meetingName: target.meetingName, groupName: validation.groupName, userId: blocked.userId };
    writer.upsert(state, baseRecord(operation, 'SKIPPED', 'SKIPPED_APPLY_REVALIDATION', blocked.reason, { attempts }));
  }
}

async function applySafeOperations({ safePlan, state, writer, adapter, options, log = timestampedLog }) {
  const runtime = { stopRequested: false, activeContext: null, currentStartedAt: 0, isConnected: adapter.isConnected };
  runtime.abortActive = async () => {
    runtime.stopRequested = true;
    if (runtime.activeContext) await adapter.abortContext(runtime.activeContext);
    writer.flushCheckpoint(state);
    writer.flushReports(state);
  };
  if (adapter.setRuntime) adapter.setRuntime(runtime);
  const stopHeartbeat = startHeartbeat({ state, runtime, intervalMs: options.heartbeatMs, log });
  try {
    for (const blocker of safePlan.skippedPlanBlockers) writer.upsert(state, { ...blocker, category: 'SKIPPED', updatedAt: new Date().toISOString() });
    writer.flushReports(state);
    log('APPLY', `Beginning safe-only apply | targets=${safePlan.targets.length} | servants=${safePlan.servantOperations.length} | members=${safePlan.memberOperations.length}`);
    for (let index = 0; index < safePlan.targets.length; index += 1) {
      if (runtime.stopRequested) break;
      const target = safePlan.targets[index];
      state.currentTargetIndex = index + 1;
      runtime.currentStartedAt = Date.now();
      const prefix = `TARGET ${index + 1}/${safePlan.targets.length}`;
      log(prefix, `Starting ${target.meetingName} / ${target.targetGroupName}`);
      let final = null;
      let uncertain = false;
      for (let attempt = 0; attempt <= options.operationRetries; attempt += 1) {
        const context = { target, session: null, transactionStarted: false, stage: 'revalidation', attempt: attempt + 1 };
        runtime.activeContext = context;
        const operation = (async () => {
          const validation = await adapter.revalidateTarget(target, context);
          context.validation = validation;
          if (validation.targetError) return { validation, committed: false, skippedTarget: true };
          const writeRequired = !validation.groupExists || validation.servantAdds.length || validation.memberAdds.length;
          if (!writeRequired) return { validation, committed: false, skippedTarget: false };
          state.attemptedOperationKeys = unique([
            ...state.attemptedOperationKeys,
            ...validation.servantAdds.map((userId) => assignmentKey('SERVANT', target.meetingId, target.targetGroupName, userId)),
            ...validation.memberAdds.map((userId) => assignmentKey('MEMBER', target.meetingId, target.targetGroupName, userId)),
          ]);
          context.stage = 'opening_transaction';
          context.session = await adapter.startSession(context);
          context.session.startTransaction({ maxCommitTimeMS: options.operationTimeoutMs });
          context.transactionStarted = true;
          context.stage = 'applying_group';
          await adapter.applyGroup({
            meetingId: target.meetingId,
            groupName: validation.groupName,
            servantUserIds: validation.servantAdds,
            memberUserIds: validation.memberAdds,
          }, context);
          context.stage = 'committing_transaction';
          await context.session.commitTransaction();
          context.transactionStarted = false;
          return { validation, committed: true, skippedTarget: false };
        })();
        try {
          final = await runAbortableWithTimeout({ operation, abort: () => adapter.abortContext(context), timeoutMs: options.operationTimeoutMs });
          final.attempts = attempt + 1;
          break;
        } catch (error) {
          if (error?.globalExecutionError) throw error;
          const transient = isTransientMongoError(error) || error?.errorCode === 'USER_TIMEOUT';
          uncertain = uncertain || context.stage === 'committing_transaction' || isUncertainCommitError(error);
          if (error?.errorCode === 'USER_TIMEOUT') state.timeouts += 1;
          if (transient && attempt < options.operationRetries && !runtime.stopRequested) {
            state.retries += 1;
            const delay = options.operationRetryDelayMs * (2 ** attempt);
            log('RETRY', `[${prefix}] retry ${attempt + 1}/${options.operationRetries} in ${delay}ms: ${error.message}`);
            writer.flushCheckpoint(state);
            await sleep(delay);
            await adapter.reconnect();
            continue;
          }
          if (transient && !runtime.stopRequested) {
            try {
              await adapter.reconnect();
            } catch (reconnectError) {
              throw new GlobalDatabaseUnavailableError('MongoDB could not be recovered after bounded retries', reconnectError);
            }
          }
          const validation = context.validation || { groupName: target.targetGroupName, servantAdds: target.servantUserIds, memberAdds: target.memberUserIds };
          for (const userId of validation.servantAdds || []) writer.upsert(state, baseRecord({ operationKey: assignmentKey('SERVANT', target.meetingId, target.targetGroupName, userId), kind: 'SERVANT', meetingId: target.meetingId, meetingName: target.meetingName, groupName: validation.groupName, userId }, 'FAILED', error?.errorCode === 'USER_TIMEOUT' ? 'FAILED_TIMEOUT' : 'FAILED_SERVICE', error.message, { attempts: attempt + 1 }));
          for (const userId of validation.memberAdds || []) writer.upsert(state, baseRecord({ operationKey: assignmentKey('MEMBER', target.meetingId, target.targetGroupName, userId), kind: 'MEMBER', meetingId: target.meetingId, meetingName: target.meetingName, groupName: validation.groupName, userId }, 'FAILED', error?.errorCode === 'USER_TIMEOUT' ? 'FAILED_TIMEOUT' : 'FAILED_SERVICE', error.message, { attempts: attempt + 1 }));
          final = null;
          break;
        } finally {
          await adapter.closeContext(context);
          runtime.activeContext = null;
        }
      }
      if (final) {
        if (final.validation.targetError) {
          const failedOperation = { operationKey: target.operationKey, kind: 'GROUP', meetingId: target.meetingId, meetingName: target.meetingName, groupName: final.validation.groupName };
          writer.upsert(state, baseRecord(failedOperation, 'FAILED', 'FAILED_REVALIDATION', final.validation.targetError));
        }
        recordTargetOutcome({ state, writer, target, validation: final.validation, committed: final.committed, uncertain, attempts: final.attempts || 1 });
      }
      writer.flushReports(state);
      const totals = summarizeRecords(state);
      if (index === 0 || (index + 1) % 5 === 0 || index + 1 === safePlan.targets.length || totals.failed) {
        log('APPLY', `Processed target ${index + 1}/${safePlan.targets.length} | Groups created=${totals.createdGroups} | Servants added=${totals.servantsAdded} | Members added=${totals.membersAdded} | No-ops=${totals.noOps} | Failed=${totals.failed}`);
      }
    }
    return runtime;
  } finally {
    stopHeartbeat();
    runtime.currentStartedAt = 0;
    writer.flushCheckpoint(state);
    writer.flushReports(state);
  }
}

module.exports = {
  groupKey,
  assignmentKey,
  assertSafeOnlyPreconditions,
  extractSafeOperations,
  existingGroupNames,
  existingMemberGroups,
  existingServantGroups,
  revalidateTargetGroup,
  checkpointChecksum,
  applyReportDirectoryName,
  summarizeRecords,
  summaryMarkdown,
  SafeApplyReportWriter,
  loadSafeCheckpoint,
  assertResumeCheckpoint,
  startHeartbeat,
  applySafeOperations,
};
