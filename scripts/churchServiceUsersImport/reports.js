const fs = require('fs');
const path = require('path');
const { writeCsv } = require('../churchServiceImport/reports');
const { calculatePlanChecksum } = require('../churchServiceImport/integrity');

function timestampDirectoryName(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return `church-service-users-preflight-${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function usersRows(plan) {
  return plan.identities.map((identity) => ({
    'Stable person key': identity.stablePersonKey,
    'Canonical full name': identity.canonicalFullName,
    'All original spellings': identity.originalSpellings,
    'Normalized name': identity.normalizedName,
    Roles: identity.roles,
    Meetings: identity.meetings,
    Groups: identity.groups,
    Grades: identity.grades,
    'Excel rows': identity.rowNumbers,
    'Existing match status': identity.classification,
    'Planned user operation': identity.operation,
    'Planned gender': identity.gender || '',
    'Gender evidence': identity.genderEvidence,
    'Planned education': identity.education?.stage || '',
    'Education evidence': identity.educationEvidence,
    hasLogin: identity.plannedUser.hasLogin,
    'Account status': identity.plannedUser.accountStatus,
    Tags: identity.plannedUser.tags,
    'Import source key': identity.importSourceKey,
    Warnings: identity.warnings,
    Blockers: identity.blockers,
  }));
}

function existingPeopleRows(plan) {
  return (plan.sourceClassifications || [])
    .filter((person) => ['NO_OP_ALREADY_IMPORTED', 'REUSE_EXISTING', 'EXISTING_AMBIGUOUS'].includes(person.classification))
    .map((person) => ({
      'Original Excel name': person.original,
      'Normalized name': person.normalizedName,
      'Excel rows': person.rows,
      'Source match status': person.sourceMatchStatus,
      Classification: person.classification,
      'Planned operation': person.plannedOperation || (person.classification === 'EXISTING_AMBIGUOUS' ? 'AMBIGUOUS' : ''),
      'Matched database ID': person.matchedId,
      'Matched system name': person.matchedName,
      Candidates: person.candidates,
    }));
}

function familyRows(plan) {
  return plan.identities.map((identity) => ({
    'Stable person key': identity.stablePersonKey,
    "Missing person's name": identity.canonicalFullName,
    'Candidate family/household': identity.family.household ? `${identity.family.household.houseName} / ${identity.family.household.familyName}` : '',
    'Candidate father ID and name': identity.family.father ? `${identity.family.father.id}:${identity.family.father.name}` : '',
    'Candidate mother ID and name': identity.family.mother ? `${identity.family.mother.id}:${identity.family.mother.name}` : '',
    'Candidate household values': identity.family.household || '',
    'Match evidence': identity.family.evidence,
    Confidence: identity.family.confidence,
    Conflicts: identity.family.conflicts,
    'Planned action': identity.family.plannedAction,
    'Manual approval required': identity.family.manualApprovalRequired,
  }));
}

function familyCandidateRows(plan) {
  return plan.identities.flatMap((identity) => {
    if (identity.family.confidence === 'HIGH_CONFIDENCE_AUTO_LINK') return [];
    return identity.family.candidates.slice(0, 5).map((candidate) => ({
      'Missing person': identity.canonicalFullName,
      'Candidate user ID': candidate.candidateUserId,
      'Candidate name': candidate.candidateName,
      'Candidate relation type': candidate.relationType,
      Household: candidate.household,
      'Supporting tokens': candidate.supportingTokens,
      'Similarity reason': candidate.similarityReason,
      Score: candidate.score,
      'Existing family details': candidate.existingFamilyDetails,
      Conflicts: candidate.conflicts,
    }));
  });
}

function manualRows(plan) {
  return plan.identities.map((identity) => ({
    'Stable person key': identity.stablePersonKey,
    'Missing person': identity.canonicalFullName,
    'Suggested father ID': identity.family.father?.id || '',
    'Suggested mother ID': identity.family.mother?.id || '',
    'Suggested household': identity.family.household ? `${identity.family.household.houseName} / ${identity.family.household.familyName}` : '',
    approvedFatherId: '',
    approvedMotherId: '',
    approvedHouseholdUserId: '',
    decision: '',
    notes: '',
  }));
}

function highConfidenceFamilyRows(plan) {
  return plan.identities
    .filter((identity) => identity.operation === 'CREATE' && identity.family.confidence === 'HIGH_CONFIDENCE_AUTO_LINK')
    .map((identity) => {
      const fatherCandidate = identity.family.candidates.find((candidate) => candidate.candidateUserId === identity.family.father?.id);
      return {
        'New user stable key': identity.stablePersonKey,
        "New user's canonical name": identity.canonicalFullName,
        'Planned father ID': identity.family.father?.id || '',
        'Planned father name': identity.family.father?.name || '',
        'Planned mother ID': identity.family.mother?.id || '',
        'Planned mother name': identity.family.mother?.name || '',
        'Household name': [identity.family.household?.houseName, identity.family.household?.familyName].filter(Boolean).join(' / '),
        'Exact evidence tokens': fatherCandidate?.supportingTokens || [],
        'Existing father family': fatherCandidate?.existingFamilyDetails || '',
        'Existing spouse/mother relationship': identity.family.mother ? `${identity.family.father?.id}->spouse:${identity.family.mother.id}` : 'No uniquely linked spouse/mother',
        'Confidence reason': identity.family.evidence,
        'Conflicts checked': ['candidate uniqueness', 'household uniqueness', 'father gender', 'age/stage compatibility', 'existing relationships', ...(identity.family.conflicts || [])],
        'Excel meetings': identity.meetings,
        'Excel groups': identity.groups,
        'Manual approval': '',
        Notes: '',
      };
    });
}

function conflictRows(plan) {
  return plan.conflicts.map((entry) => ({
    Type: entry.type,
    Severity: entry.severity,
    'Stable person key': entry.stablePersonKey,
    Name: entry.name,
    'Excel rows': entry.rows,
    Candidates: entry.candidates || '',
    Details: entry.message,
  }));
}

function countBy(identities, selector) {
  const counts = new Map();
  identities.forEach((identity) => selector(identity).forEach((value) => counts.set(value, (counts.get(value) || 0) + 1)));
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'ar'));
}

function summaryMarkdown(plan) {
  const t = plan.totals;
  const lines = [
    '# Church service missing-user preflight', '',
    `- Generated: ${plan.generatedAt}`,
    `- Batch ID: \`${plan.batchId}\``,
    `- Input: \`${plan.input.path}\``,
    `- Input SHA-256: \`${plan.input.sha256}\``,
    `- Environment: \`${plan.environment || 'unknown'}\``,
    `- Database: \`${plan.database.name}\``,
    `- Plan checksum: \`${plan.planChecksum}\``, '',
    `**Safe to create individually safe users: ${plan.safeToApplyUsersOnly ? 'YES' : 'NO'}**`, '',
    '| Metric | Count |', '|---|---:|',
    `| Total exact Excel spellings | ${t.totalExcelNames} |`,
    `| Existing exact users | ${t.existingExactUsers} |`,
    `| Existing normalized users | ${t.existingNormalizedUsers} |`,
    `| Existing imported identities (no-op by source key) | ${t.noOpAlreadyImported || 0} |`,
    `| Other existing identities reused | ${t.reuseExisting || 0} |`,
    `| Existing ambiguous users | ${t.existingAmbiguousUsers} |`,
    `| Missing identity candidates | ${t.missingIdentityCandidates} |`,
    `| Safe users to create | ${t.safeUsersToCreate} |`,
    `| Potential homonyms | ${t.potentialHomonyms} |`,
    `| Invalid names | ${t.invalidNames} |`,
    `| Blocked users | ${t.blockedUsers} |`,
    `| Users with inferred gender | ${t.usersWithKnownGender} |`,
    `| Users with unknown gender | ${t.usersWithUnknownGender} |`,
    `| Users with exact education mapping | ${t.usersWithMappedEducation} |`,
    `| Users with unknown education | ${t.usersWithUnknownEducation} |`,
    `| High-confidence family links | ${t.highConfidenceFamilyLinks} |`,
    `| Medium-confidence family suggestions | ${t.mediumConfidenceFamilySuggestions} |`,
    `| Low-confidence family suggestions | ${t.lowConfidenceFamilySuggestions} |`,
    `| Ambiguous families | ${t.ambiguousFamilies} |`,
    `| Family conflicts | ${t.familyConflicts} |`,
    `| No-family candidates | ${t.noFamilyCandidates} |`,
    `| Record blockers | ${t.recordBlockers} |`,
    `| Global execution errors | ${t.globalExecutionErrors} |`, '',
    '## Users by source role', '',
    '| Role | Identities |', '|---|---:|',
    ...countBy(plan.identities, (identity) => identity.roles).map(([name, count]) => `| ${name} | ${count} |`), '',
    '## Users by meeting', '',
    '| Meeting | Identities |', '|---|---:|',
    ...countBy(plan.identities, (identity) => identity.meetings).map(([name, count]) => `| ${name} | ${count} |`), '',
    '## Blocking errors', '',
  ];
  if (!plan.recordBlockers.length) lines.push('- None.');
  else plan.recordBlockers.slice(0, 100).forEach((entry) => lines.push(`- [${entry.type}] ${entry.message}`));
  if (plan.recordBlockers.length > 100) lines.push(`- ... ${plan.recordBlockers.length - 100} more; see conflicts.csv.`);
  lines.push('', '## Global execution errors', '');
  if (!plan.globalExecutionErrors.length) lines.push('- None. Safe records may be executed independently after explicit approval.');
  else plan.globalExecutionErrors.forEach((entry) => lines.push(`- [${entry.type}] ${entry.message}`));
  lines.push('', '## Safety notes', '', '- No user, credential, family relation, meeting assignment, or group assignment was written.', '- Birth dates, national IDs, phones, email addresses, and passwords are omitted.', '- Only explicit member-meeting gender evidence is used. Servant occurrences never infer gender.', '- No family suggestion is approved by this plan. Family application requires a separately checksummed plan containing explicit manual approvals.', '');
  return lines.join('\n');
}

