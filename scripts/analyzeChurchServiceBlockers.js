#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const config = require('../src/config/env');
const User = require('../src/modules/users/user.model');
const Meeting = require('../src/modules/meetings/meeting.model');
const { parseWorkbook } = require('./churchServiceImport/workbook');
const { assertPlanChecksum, sha256File } = require('./churchServiceImport/integrity');
const { buildResolutionAnalysis } = require('./churchServiceResolution/analyzer');
const { writeResolutionReports } = require('./churchServiceResolution/reports');
const { loadIdentityMappings, validateIdentityMappings } = require('./churchServiceResolution/identityMappings');

const DEFAULT_INPUT = path.resolve(__dirname, '..', '..', 'بيانات الخدمة الكنسيه.xlsx');
const DEFAULT_PLAN = path.resolve(__dirname, '..', 'reports', 'church-service-import-preflight-20260719-050538', 'plan.json');
const REPORTS_ROOT = path.resolve(__dirname, '..', 'reports');

function parseArgs(argv) {
  const options = { input: DEFAULT_INPUT, sourcePlan: DEFAULT_PLAN, priorUsersPlan: '', identityMappingFile: '' };
  for (const token of argv) {
    if (token === '--dry-run') continue;
    if (token.startsWith('--input=')) options.input = path.resolve(token.slice(8).replace(/^"|"$/g, ''));
    else if (token.startsWith('--source-plan=')) options.sourcePlan = path.resolve(token.slice(14).replace(/^"|"$/g, ''));
    else if (token.startsWith('--prior-users-plan=')) options.priorUsersPlan = path.resolve(token.slice(19).replace(/^"|"$/g, ''));
    else if (token.startsWith('--identity-mapping-file=')) options.identityMappingFile = path.resolve(token.slice(24).replace(/^"|"$/g, ''));
    else throw new Error(`Unknown argument: ${token}`);
  }
  return options;
}

function newestUsersPlan() {
  return fs.readdirSync(REPORTS_ROOT)
    .filter((name) => name.startsWith('church-service-users-preflight-'))
    .sort().reverse().map((name) => path.join(REPORTS_ROOT, name, 'plan.json'))
    .find((file) => fs.existsSync(file)) || '';
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  console.log('[READ-ONLY] Loading and verifying source assignment plan');
  const sourcePlan = JSON.parse(fs.readFileSync(options.sourcePlan, 'utf8'));
  assertPlanChecksum(sourcePlan, sourcePlan.planChecksum);
  if (sha256File(options.input) !== sourcePlan.input.sha256) throw new Error('Input workbook hash differs from the source preflight plan');
  const parsed = await parseWorkbook(options.input);
  console.log('[READ-ONLY] Connecting to MongoDB');
  await mongoose.connect(config.mongo.uri, { autoIndex: false, autoCreate: false });
  const databaseName = mongoose.connection.name;
  if (databaseName !== sourcePlan.database.name) throw new Error('Database target differs from the source preflight plan');
  console.log('[READ-ONLY] Loading user and meeting evidence');
  const [users, meetings] = await Promise.all([
    User.find({}).setOptions({ includeDeleted: true }).select('_id fullName gender birthDate ageGroup education meetingIds familyName houseName customDetails isDeleted accountStatus role').lean(),
    Meeting.find({ isDeleted: { $ne: true } }).select('_id name groups groupAssignments servants servedUserIds').lean(),
  ]);
  const priorPath = options.priorUsersPlan || newestUsersPlan();
  const priorUsersPlan = priorPath ? JSON.parse(fs.readFileSync(priorPath, 'utf8')) : null;
  if (options.identityMappingFile) {
    const validation = validateIdentityMappings(loadIdentityMappings(options.identityMappingFile), sourcePlan.peopleMatches, users);
    if (!validation.valid) throw new Error(`Identity mapping validation failed:\n- ${validation.errors.join('\n- ')}`);
    console.log(`[READ-ONLY] Manual mapping file validated (${validation.approved.length} approvals); mappings were not applied`);
  }
  const analysis = buildResolutionAnalysis({ sourcePlan, rows: parsed.rows, users, meetings, priorUsersPlan, databaseName, generatedAt: new Date().toISOString() });
  analysis.input.path = options.input;
  analysis.sourcePlan.path = options.sourcePlan;
  analysis.priorUsersPlan = priorPath;
  const output = writeResolutionReports(analysis, REPORTS_ROOT);
  const r = analysis.assignmentReconciliation;
  console.log(`[RESULT] blockers=${analysis.totals.blockers} missing=${analysis.totals.missingPeople} ambiguous=${analysis.totals.ambiguousPeople}`);
  console.log(`[RESULT] servants safe=${r.servantSafeAdds} blocked=${r.servantBlocked} no-op=${r.servantNoOps}`);
  console.log(`[RESULT] members safe=${r.memberSafeAdds} blocked=${r.memberBlocked} no-op=${r.memberNoOps}`);
  console.log(`[RESULT] safeOperationsAvailable=${analysis.safeOperationsAvailable ? 'YES' : 'NO'} safeForFullApply=${analysis.safeForFullApply ? 'YES' : 'NO'}`);
  console.log(`[RESULT] report=${output.reportDir}`);
  console.log(`[RESULT] checksum=${output.checksum}`);
}

main().catch((error) => {
  console.error(`Blocker analysis failed: ${error.message}`);
  process.exitCode = 1;
}).finally(async () => {
  await mongoose.disconnect();
});

module.exports = { parseArgs };
