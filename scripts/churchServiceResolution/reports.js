const fs = require('fs');
const path = require('path');
const { writeCsv } = require('../churchServiceImport/reports');
const { calculatePlanChecksum } = require('../churchServiceImport/integrity');

function stamp(date) {
  const pad = (value) => String(value).padStart(2, '0');
  return `church-service-blocker-resolution-${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

const join = (value) => Array.isArray(value) ? value.join(' | ') : value;

function summary(plan) {
  const r = plan.assignmentReconciliation;
  const t = plan.totals;
  const lines = [
    '# Church service blocker-resolution report', '',
    `- Generated: ${plan.generatedAt}`,
    `- Database: \`${plan.database.name}\``,
    `- Input: \`${plan.input.path}\``,
    `- Input SHA-256: \`${plan.input.sha256}\``,
    `- Source assignment plan checksum: \`${plan.sourcePlan.checksum}\``,
    `- Resolution plan checksum: \`${plan.planChecksum}\``, '',
    `**Safe operations available: ${plan.safeOperationsAvailable ? 'YES' : 'NO'}**`,
    `**Safe for full apply: ${plan.safeForFullApply ? 'YES' : 'NO'}**`, '',
    '## Blocking errors (warnings excluded)', '',
    '| Type | Count |', '|---|---:|',
    ...plan.blockerBreakdown.filter((entry) => entry.count).map((entry) => `| ${entry.type} | ${entry.count} |`),
    `| **Total** | **${t.blockers}** |`, '',
    '## Identity review', '',
    `- Missing source spellings: ${t.missingPeople}`,
    `- Potential-homonym/manual-split spellings: ${t.potentialHomonyms}`,
    `- Invalid names: ${t.invalidNames}`,
    `- Ambiguous source spellings: ${t.ambiguousPeople}`,
    `- Deterministically recommendable ambiguities: ${t.automaticallyResolvableAmbiguous}`,
    `- Ambiguities requiring manual mapping: ${t.manualAmbiguous}`, '',
    'No identity is approved by this report. The editable approval columns in `manual-church-service-identity-mapping.csv` are intentionally empty.', '',
    '## Operation-level assignment reconciliation', '',
    '| Metric | Count |', '|---|---:|',
    `| Original plan servant adds (whole blocked groups zeroed) | ${r.originalPlanServantAdds} |`,
    `| Original plan member adds (whole blocked groups zeroed) | ${r.originalPlanMemberAdds} |`,
    `| Servant source cell occurrences | ${r.servantSourceOccurrences} |`,
    `| Servant unresolved occurrences | ${r.servantUnresolvedOccurrences} |`,
    `| Unique unresolved group/servant assignments | ${r.servantUnresolvedUniqueAssignments} |`,
    `| Unique resolved group/servant assignments | ${r.servantResolvedUniqueAssignments} |`,
    `| Repeated resolved servant occurrences collapsed | ${r.servantRepeatedOccurrences} |`,
    `| Safe servant adds | ${r.servantSafeAdds} |`,
    `| Existing servant no-ops | ${r.servantNoOps} |`,
    `| Blocked resolved servant assignments | ${r.servantBlocked} |`,
    `| Total blocked servant assignments | ${r.servantBlockedAssignments} |`,
    `| Member source rows | ${r.memberSourceRows} |`,
    `| Member unresolved rows | ${r.memberUnresolvedRows} |`,
    `| Unique unresolved group/member assignments | ${r.memberUnresolvedUniqueAssignments} |`,
    `| Unique resolved group/member assignments | ${r.memberResolvedUniqueAssignments} |`,
    `| Duplicate resolved member rows collapsed | ${r.memberDuplicateRows} |`,
    `| Safe member adds | ${r.memberSafeAdds} |`,
    `| Existing member no-ops | ${r.memberNoOps} |`,
    `| Blocked resolved member assignments | ${r.memberBlocked} |`,
    `| Total blocked member assignments | ${r.memberBlockedAssignments} |`,
    `| Resolved people in multiple Excel groups in one meeting | ${r.multipleExcelGroupUsers} |`, '',
    'The previous plan reported 137 servant and 1,773 member writes because it zeroed all writes for any group containing a blocker. This report keeps safe/no-op/blocked decisions at assignment level; it does not authorize a partial apply.', '',
    '## Groups', '',
    `- Safe group creates: ${t.safeGroupsToCreate}`,
    `- Safe existing group reuses: ${t.safeGroupsToReuse}`,
    `- Groups with blocked servant operations: ${t.groupsBlockedServants}`,
    `- Groups with blocked member operations: ${t.groupsBlockedMembers}`, '',
    '## Source inconsistencies', '',
    'Declared count mismatches are warnings only because actual relationships come from row-level identities. Servant spelling differences that resolve to one identical ID set are warnings; the three contradictory/unresolved servant lists remain assignment blockers.', '',
    'No apply mode was run and no database data was changed.', '',
  ];
  return lines.join('\n');
}

