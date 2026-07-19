const fs = require('fs');
const path = require('path');
const { writeCsv } = require('../churchServiceImport/reports');
const { calculatePlanChecksum } = require('../churchServiceImport/integrity');

function buildHigherLevelPlan({ data, resolutionPlan, sourceAssignmentPlan, sourceBlockerReportPath = '', databaseName, databaseFingerprint, generatedAt }) {
  const likely = data.duplicateRows.filter((row) => row.classification === 'LIKELY_DUPLICATE_DATABASE_RECORDS').length;
  const distinct = data.duplicateRows.filter((row) => row.classification === 'DISTINCT_PEOPLE').length;
  const insufficient = data.duplicateRows.filter((row) => row.classification === 'INSUFFICIENT_EVIDENCE').length;
  const conflicts = data.duplicateRows.filter((row) => row.classification === 'DATA_CONFLICT').length;
  const recommendedAliases = data.aliasRows.filter((row) => row.recommendedDecision === 'SAME_GROUP_ALIAS');
  const plan = {
    schemaVersion: 1, mode: 'READ_ONLY_HIGHER_LEVEL_RESOLUTION_AUDIT', generatedAt,
    input: resolutionPlan.input, database: { name: databaseName, fingerprint: databaseFingerprint },
    sourceBlockerResolution: { path: sourceBlockerReportPath, checksum: resolutionPlan.planChecksum }, sourceAssignmentPlanChecksum: sourceAssignmentPlan.planChecksum,
    groupAliasAnalysis: data.aliasRows, duplicateUserAnalysis: data.duplicateRows, duplicateUserDetail: data.duplicateDetailRows,
    remainingIdentityReview: data.identityRows, remainingGroupConflicts: data.groupRows, servantConflicts: data.servantRows,
    databaseDuplicateCleanupReview: data.duplicateCleanupRows,
    totals: {
      originalManualDecisions: 96, uniqueGroupAliasDecisions: data.aliasRows.length,
      personConflictsPotentiallyRemovableByAnyAlias: data.groupRows.length,
      personConflictsWithPositiveAliasRecommendation: recommendedAliases.reduce((sum, row) => sum + Number(row.affectedPeopleCount), 0),
      ambiguousIdentitiesAudited: data.duplicateRows.length, likelyDuplicateDatabaseIdentities: likely, distinctPeople: distinct, insufficientEvidence: insufficient, dataConflicts: conflicts,
      remainingPotentialHomonyms: data.identityRows.filter((row) => row.currentStatus === 'POTENTIAL_HOMONYM').length,
      remainingInvalidNames: data.identityRows.filter((row) => row.currentStatus === 'INVALID_NAME').length,
      remainingPersonGroupConflictsBeforeAliasApproval: data.groupRows.length, remainingServantConflicts: data.servantRows.length,
      expectedManualDecisionsAfterRestructuring: data.aliasRows.length + data.duplicateRows.length + data.identityRows.length + data.groupRows.length + data.servantRows.length,
    },
    manualApprovals: [], databaseMutations: [], safeForFullApply: false, planChecksum: null,
  };
  plan.planChecksum = calculatePlanChecksum(plan);
  return plan;
}

function summary(plan) {
  const t = plan.totals;
  return [
    '# Church-service higher-level manual-resolution audit', '',
    `- Generated: ${plan.generatedAt}`,
    `- Database: \`${plan.database.name}\``,
    `- Database fingerprint: \`${plan.database.fingerprint}\``,
    `- Source Excel SHA-256: \`${plan.input.sha256}\``,
    `- Plan checksum: \`${plan.planChecksum}\``, '',
    '| Metric | Count |', '|---|---:|',
    `| Original manual decisions | ${t.originalManualDecisions} |`,
    `| Unique group-alias decisions | ${t.uniqueGroupAliasDecisions} |`,
    `| Person conflicts governed by alias pairs | ${t.personConflictsPotentiallyRemovableByAnyAlias} |`,
    `| Person conflicts with positive alias recommendation | ${t.personConflictsWithPositiveAliasRecommendation} |`,
    `| Ambiguous identities audited | ${t.ambiguousIdentitiesAudited} |`,
    `| Likely duplicate database identities | ${t.likelyDuplicateDatabaseIdentities} |`,
    `| Distinct-person ambiguities | ${t.distinctPeople} |`,
    `| Insufficient-evidence ambiguities | ${t.insufficientEvidence} |`,
    `| Data-conflict ambiguities | ${t.dataConflicts} |`,
    `| Remaining potential homonyms | ${t.remainingPotentialHomonyms} |`,
    `| Remaining invalid names | ${t.remainingInvalidNames} |`,
    `| Remaining person/group conflicts before alias approval | ${t.remainingPersonGroupConflictsBeforeAliasApproval} |`,
    `| Remaining servant conflicts | ${t.remainingServantConflicts} |`,
    `| Expected blank decisions after restructuring | ${t.expectedManualDecisionsAfterRestructuring} |`, '',
    'Recommendations are not approvals. No user records were merged, deleted, or updated, and no church-service relationships were changed.', '',
  ].join('\n');
}

function writeHigherLevelReports(plan, reportDir) {
  fs.mkdirSync(reportDir, { recursive: true });
  fs.writeFileSync(path.join(reportDir, 'plan.json'), `${JSON.stringify(plan, null, 2)}\n`, 'utf8');
  fs.writeFileSync(path.join(reportDir, 'summary.md'), summary(plan), 'utf8');
  writeCsv(path.join(reportDir, 'group-alias-analysis.csv'), Object.keys(plan.groupAliasAnalysis[0] || {}), plan.groupAliasAnalysis);
  writeCsv(path.join(reportDir, 'duplicate-user-analysis.csv'), Object.keys(plan.duplicateUserAnalysis[0] || {}), plan.duplicateUserAnalysis);
  writeCsv(path.join(reportDir, 'duplicate-user-detail.csv'), Object.keys(plan.duplicateUserDetail[0] || {}), plan.duplicateUserDetail);
  writeCsv(path.join(reportDir, 'remaining-identity-review.csv'), Object.keys(plan.remainingIdentityReview[0] || {}), plan.remainingIdentityReview);
  writeCsv(path.join(reportDir, 'remaining-group-conflicts.csv'), Object.keys(plan.remainingGroupConflicts[0] || {}), plan.remainingGroupConflicts);
  writeCsv(path.join(reportDir, 'servant-conflicts.csv'), Object.keys(plan.servantConflicts[0] || {}), plan.servantConflicts);
  writeCsv(path.join(reportDir, 'database-duplicate-cleanup-review.csv'), Object.keys(plan.databaseDuplicateCleanupReview[0] || { duplicateReviewKey: '', sourceName: '', canonicalCandidateId: '', duplicateCandidateId: '', fieldsUniqueToCanonical: '', fieldsUniqueToDuplicate: '', relationshipsOwnedByEach: '', meetingGroupAssignments: '', attendance: '', loginImplications: '', safeMergeRequirements: '', manualReviewNotes: '' }), plan.databaseDuplicateCleanupReview);
  return { reportDir, planPath: path.join(reportDir, 'plan.json'), checksum: plan.planChecksum };
}

module.exports = { buildHigherLevelPlan, writeHigherLevelReports };
