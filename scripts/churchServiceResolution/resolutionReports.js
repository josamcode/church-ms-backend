const fs = require('fs');
const path = require('path');
const { writeCsv } = require('../churchServiceImport/reports');

function stamp(date) {
  const pad = (value) => String(value).padStart(2, '0');
  return `church-service-import-preflight-resolved-${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function summary(plan) {
  const t = plan.totals;
  return [
    '# Resolution-aware church-service preflight', '',
    `- Generated: ${plan.generatedAt}`,
    `- Source Excel: \`${plan.input.path}\``,
    `- Source Excel hash: \`${plan.input.sha256}\``,
    `- Database: \`${plan.database.name}\``,
    `- Database fingerprint: \`${plan.databaseFingerprint}\``,
    `- Resolution workbook: \`${plan.resolutionWorkbook.path}\``,
    `- Resolution workbook hash: \`${plan.resolutionWorkbook.sha256}\``,
    `- Plan checksum: \`${plan.planChecksum}\``, '',
    `**Safe operations available: ${plan.safeOperationsAvailable ? 'YES' : 'NO'}**`,
    `**Safe for full apply: ${plan.safeForFullApply ? 'YES' : 'NO'}**`, '',
    '| Metric | Count |', '|---|---:|',
    `| Manual decisions loaded | ${t.manualDecisionsLoaded} |`,
    `| Invalid decisions | ${t.invalidDecisions} |`,
    `| Blank unresolved decisions | ${t.blankUnresolvedDecisions} |`,
    `| Identities mapped | ${t.identitiesMapped} |`,
    `| Identities split | ${t.identitiesSplit} |`,
    `| Identities requiring new users | ${t.identitiesRequiringNewUsers} |`,
    `| Source occurrences skipped | ${t.sourceOccurrencesSkipped} |`,
    `| Multiple-group conflicts resolved | ${t.multipleGroupConflictsResolved} |`,
    `| Multiple-group conflicts remaining | ${t.multipleGroupConflictsRemaining} |`,
    `| Servant conflicts resolved | ${t.servantConflictsResolved} |`,
    `| Servant conflicts remaining | ${t.servantConflictsRemaining} |`,
    `| Safe servant assignments | ${t.safeServantAssignments} |`,
    `| Safe member assignments | ${t.safeMemberAssignments} |`,
    `| Existing no-ops | ${t.existingNoOps} |`,
    `| Remaining blocker records | ${t.remainingBlockers} |`, '',
    'This plan is read-only. `safeToApply` remains false; any future apply must verify this exact workbook and hash in addition to the Excel, database, checksum, and actor safeguards.', '',
  ].join('\n');
}

