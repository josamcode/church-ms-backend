#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const config = require('../src/config/env');
const User = require('../src/modules/users/user.model');
const Meeting = require('../src/modules/meetings/meeting.model');
const { parseWorkbook } = require('./churchServiceImport/workbook');
const { sha256File, assertPlanChecksum } = require('./churchServiceImport/integrity');
const { databaseFingerprint } = require('./churchServiceResolution/workbookSupport');
const { buildWorkbookData } = require('./churchServiceResolution/workbookData');
const { reportDirectoryName, generateResolutionWorkbook } = require('./churchServiceResolution/workbookGenerator');
const { buildHigherLevelPlan, writeHigherLevelReports } = require('./churchServiceResolution/higherLevelReports');
const { annotateCandidateRows } = require('./churchServiceResolution/aiAmbiguityExplainer');

const DEFAULT_INPUT = path.resolve(__dirname, '..', '..', 'بيانات الخدمة الكنسيه.xlsx');
const DEFAULT_REPORT = path.resolve(__dirname, '..', 'reports', 'church-service-blocker-resolution-20260719-052801', 'plan.json');
const REPORTS_ROOT = path.resolve(__dirname, '..', 'reports');

function parseArgs(argv) {
  // `aiExplain` defaults to false: without the flag this script behaves
  // exactly as it did before, and no data is sent anywhere.
  const options = { input: DEFAULT_INPUT, blockerReport: DEFAULT_REPORT, aiExplain: false, aiMaxRows: 200 };
  for (const token of argv) {
    if (token.startsWith('--input=')) options.input = path.resolve(token.slice(8).replace(/^"|"$/g, ''));
    else if (token.startsWith('--blocker-report=')) options.blockerReport = path.resolve(token.slice(17).replace(/^"|"$/g, ''));
    else if (token === '--ai-explain') options.aiExplain = true;
    else if (token.startsWith('--ai-max-rows=')) options.aiMaxRows = Math.max(Number(token.slice(14)) || 0, 0);
    else throw new Error(`Unknown argument: ${token}`);
  }
  return options;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const resolutionPlan = JSON.parse(fs.readFileSync(options.blockerReport, 'utf8'));
  assertPlanChecksum(resolutionPlan, resolutionPlan.planChecksum);
  if (sha256File(options.input) !== resolutionPlan.input.sha256) throw new Error('Source Excel hash differs from blocker report');
  const sourceAssignmentPlan = JSON.parse(fs.readFileSync(resolutionPlan.sourcePlan.path, 'utf8'));
  assertPlanChecksum(sourceAssignmentPlan, sourceAssignmentPlan.planChecksum);
  const parsed = await parseWorkbook(options.input);
  await mongoose.connect(config.mongo.uri, { autoIndex: false, autoCreate: false });
  const [users, meetings] = await Promise.all([
    User.find({}).setOptions({ includeDeleted: true }).select('_id fullName gender birthDate nationalId phonePrimary whatsappNumber familyName houseName education father mother spouse siblings children familyMembers meetingIds meetingAttendance divineLiturgyAttendance confessionFatherName confessionFatherUserId confessionSessionIds hasLogin accountStatus isLocked isDeleted customDetails createdAt updatedAt changeLog role').lean(),
    Meeting.find({ isDeleted: { $ne: true } }).select('_id name groups groupAssignments servants servedUserIds attendanceRecords memberNotes').lean(),
  ]);
  const fingerprint = databaseFingerprint({ databaseName: mongoose.connection.name, host: mongoose.connection.host, port: mongoose.connection.port });
  const data = buildWorkbookData({ resolutionPlan, sourceAssignmentPlan, parsedRows: parsed.rows, users, meetings });

  // Advisory ambiguity explanations. Opt-in, best-effort, and excluded from the
  // generated-fields hash — a failure here leaves the columns empty and the
  // workbook otherwise identical.
  await annotateCandidateRows(data.candidateRows, {
    enabled: options.aiExplain,
    maxRows: options.aiMaxRows,
  });

  const generatedAt = new Date();
  const reportDir = path.join(REPORTS_ROOT, reportDirectoryName(generatedAt));
  const outputPath = path.join(reportDir, 'church-service-manual-resolution.xlsx');
  const higherLevelPlan = buildHigherLevelPlan({ data, resolutionPlan, sourceAssignmentPlan, sourceBlockerReportPath: options.blockerReport, databaseName: mongoose.connection.name, databaseFingerprint: fingerprint, generatedAt: generatedAt.toISOString() });
  const reportOutput = writeHigherLevelReports(higherLevelPlan, reportDir);
  const output = await generateResolutionWorkbook({
    data,
    metadata: {
      generatedAt: generatedAt.toISOString(), sourceResolutionPlanPath: options.blockerReport, sourceResolutionPlanChecksum: resolutionPlan.planChecksum,
      sourceAssignmentPlanPath: resolutionPlan.sourcePlan.path, sourceAssignmentPlanChecksum: sourceAssignmentPlan.planChecksum,
      sourceExcelPath: options.input, sourceExcelHash: resolutionPlan.input.sha256, databaseName: mongoose.connection.name, databaseFingerprint: fingerprint,
      domainAllowsMultipleGroupsInMeeting: 'NO', higherLevelAuditPlanPath: reportOutput.planPath, higherLevelAuditPlanChecksum: reportOutput.checksum,
    },
    outputPath,
  });
  console.log(`[REVIEW] workbook=${output.outputPath}`);
  console.log(`[REVIEW] sheets=${output.sheets.join(', ')}`);
  console.log(`[REVIEW] aliases=${data.aliasRows.length} duplicateUsers=${data.duplicateRows.length} identities=${data.identityRows.length} candidates=${data.candidateRows.length} groupConflicts=${data.groupRows.length} servantConflicts=${data.servantRows.length}`);
  console.log(`[REVIEW] likelyDuplicates=${higherLevelPlan.totals.likelyDuplicateDatabaseIdentities} distinct=${higherLevelPlan.totals.distinctPeople} insufficient=${higherLevelPlan.totals.insufficientEvidence} dataConflicts=${higherLevelPlan.totals.dataConflicts}`);
  console.log(`[REVIEW] generatedFieldsHash=${output.metadata.generatedFieldsHash}`);
}

// CLI guard: run `main()` only when this file is executed directly, never when
// it is `require`d (a test importing it for `parseArgs`, or another script
// reusing it). Without this guard, importing the module fired the full CLI —
// connecting to Mongo and reading a default `plan.json` that does not exist in
// a test run — emitting an ENOENT to stderr at import time.
if (require.main === module) {
  main()
    .catch((error) => {
      console.error(`Resolution workbook generation failed: ${error.message}`);
      process.exitCode = 1;
    })
    .finally(async () => mongoose.disconnect());
}

module.exports = { parseArgs, main };