function writeResolutionReports(plan, reportsRoot) {
  const reportDir = path.join(reportsRoot, stamp(new Date(plan.generatedAt)));
  fs.mkdirSync(reportDir, { recursive: false });
  plan.planChecksum = calculatePlanChecksum(plan);
  fs.writeFileSync(path.join(reportDir, 'plan.json'), `${JSON.stringify(plan, null, 2)}\n`, 'utf8');
  fs.writeFileSync(path.join(reportDir, 'summary.md'), summary(plan), 'utf8');
  writeCsv(path.join(reportDir, 'blockers-breakdown.csv'), ['Type', 'Count', 'Severity', 'Notes'], plan.blockerBreakdown.map((entry) => ({ Type: entry.type, Count: entry.count, Severity: entry.severity, Notes: entry.notes })));
  writeCsv(path.join(reportDir, 'missing-people-review.csv'), ['Original Excel spelling', 'Normalized name', 'Role', 'Meetings', 'Groups', 'Grade', 'Excel rows', 'Reason not created', 'Known potential homonym', 'Invalid', 'Possible partial/fuzzy candidates', 'Safe to create', 'Classification', 'Recommended manual action'], plan.missingPeople.map((entry) => ({
    'Original Excel spelling': entry.original, 'Normalized name': entry.normalizedName, Role: entry.role, Meetings: join(entry.meetings), Groups: join(entry.groups), Grade: join(entry.grades), 'Excel rows': join(entry.rows),
    'Reason not created': entry.reasonNotCreated, 'Known potential homonym': entry.knownPotentialHomonym, Invalid: entry.invalid,
    'Possible partial/fuzzy candidates': entry.fuzzyCandidates.map((candidate) => `${candidate.id}:${candidate.name} (${candidate.score}; ${candidate.reason})`).join(' | '),
    'Safe to create': entry.safeToCreateAfterReview, Classification: entry.classification, 'Recommended manual action': entry.recommendedAction,
  })));
  writeCsv(path.join(reportDir, 'ambiguous-people-review.csv'), ['Excel name', 'Normalized name', 'Role', 'Meeting', 'Group', 'Grade', 'Excel rows', 'Candidate IDs', 'Candidate full names', 'Candidate gender', 'Candidate birth date / age group', 'Candidate education', 'Existing meetings', 'Existing groups', 'Family name', 'House name', 'Existing source/import metadata', 'Ambiguity reason', 'Eliminated candidates', 'Recommended candidate ID', 'Recommendation reason', 'Confidence', 'Automatically resolvable'], plan.ambiguousPeople.map((entry) => ({
    'Excel name': entry.original, 'Normalized name': entry.normalizedName, Role: entry.role, Meeting: join(entry.meetings), Group: join(entry.groups), Grade: join(entry.grades), 'Excel rows': join(entry.rows),
    'Candidate IDs': entry.candidates.map((candidate) => candidate.id).join(' | '), 'Candidate full names': entry.candidates.map((candidate) => candidate.fullName).join(' | '),
    'Candidate gender': entry.candidates.map((candidate) => `${candidate.id}:${candidate.gender || 'unknown'}`).join(' | '),
    'Candidate birth date / age group': entry.candidates.map((candidate) => `${candidate.id}:${candidate.birthDate || 'unknown'}/${candidate.ageGroup || 'unknown'}`).join(' | '),
    'Candidate education': entry.candidates.map((candidate) => `${candidate.id}:${JSON.stringify(candidate.education || {})}`).join(' | '),
    'Existing meetings': entry.candidates.map((candidate) => `${candidate.id}:${join(candidate.meetings)}`).join(' | '),
    'Existing groups': entry.candidates.map((candidate) => `${candidate.id}:member=${JSON.stringify(candidate.memberGroups)} servant=${JSON.stringify(candidate.servantGroups)}`).join(' | '),
    'Family name': entry.candidates.map((candidate) => `${candidate.id}:${candidate.familyName}`).join(' | '), 'House name': entry.candidates.map((candidate) => `${candidate.id}:${candidate.houseName}`).join(' | '),
    'Existing source/import metadata': entry.candidates.map((candidate) => `${candidate.id}:${JSON.stringify(candidate.importMetadata || {})}`).join(' | '),
    'Ambiguity reason': entry.ambiguityReason, 'Eliminated candidates': JSON.stringify(entry.eliminatedCandidates), 'Recommended candidate ID': entry.recommendedCandidateId,
    'Recommendation reason': entry.recommendationReason, Confidence: entry.confidence, 'Automatically resolvable': entry.automaticallyResolvable,
  })));
  const manualRows = [...plan.missingPeople.map((entry) => ({ ...entry, status: entry.classification, candidates: entry.fuzzyCandidates })), ...plan.ambiguousPeople.map((entry) => ({ ...entry, status: 'AMBIGUOUS', candidates: entry.candidates }))];
  writeCsv(path.join(reportDir, 'manual-church-service-identity-mapping.csv'), ['Excel original name', 'Normalized name', 'Role', 'Meetings', 'Groups', 'Grade', 'Excel rows', 'Current status', 'Candidate user IDs', 'Candidate user names', 'Candidate details summary', 'Recommended candidate ID', 'Recommendation reason', 'Confidence', 'approvedUserId', 'decision', 'notes'], manualRows.map((entry) => ({
    'Excel original name': entry.original, 'Normalized name': entry.normalizedName, Role: entry.role, Meetings: join(entry.meetings), Groups: join(entry.groups), Grade: join(entry.grades), 'Excel rows': join(entry.rows), 'Current status': entry.status,
    'Candidate user IDs': (entry.candidates || []).map((candidate) => candidate.id).join(' | '), 'Candidate user names': (entry.candidates || []).map((candidate) => candidate.fullName || candidate.name).join(' | '),
    'Candidate details summary': (entry.candidates || []).map((candidate) => `${candidate.id}:${candidate.reason || JSON.stringify({ gender: candidate.gender, ageGroup: candidate.ageGroup, education: candidate.education, meetings: candidate.meetings })}`).join(' | '),
    'Recommended candidate ID': entry.recommendedCandidateId || '', 'Recommendation reason': entry.recommendationReason || entry.recommendedAction || '', Confidence: entry.confidence || '', approvedUserId: '', decision: '', notes: '',
  })));
  writeCsv(path.join(reportDir, 'membership-conflicts.csv'), ['Kind', 'User ID', 'Name', 'Sector', 'Meeting', 'Group', 'Classification', 'Disposition', 'Existing groups', 'Excel rows', 'Details'], plan.membershipConflicts.map((entry) => ({ Kind: entry.kind, 'User ID': entry.userId, Name: entry.name || '', Sector: entry.sector, Meeting: entry.meeting, Group: entry.group, Classification: entry.classification, Disposition: entry.disposition, 'Existing groups': join(entry.existingGroups), 'Excel rows': join(entry.rows), Details: entry.details })));
  writeCsv(path.join(reportDir, 'groups-impact.csv'), ['Sector', 'Meeting', 'Grade', 'Group', 'Group status', 'Group operation', 'Resolved servants', 'Blocked servants', 'Safe servant adds', 'Servant no-ops', 'Resolved members', 'Blocked members', 'Safe member adds', 'Member no-ops', 'Membership conflicts', 'Group creation safe', 'Servant assignment safe', 'Member assignment safe', 'Blocker reasons'], plan.groupsImpact.map((entry) => ({ Sector: entry.sector, Meeting: entry.meeting, Grade: entry.grade, Group: entry.group, 'Group status': entry.groupStatus, 'Group operation': entry.groupOperation, 'Resolved servants': entry.resolvedServants, 'Blocked servants': entry.blockedServants, 'Safe servant adds': entry.servantAdds, 'Servant no-ops': entry.servantNoOps, 'Resolved members': entry.resolvedMembers, 'Blocked members': entry.blockedMembers, 'Safe member adds': entry.memberAdds, 'Member no-ops': entry.memberNoOps, 'Membership conflicts': entry.membershipConflicts, 'Group creation safe': entry.groupCreationSafe, 'Servant assignment safe': entry.servantAssignmentSafe, 'Member assignment safe': entry.memberAssignmentSafe, 'Blocker reasons': join(entry.blockerReasons) })));
  const reconciliationRows = Object.entries(plan.assignmentReconciliation).map(([metric, count]) => ({ Metric: metric, Count: count, Notes: '' }));
  writeCsv(path.join(reportDir, 'assignment-reconciliation.csv'), ['Metric', 'Count', 'Notes'], reconciliationRows);
  return { reportDir, planPath: path.join(reportDir, 'plan.json'), mappingPath: path.join(reportDir, 'manual-church-service-identity-mapping.csv'), checksum: plan.planChecksum };
}

module.exports = { summary, writeResolutionReports };