function writeResolutionAwareReports(plan, reportsRoot) {
  const reportDir = path.join(reportsRoot, stamp(new Date(plan.generatedAt)));
  fs.mkdirSync(reportDir, { recursive: false });
  fs.writeFileSync(path.join(reportDir, 'plan.json'), `${JSON.stringify(plan, null, 2)}\n`, 'utf8');
  fs.writeFileSync(path.join(reportDir, 'summary.md'), summary(plan), 'utf8');
  writeCsv(path.join(reportDir, 'resolution-decisions.csv'), ['Type', 'Key', 'Decision', 'Details'], plan.resolutionDecisions.map((entry) => ({ Type: entry.type, Key: entry.identityKey || entry.conflictKey || '', Decision: entry.decision || entry.reason || '', Details: JSON.stringify(entry) })));
  writeCsv(path.join(reportDir, 'identity-resolution-results.csv'), ['Identity key', 'Normalized name', 'Manual decision', 'Result', 'Message'], plan.identityResolutionResults.map((entry) => ({ 'Identity key': entry.identityKey, 'Normalized name': entry.normalizedName, 'Manual decision': entry.manualDecision, Result: entry.result, Message: entry.message })));
  writeCsv(path.join(reportDir, 'group-conflict-resolution.csv'), ['Conflict key', 'User ID', 'Meeting', 'Source groups', 'Manual decision', 'Approved group', 'Validation status', 'Validation message'], plan.resolutionReview.groups.map((entry) => ({ 'Conflict key': entry.conflictKey, 'User ID': entry.userId, Meeting: entry.meetingName, 'Source groups': entry.sourceGroups, 'Manual decision': entry.manualDecision, 'Approved group': entry.approvedGroupName, 'Validation status': entry.validationStatus, 'Validation message': entry.validationMessage })));
  writeCsv(path.join(reportDir, 'servant-conflict-resolution.csv'), ['Conflict key', 'Meeting', 'Group', 'Candidate sets', 'Manual decision', 'Approved IDs', 'Approved source set', 'Validation status', 'Validation message'], plan.resolutionReview.servants.map((entry) => ({ 'Conflict key': entry.conflictKey, Meeting: entry.meeting, Group: entry.groupName, 'Candidate sets': entry.candidateServantSets, 'Manual decision': entry.manualDecision, 'Approved IDs': entry.approvedServantUserIds, 'Approved source set': entry.approvedSourceSet, 'Validation status': entry.validationStatus, 'Validation message': entry.validationMessage })));
  writeCsv(path.join(reportDir, 'remaining-blockers.csv'), ['Type', 'Identity key', 'Conflict key', 'User ID', 'Meeting ID', 'Source key', 'Message'], plan.blockingErrors.map((entry) => ({ Type: entry.type, 'Identity key': entry.identityKey || '', 'Conflict key': entry.conflictKey || '', 'User ID': entry.userId || '', 'Meeting ID': entry.meetingId || '', 'Source key': entry.sourceKey || '', Message: entry.message })));
  writeCsv(path.join(reportDir, 'people-matches.csv'), ['Role', 'Original Excel name', 'Normalized name', 'Excel rows', 'Match status', 'Matched ID', 'Matched system name', 'Candidate count', 'Candidates'], plan.peopleMatches.map((entry) => ({ Role: entry.role, 'Original Excel name': entry.original, 'Normalized name': entry.normalizedName, 'Excel rows': entry.rows, 'Match status': entry.status, 'Matched ID': entry.matchedId, 'Matched system name': entry.matchedName, 'Candidate count': entry.candidateCount, Candidates: entry.candidates })));
  writeCsv(path.join(reportDir, 'groups-plan.csv'), ['Sector', 'Meeting', 'Grade', 'Group', 'Group action', 'Servant ADD', 'Servant NO_OP', 'Servant BLOCKED', 'Member ADD', 'Member NO_OP', 'Member BLOCKED', 'Skipped members'], plan.groups.map((entry) => ({ Sector: entry.sector, Meeting: entry.meeting, Grade: entry.grade, Group: entry.originalGroupName, 'Group action': entry.operations.group, 'Servant ADD': entry.operations.servantAssignments.ADD, 'Servant NO_OP': entry.operations.servantAssignments.NO_OP, 'Servant BLOCKED': entry.operations.servantAssignments.BLOCKED, 'Member ADD': entry.operations.memberAssignments.ADD, 'Member NO_OP': entry.operations.memberAssignments.NO_OP, 'Member BLOCKED': entry.operations.memberAssignments.BLOCKED, 'Skipped members': entry.skippedMembers })));
  writeCsv(path.join(reportDir, 'conflicts.csv'), ['Type', 'Severity', 'Identity key', 'Conflict key', 'User ID', 'Meeting ID', 'Source key', 'Message'], plan.conflicts.map((entry) => ({ Type: entry.type, Severity: entry.severity, 'Identity key': entry.identityKey || '', 'Conflict key': entry.conflictKey || '', 'User ID': entry.userId || '', 'Meeting ID': entry.meetingId || '', 'Source key': entry.sourceKey || '', Message: entry.message })));
  return { reportDir, planPath: path.join(reportDir, 'plan.json'), checksum: plan.planChecksum };
}

module.exports = { summary, writeResolutionAwareReports };