function writeUsersPreflightReports(plan, reportsRoot) {
  fs.mkdirSync(reportsRoot, { recursive: true });
  const reportDir = path.join(reportsRoot, timestampDirectoryName(new Date(plan.generatedAt)));
  fs.mkdirSync(reportDir, { recursive: false });
  plan.planChecksum = calculatePlanChecksum(plan);
  fs.writeFileSync(path.join(reportDir, 'plan.json'), `${JSON.stringify(plan, null, 2)}\n`, 'utf8');
  fs.writeFileSync(path.join(reportDir, 'summary.md'), summaryMarkdown(plan), 'utf8');
  const files = [
    ['users-create-plan.csv', usersRows(plan), ['Stable person key', 'Canonical full name', 'All original spellings', 'Normalized name', 'Roles', 'Meetings', 'Groups', 'Grades', 'Excel rows', 'Existing match status', 'Planned user operation', 'Planned gender', 'Gender evidence', 'Planned education', 'Education evidence', 'hasLogin', 'Account status', 'Tags', 'Import source key', 'Warnings', 'Blockers']],
    ['existing-people-plan.csv', existingPeopleRows(plan), ['Original Excel name', 'Normalized name', 'Excel rows', 'Source match status', 'Classification', 'Planned operation', 'Matched database ID', 'Matched system name', 'Candidates']],
    ['family-match-plan.csv', familyRows(plan), ['Stable person key', "Missing person's name", 'Candidate family/household', 'Candidate father ID and name', 'Candidate mother ID and name', 'Candidate household values', 'Match evidence', 'Confidence', 'Conflicts', 'Planned action', 'Manual approval required']],
    ['family-candidates.csv', familyCandidateRows(plan), ['Missing person', 'Candidate user ID', 'Candidate name', 'Candidate relation type', 'Household', 'Supporting tokens', 'Similarity reason', 'Score', 'Existing family details', 'Conflicts']],
    ['manual-family-mapping.csv', manualRows(plan), ['Stable person key', 'Missing person', 'Suggested father ID', 'Suggested mother ID', 'Suggested household', 'approvedFatherId', 'approvedMotherId', 'approvedHouseholdUserId', 'decision', 'notes']],
    ['high-confidence-family-links.csv', highConfidenceFamilyRows(plan), ['New user stable key', "New user's canonical name", 'Planned father ID', 'Planned father name', 'Planned mother ID', 'Planned mother name', 'Household name', 'Exact evidence tokens', 'Existing father family', 'Existing spouse/mother relationship', 'Confidence reason', 'Conflicts checked', 'Excel meetings', 'Excel groups', 'Manual approval', 'Notes']],
    ['conflicts.csv', conflictRows(plan), ['Type', 'Severity', 'Stable person key', 'Name', 'Excel rows', 'Candidates', 'Details']],
  ];
  files.forEach(([name, rows, fallbackHeaders]) => writeCsv(path.join(reportDir, name), Object.keys(rows[0] || {}).length ? Object.keys(rows[0]) : fallbackHeaders, rows));
  return { reportDir, planPath: path.join(reportDir, 'plan.json'), checksum: plan.planChecksum, files: ['summary.md', ...files.map(([name]) => name), 'plan.json'] };
}

module.exports = { timestampDirectoryName, usersRows, existingPeopleRows, familyRows, familyCandidateRows, manualRows, highConfidenceFamilyRows, summaryMarkdown, writeUsersPreflightReports };
