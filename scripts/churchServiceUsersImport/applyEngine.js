const { cleanExactName, normalizeArabicComparison } = require('../../src/utils/arabicNormalization');

class UserTimeoutError extends Error {
  constructor(timeoutMs) {
    super(`User operation exceeded ${timeoutMs}ms`);
    this.name = 'UserTimeoutError';
    this.errorCode = 'USER_TIMEOUT';
  }
}

class GlobalDatabaseUnavailableError extends Error {
  constructor(message, cause = null) {
    super(message);
    this.name = 'GlobalDatabaseUnavailableError';
    this.cause = cause;
  }
}

function timestampedLog(stage, message, output = console.log) {
  output(`${new Date().toISOString()} [${stage}] ${message}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTransientMongoError(error) {
  if (!error) return false;
  if (typeof error.hasErrorLabel === 'function' && (error.hasErrorLabel('TransientTransactionError') || error.hasErrorLabel('UnknownTransactionCommitResult'))) return true;
  const labels = error.errorLabels || [];
  if (labels.includes('TransientTransactionError') || labels.includes('UnknownTransactionCommitResult')) return true;
  if ([6, 7, 89, 91, 189, 262, 9001, 10107, 11600, 11602, 13435, 13436].includes(error.code)) return true;
  return /MongoNetworkError|MongoServerSelectionError|MongoNotConnectedError|connection.*(?:closed|reset)|socket.*(?:closed|timeout)|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|not primary|node is recovering/i.test(`${error.name || ''} ${error.message || ''}`);
}

function isValidationError(error) {
  return error?.name === 'ValidationError' || ['VALIDATION_ERROR', 'IMPORT_CREDENTIALS_FORBIDDEN', 'IMPORT_FIELD_FORBIDDEN'].includes(error?.errorCode);
}

function isUncertainCommitError(error) {
  if (!error) return false;
  if (typeof error.hasErrorLabel === 'function' && error.hasErrorLabel('UnknownTransactionCommitResult')) return true;
  return (error.errorLabels || []).includes('UnknownTransactionCommitResult') || /unknown transaction commit result/i.test(error.message || '');
}

async function runAbortableWithTimeout({ operation, abort, timeoutMs }) {
  let timer;
  let timedOut = false;
  const timeoutSignal = new Promise((resolve, reject) => {
    timer = setTimeout(async () => {
      timedOut = true;
      try {
        await abort();
        await operation.catch(() => undefined);
      } finally {
        reject(new UserTimeoutError(timeoutMs));
      }
    }, timeoutMs);
  });
  const guardedOperation = operation.then(
    (value) => (timedOut ? timeoutSignal : value),
    (error) => {
      if (timedOut) return timeoutSignal;
      throw error;
    }
  );
  try {
    return await Promise.race([guardedOperation, timeoutSignal]);
  } finally {
    clearTimeout(timer);
  }
}

class UserIndex {
  constructor(users = []) {
    this.users = new Map();
    this.byExact = new Map();
    this.byNormalized = new Map();
    this.bySourceKey = new Map();
    users.forEach((user) => this.add(user));
  }

  static addTo(map, key, user) {
    if (!key) return;
    if (!map.has(key)) map.set(key, new Map());
    map.get(key).set(String(user._id || user.id), user);
  }

  add(user) {
    const id = String(user?._id || user?.id || '');
    if (!id || this.users.has(id)) return;
    this.users.set(id, user);
    UserIndex.addTo(this.byExact, cleanExactName(user.fullName), user);
    UserIndex.addTo(this.byNormalized, normalizeArabicComparison(user.fullName), user);
    UserIndex.addTo(this.bySourceKey, String(user.customDetails?.importSourceKey || '').trim(), user);
  }

  values(map, key) {
    return [...(map.get(key)?.values() || [])];
  }

  sourceMatches(identity) {
    return this.values(this.bySourceKey, identity.importSourceKey);
  }

  nameResolution(identity) {
    const active = (users) => users.filter((user) => !user.isDeleted);
    const exact = active(this.values(this.byExact, cleanExactName(identity.canonicalFullName)));
    if (exact.length === 1) return { status: 'EXACT_MATCH', user: exact[0] };
    if (exact.length > 1) return { status: 'AMBIGUOUS', users: exact };
    const normalized = active(this.values(this.byNormalized, identity.normalizedName || normalizeArabicComparison(identity.canonicalFullName)));
    if (normalized.length === 1) return { status: 'NORMALIZED_MATCH', user: normalized[0] };
    if (normalized.length > 1) return { status: 'AMBIGUOUS', users: normalized };
    return { status: 'MISSING', users: [] };
  }
}

function baseRecord(identity, status, extra = {}) {
  return {
    stablePersonKey: identity.stablePersonKey,
    importSourceKey: identity.importSourceKey,
    canonicalFullName: identity.canonicalFullName,
    originalSpellings: (identity.originalSpellings || []).join(' | '),
    roles: (identity.roles || []).join(' | '),
    meetings: (identity.meetings || []).join(' | '),
    groups: (identity.groups || []).join(' | '),
    gender: identity.gender || '',
    education: identity.education?.stage || '',
    warnings: (identity.warnings || []).join(' | '),
    databaseUserId: '',
    reason: '',
    attempts: 1,
    ...extra,
    status,
  };
}

function revalidateWithIndex(identity, index, { uncertainCommit = false } = {}) {
  const source = index.sourceMatches(identity);
  const activeSource = source.filter((user) => !user.isDeleted);
  if (source.some((user) => user.isDeleted)) return baseRecord(identity, 'BLOCKED', { reason: 'A soft-deleted user has this import source key' });
  if (activeSource.length > 1) return baseRecord(identity, 'SKIPPED_NEW_AMBIGUITY', { reason: 'Multiple active users have this import source key' });
  if (activeSource.length === 1) {
    const normalized = normalizeArabicComparison(activeSource[0].fullName);
    if (normalized !== identity.normalizedName) return baseRecord(identity, 'BLOCKED', { reason: 'Import source key belongs to a different normalized full name' });
    return baseRecord(identity, uncertainCommit ? 'RECOVERED_AFTER_UNCERTAIN_COMMIT' : 'SKIPPED_ALREADY_IMPORTED', { databaseUserId: String(activeSource[0]._id || activeSource[0].id), reason: uncertainCommit ? 'Expected source key found after an uncertain commit' : 'Import source key already exists' });
  }
  const historicalName = index.nameResolution(identity);
  if (historicalName.status === 'AMBIGUOUS') return baseRecord(identity, 'SKIPPED_NEW_AMBIGUITY', { reason: 'Name matches multiple active users' });
  if (['EXACT_MATCH', 'NORMALIZED_MATCH'].includes(historicalName.status)) return baseRecord(identity, 'REUSED_EXISTING', { databaseUserId: String(historicalName.user._id || historicalName.user.id), reason: `${historicalName.status} found during apply revalidation` });
  const deletedNormalized = [...index.users.values()].filter((user) => user.isDeleted && normalizeArabicComparison(user.fullName) === identity.normalizedName);
  if (deletedNormalized.length) return baseRecord(identity, 'BLOCKED', { reason: 'A soft-deleted user matches this normalized identity' });
  return baseRecord(identity, 'READY_TO_CREATE');
}

function replaceRecord(state, record) {
  const index = state.records.findIndex((entry) => entry.importSourceKey === record.importSourceKey);
  if (index >= 0) state.records[index] = record;
  else state.records.push(record);
  if (!state.processedSourceKeys.includes(record.importSourceKey)) state.processedSourceKeys.push(record.importSourceKey);
}

function progressCounts(records) {
  return {
    created: records.filter((record) => ['CREATED', 'RECOVERED_AFTER_UNCERTAIN_COMMIT'].includes(record.status)).length,
    reused: records.filter((record) => ['REUSED_EXISTING', 'SKIPPED_ALREADY_IMPORTED', 'NO_OP_ALREADY_IMPORTED'].includes(record.status)).length,
    skipped: records.filter((record) => ['SKIPPED_NEW_AMBIGUITY', 'BLOCKED'].includes(record.status)).length,
    failed: records.filter((record) => ['FAILED_TIMEOUT', 'FAILED_VALIDATION', 'FAILED_SERVICE'].includes(record.status)).length,
  };
}

function startHeartbeat({ state, runtime, intervalMs = 15000, log = timestampedLog }) {
  const timer = setInterval(() => {
    const elapsed = runtime.currentStartedAt ? Math.floor((Date.now() - runtime.currentStartedAt) / 1000) : 0;
    log('HEARTBEAT', `Process alive | Processed: ${state.currentIndex}/${state.totalUsers} | Current user elapsed: ${elapsed}s | MongoDB: ${runtime.isConnected() ? 'connected' : 'disconnected'}`);
  }, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  return () => clearInterval(timer);
}

function logProgress(state, currentName, log = timestampedLog) {
  const counts = progressCounts(state.records);
  log('APPLY', `Processed ${state.currentIndex} / ${state.totalUsers} | Created: ${counts.created} | Reused: ${counts.reused} | Skipped: ${counts.skipped} | Failed: ${counts.failed} | Current: ${currentName}`);
}

async function applyUsersResilient({ identities, state, writer, adapter, options, log = timestampedLog }) {
  const runtime = { currentIdentity: null, currentStartedAt: 0, stopRequested: false, activeContext: null, isConnected: adapter.isConnected };
  async function abortActive() {
    runtime.stopRequested = true;
    await adapter.abortActive(runtime.activeContext || {});
    writer.flush(state);
  }
  runtime.abortActive = abortActive;
  if (adapter.setRuntime) adapter.setRuntime(runtime);
  const stopHeartbeat = startHeartbeat({ state, runtime, intervalMs: options.heartbeatMs, log });
  const initialUsers = await adapter.loadUsers();
  let userIndex = new UserIndex(initialUsers);
  log('STARTUP', 'Existing-user index ready');

  try {
    log('APPLY', 'Beginning users-only apply');
    logProgress(state, identities[0]?.canonicalFullName || 'none', log);
    const previousByKey = new Map((state.records || []).map((record) => [record.importSourceKey, record]));
    for (let position = 0; position < identities.length; position += 1) {
      const identity = identities[position];
      const ordinal = position + 1;
      if (runtime.stopRequested) break;
      runtime.currentIdentity = identity;
      runtime.currentStartedAt = Date.now();
      const prefix = `USER ${ordinal}/${identities.length}`;
      log(prefix, `Starting: ${identity.canonicalFullName} | key=${identity.importSourceKey}`);

      const previous = previousByKey.get(identity.importSourceKey);
      if (previous && !['FAILED_TIMEOUT', 'FAILED_VALIDATION', 'FAILED_SERVICE'].includes(previous.status)) {
        const resumeCheck = revalidateWithIndex(identity, userIndex);
        if (resumeCheck.status !== 'READY_TO_CREATE') {
          replaceRecord(state, { ...previous, resumeConfirmed: true, reason: `${previous.reason || ''} | Resume revalidation: ${resumeCheck.status}`.replace(/^ \| /, '') });
          state.currentIndex = ordinal;
          writer.flush(state);
          log(prefix, `Resume confirmed: ${previous.status}`);
          logProgress(state, identity.canonicalFullName, log);
          continue;
        }
      }

      let finalRecord = null;
      for (let attempt = 0; attempt <= options.userRetries; attempt += 1) {
        const context = { identity, stage: 'revalidation', session: null, transactionStarted: false, attempt: attempt + 1 };
        runtime.activeContext = context;
        log(prefix, 'Revalidating duplicate checks');
        const operation = (async () => {
          const probedUsers = await adapter.probeIdentity(identity, context);
          probedUsers.forEach((user) => userIndex.add(user));
          const resolution = revalidateWithIndex(identity, userIndex, { uncertainCommit: attempt > 0 });
          if (resolution.status !== 'READY_TO_CREATE') return resolution;
          context.stage = 'opening_transaction';
          log(prefix, 'Opening transaction');
          context.session = await adapter.startSession(context);
          context.session.startTransaction({ maxCommitTimeMS: Math.max(1000, options.userTimeoutMs) });
          context.transactionStarted = true;
          context.stage = 'creating_user';
          log(prefix, 'Calling user creation service');
          const created = await adapter.createUser(identity, context);
          context.created = created;
          log(prefix, `Created: ${String(created.id || created._id)}`);
          context.stage = 'committing_transaction';
          await context.session.commitTransaction();
          context.transactionStarted = false;
          log(prefix, 'Transaction committed');
          return baseRecord(identity, 'CREATED', { databaseUserId: String(created.id || created._id), reason: 'Created through imported-user domain service', attempts: attempt + 1 });
        })();
        try {
          finalRecord = await runAbortableWithTimeout({ operation, abort: () => adapter.abortActive(context), timeoutMs: options.userTimeoutMs });
          if (finalRecord.status === 'CREATED') userIndex.add({ _id: finalRecord.databaseUserId, fullName: identity.canonicalFullName, customDetails: { importSourceKey: identity.importSourceKey }, isDeleted: false });
          break;
        } catch (error) {
          const timeout = error instanceof UserTimeoutError;
          const transient = timeout || isTransientMongoError(error);
          const uncertain = context.stage === 'committing_transaction' || isUncertainCommitError(error);
          if (timeout) {
            state.timeouts += 1;
            log('WARN', `[${prefix}] Timed out after ${options.userTimeoutMs}ms; transaction/session aborted`);
            replaceRecord(state, baseRecord(identity, 'FAILED_TIMEOUT', { reason: error.message, attempts: attempt + 1 }));
            state.currentIndex = ordinal;
            writer.flush(state);
          }
          if (runtime.stopRequested) {
            finalRecord = baseRecord(identity, timeout ? 'FAILED_TIMEOUT' : 'FAILED_SERVICE', { reason: `Interrupted during ${context.stage}: ${error.message}`, attempts: attempt + 1 });
            break;
          }
          if (error?.errorCode === 'IMPORT_SOURCE_KEY_EXISTS' || error?.code === 11000) {
            await adapter.closeContext(context);
            userIndex = new UserIndex(await adapter.loadUsers());
            const concurrentResult = revalidateWithIndex(identity, userIndex, { uncertainCommit: true });
            finalRecord = concurrentResult.status === 'READY_TO_CREATE'
              ? baseRecord(identity, 'FAILED_SERVICE', { reason: `Duplicate constraint failed without a recoverable identity: ${error.message}`, attempts: attempt + 1 })
              : { ...concurrentResult, attempts: attempt + 1 };
            break;
          }
          if (transient) {
            if (attempt < options.userRetries) {
              state.retries += 1;
              const delay = options.userRetryDelayMs * (2 ** attempt);
              log('RETRY', `[${prefix}] Transient failure; retry ${attempt + 1}/${options.userRetries} in ${delay}ms: ${error.message}`);
              writer.flush(state);
              await sleep(delay);
              await adapter.reconnect();
              userIndex = new UserIndex(await adapter.loadUsers());
              const recovered = revalidateWithIndex(identity, userIndex, { uncertainCommit: uncertain || timeout });
              if (recovered.status === 'RECOVERED_AFTER_UNCERTAIN_COMMIT') { finalRecord = { ...recovered, attempts: attempt + 1 }; break; }
              continue;
            }
            try {
              await adapter.reconnect();
              userIndex = new UserIndex(await adapter.loadUsers());
              const recovered = revalidateWithIndex(identity, userIndex, { uncertainCommit: uncertain || timeout });
              if (recovered.status === 'RECOVERED_AFTER_UNCERTAIN_COMMIT') { finalRecord = { ...recovered, attempts: attempt + 1 }; break; }
            } catch (reconnectError) {
              throw new GlobalDatabaseUnavailableError('MongoDB could not be recovered after bounded retries', reconnectError);
            }
            finalRecord = baseRecord(identity, timeout ? 'FAILED_TIMEOUT' : 'FAILED_SERVICE', { reason: error.message, attempts: attempt + 1 });
            break;
          }
          finalRecord = baseRecord(identity, isValidationError(error) ? 'FAILED_VALIDATION' : 'FAILED_SERVICE', { reason: error.message, attempts: attempt + 1 });
          break;
        } finally {
          await adapter.closeContext(context);
          runtime.activeContext = null;
        }
      }

      replaceRecord(state, finalRecord || baseRecord(identity, 'FAILED_SERVICE', { reason: 'No operation result was produced' }));
      if (['CREATED', 'RECOVERED_AFTER_UNCERTAIN_COMMIT'].includes(finalRecord?.status)) state.lastSuccessfullyCommittedSourceKey = identity.importSourceKey;
      state.currentIndex = ordinal;
      writer.flush(state);
      const alwaysLog = !['CREATED'].includes(finalRecord?.status);
      if (alwaysLog || ordinal === 1 || ordinal % 10 === 0 || ordinal % 100 === 0 || ordinal === identities.length) logProgress(state, identity.canonicalFullName, log);
    }
    return { state, runtime };
  } finally {
    stopHeartbeat();
    runtime.currentIdentity = null;
    runtime.currentStartedAt = 0;
    writer.flush(state);
  }
}

module.exports = {
  UserTimeoutError,
  GlobalDatabaseUnavailableError,
  timestampedLog,
  sleep,
  isTransientMongoError,
  isValidationError,
  isUncertainCommitError,
  runAbortableWithTimeout,
  UserIndex,
  baseRecord,
  revalidateWithIndex,
  replaceRecord,
  progressCounts,
  startHeartbeat,
  logProgress,
  applyUsersResilient,
};
