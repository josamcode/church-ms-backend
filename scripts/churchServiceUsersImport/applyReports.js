const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { csvCell } = require('../churchServiceImport/reports');

function timestampName(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return `church-service-users-apply-${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  return value;
}

function checkpointChecksum(checkpoint) {
  return crypto.createHash('sha256').update(JSON.stringify(canonicalize({ ...checkpoint, checkpointChecksum: null }))).digest('hex');
}

function atomicWriteFile(filePath, content) {
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

function atomicWriteJson(filePath, value) {
  atomicWriteFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function csvText(headers, rows) {
  const output = [headers.map(csvCell).join(','), ...rows.map((row) => headers.map((header) => csvCell(row[header])).join(','))].join('\r\n');
  return `\uFEFF${output}\r\n`;
}

function classifyRecords(records) {
  return {
    created: records.filter((record) => ['CREATED', 'RECOVERED_AFTER_UNCERTAIN_COMMIT'].includes(record.status)),
    failed: records.filter((record) => ['FAILED_TIMEOUT', 'FAILED_VALIDATION', 'FAILED_SERVICE'].includes(record.status)),
    skipped: records.filter((record) => !['CREATED', 'RECOVERED_AFTER_UNCERTAIN_COMMIT', 'FAILED_TIMEOUT', 'FAILED_VALIDATION', 'FAILED_SERVICE'].includes(record.status)),
  };
}

function summaryMarkdown(state, partial) {
  const groups = classifyRecords(state.records || []);
  const count = (status) => (state.records || []).filter((record) => record.status === status).length;
  return [
    `# Church service users-only apply ${partial ? 'partial checkpoint' : 'result'}`, '',
    `- Status: ${state.status}`,
    `- Database: \`${state.databaseName}\``,
    `- Source Excel SHA-256: \`${state.inputHash}\``,
    `- Plan checksum: \`${state.planChecksum}\``,
    `- Planned safe users: ${state.totalUsers}`,
    `- Processed users: ${state.processedSourceKeys?.length || 0}`,
    `- Created users: ${count('CREATED')}`,
    `- Recovered after uncertain commit: ${count('RECOVERED_AFTER_UNCERTAIN_COMMIT')}`,
    `- Reused users: ${count('REUSED_EXISTING')}`,
    `- Already imported users: ${count('SKIPPED_ALREADY_IMPORTED') + count('NO_OP_ALREADY_IMPORTED')}`,
    `- Newly ambiguous users: ${count('SKIPPED_NEW_AMBIGUITY')}`,
    `- Timed out users: ${count('FAILED_TIMEOUT')}`,
    `- Other failed users: ${groups.failed.length - count('FAILED_TIMEOUT')}`,
    `- Blocked/skipped users: ${groups.skipped.length}`,
    `- Retry attempts: ${state.retries || 0}`,
    `- Timeouts: ${state.timeouts || 0}`,
    '- Family relationships changed: NO',
    '- Meeting/group assignments changed: NO',
    `- Started: ${state.startedAt}`,
    `- Updated: ${state.updatedAt}`,
    `- Finished: ${state.finishedAt || 'not finished'}`, '',
  ].join('\n');
}

const CREATED_HEADERS = ['Stable source key', 'Import source key', 'Canonical full name', 'Created database ID', 'Original Excel spellings', 'Roles', 'Meetings', 'Groups', 'Gender', 'Education', 'Has login', 'Account status', 'Service result', 'Warnings'];
const SKIPPED_HEADERS = ['Stable source key', 'Import source key', 'Canonical full name', 'Status', 'Existing database ID', 'Reason', 'Warnings'];
const FAILED_HEADERS = ['Stable source key', 'Import source key', 'Canonical full name', 'Status', 'Attempts', 'Reason', 'Warnings'];

