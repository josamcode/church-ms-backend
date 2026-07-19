const crypto = require('crypto');
const fs = require('fs');

function sha256Buffer(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function sha256File(filePath) {
  return sha256Buffer(fs.readFileSync(filePath));
}

function canonicalize(value) {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

function calculatePlanChecksum(plan) {
  return sha256Buffer(Buffer.from(JSON.stringify(canonicalize({ ...plan, planChecksum: null })), 'utf8'));
}

function assertPlanChecksum(plan, suppliedChecksum) {
  const actual = calculatePlanChecksum(plan);
  if (!plan?.planChecksum || plan.planChecksum !== actual) {
    throw new Error('Plan checksum stored in plan.json is invalid');
  }
  if (!suppliedChecksum || suppliedChecksum !== actual) {
    throw new Error('Confirmation checksum does not match plan checksum');
  }
  return actual;
}

function assertApplyPreconditions({ plan, suppliedChecksum, currentInputHash, currentDatabaseName }) {
  assertPlanChecksum(plan, suppliedChecksum);
  if (!plan.safeToApply || (plan.blockingErrors || []).length) throw new Error('Apply is blocked because the plan contains blocking errors');
  if (plan.input?.sha256 !== currentInputHash) throw new Error('Input workbook checksum mismatch');
  if (plan.database?.name !== currentDatabaseName) throw new Error('Database target mismatch');
}

function assertResolutionApplyPreconditions({ plan, currentResolutionWorkbookHash, currentDatabaseFingerprint }) {
  if (!plan.resolutionWorkbook) return true;
  if (!currentResolutionWorkbookHash || currentResolutionWorkbookHash !== plan.resolutionWorkbook.sha256) throw new Error('Resolution workbook checksum mismatch');
  if (!currentDatabaseFingerprint || currentDatabaseFingerprint !== plan.databaseFingerprint) throw new Error('Database target fingerprint mismatch');
  if (!plan.safeForFullApply || !plan.safeToApply) throw new Error('Resolution-aware plan is not safe for full apply');
  return true;
}

module.exports = { sha256File, calculatePlanChecksum, assertPlanChecksum, assertApplyPreconditions, assertResolutionApplyPreconditions };