function createdRow(record) {
  return {
    'Stable source key': record.stablePersonKey,
    'Import source key': record.importSourceKey,
    'Canonical full name': record.canonicalFullName,
    'Created database ID': record.databaseUserId,
    'Original Excel spellings': record.originalSpellings,
    Roles: record.roles,
    Meetings: record.meetings,
    Groups: record.groups,
    Gender: record.gender || '',
    Education: record.education || '',
    'Has login': false,
    'Account status': 'approved',
    'Service result': record.status,
    Warnings: record.warnings,
  };
}

class ApplyReportWriter {
  constructor({ reportsRoot, state, resumeFrom = '' }) {
    this.reportDir = resumeFrom ? path.dirname(resumeFrom) : path.join(reportsRoot, timestampName(new Date(state.startedAt)));
    fs.mkdirSync(this.reportDir, { recursive: true });
    this.checkpointPath = path.join(this.reportDir, 'checkpoint.json');
    this.flush(state);
  }

  flush(state) {
    state.updatedAt = new Date().toISOString();
    const groups = classifyRecords(state.records || []);
    const checkpoint = {
      ...state,
      processedSourceKeys: [...new Set(state.processedSourceKeys || [])],
      createdUserIds: groups.created.map((record) => ({ sourceKey: record.importSourceKey, userId: record.databaseUserId, status: record.status })),
      reusedUsers: groups.skipped.filter((record) => ['REUSED_EXISTING', 'SKIPPED_ALREADY_IMPORTED', 'NO_OP_ALREADY_IMPORTED'].includes(record.status)),
      skippedUsers: groups.skipped,
      failedUsers: groups.failed,
      checkpointChecksum: null,
    };
    checkpoint.checkpointChecksum = checkpointChecksum(checkpoint);
    atomicWriteJson(this.checkpointPath, checkpoint);
    atomicWriteFile(path.join(this.reportDir, 'created-users.csv'), csvText(CREATED_HEADERS, groups.created.map(createdRow)));
    atomicWriteFile(path.join(this.reportDir, 'skipped-users.csv'), csvText(SKIPPED_HEADERS, groups.skipped.map((record) => ({ 'Stable source key': record.stablePersonKey, 'Import source key': record.importSourceKey, 'Canonical full name': record.canonicalFullName, Status: record.status, 'Existing database ID': record.databaseUserId || '', Reason: record.reason, Warnings: record.warnings }))));
    atomicWriteFile(path.join(this.reportDir, 'failed-users.csv'), csvText(FAILED_HEADERS, groups.failed.map((record) => ({ 'Stable source key': record.stablePersonKey, 'Import source key': record.importSourceKey, 'Canonical full name': record.canonicalFullName, Status: record.status, Attempts: record.attempts || 1, Reason: record.reason, Warnings: record.warnings }))));
    atomicWriteFile(path.join(this.reportDir, 'summary.partial.md'), summaryMarkdown(state, true));
    return checkpoint;
  }

  finalize(state) {
    const checkpoint = this.flush(state);
    atomicWriteFile(path.join(this.reportDir, 'summary.md'), summaryMarkdown(state, false));
    atomicWriteJson(path.join(this.reportDir, 'apply-result.json'), state);
    return { reportDir: this.reportDir, checkpointPath: this.checkpointPath, checkpoint };
  }
}

function loadCheckpoint(checkpointPath) {
  const checkpoint = JSON.parse(fs.readFileSync(checkpointPath, 'utf8'));
  const actual = checkpointChecksum(checkpoint);
  if (!checkpoint.checkpointChecksum || checkpoint.checkpointChecksum !== actual) throw new Error('Checkpoint checksum is invalid');
  return checkpoint;
}

function writeUsersOnlyApplyReports(result, reportsRoot) {
  const writer = new ApplyReportWriter({ reportsRoot, state: result });
  return writer.finalize(result);
}

module.exports = { timestampName, checkpointChecksum, atomicWriteFile, atomicWriteJson, csvText, summaryMarkdown, ApplyReportWriter, loadCheckpoint, writeUsersOnlyApplyReports };
