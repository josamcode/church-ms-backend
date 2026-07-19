const fs = require('fs');
const path = require('path');
const { calculatePlanChecksum } = require('./integrity');

function csvCell(value) {
  const text = Array.isArray(value) ? value.join(' | ') : value && typeof value === 'object' ? JSON.stringify(value) : String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function writeCsv(filePath, headers, rows) {
  const output = [headers.map(csvCell).join(','), ...rows.map((row) => headers.map((header) => csvCell(row[header])).join(','))].join('\r\n');
  fs.writeFileSync(filePath, `\uFEFF${output}\r\n`, 'utf8');
}

function timestampDirectoryName(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return `church-service-import-preflight-${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function peopleRows(plan) {
  return plan.peopleMatches.map((person) => ({
    Role: person.role,
    'Original Excel name': person.original,
    'Normalized name': person.normalizedName,
    'Excel rows': person.rows,
    'Match status': person.status,
    'Matched ID': person.matchedId,
    'Matched system name': person.matchedName,
    'Match method': person.matchMethod,
    'Account status': person.accountStatus,
    'System role / servant eligibility': person.systemRole ? `${person.systemRole}; no separate servant-eligibility field exists` : '',
    'Candidate count': person.candidateCount,
    'Candidate IDs and names': person.candidates.map((candidate) => `${candidate.id}:${candidate.name}`),
    Notes: person.notes,
  }));
}

function groupRows(plan) {
  return plan.groups.map((group) => ({
    Sector: group.sector,
    Meeting: group.meeting,
    Grade: group.grade,
    'Original group name': group.originalGroupName,
    'Normalized group name': group.normalizedGroupName,
    'Existing or create': group.groupAction,
    'Existing group ID': group.existingGroupId || '',
    'Domain key': group.domainKey,
    'Declared servant count': group.declaredServantCounts,
    'Resolved servant count': group.resolvedServantIds.length,
    'Declared member count': group.declaredMemberCounts,
    'Source member rows': group.sourceMemberRows,
    'Unique resolved members': group.resolvedMemberIds.length,
    'Planned writes': `group=${group.operations.group}; servants ADD=${group.operations.servantAssignments.ADD} NO_OP=${group.operations.servantAssignments.NO_OP}; members ADD=${group.operations.memberAssignments.ADD} NO_OP=${group.operations.memberAssignments.NO_OP}`,
    Warnings: group.warnings,
    Blockers: group.blockers,
  }));
}

function conflictRows(plan) {
  return plan.conflicts.map((conflict) => ({
    Type: conflict.type,
    Severity: conflict.severity,
    Sector: conflict.sector || '',
    Meeting: conflict.meeting || '',
    Grade: conflict.grade || '',
    Group: conflict.group || '',
    Name: conflict.name || '',
    'User ID': conflict.userId || '',
    'Excel rows': conflict.rows || '',
    Details: conflict.message,
  }));
}

function summaryMarkdown(plan) {
  const t = plan.totals;
  const lines = [
    '# Church service import preflight', '',
    `- Generated: ${plan.generatedAt}`,
    `- Input: \`${plan.input.path}\``,
    `- Input SHA-256: \`${plan.input.sha256}\``,
    `- Environment: \`${plan.environment || 'unknown'}\``,
    `- Database: \`${plan.database.name}\``,
    `- Sheet: \`${plan.input.sheet}\``,
    `- Plan checksum: \`${plan.planChecksum}\``, '',
    '## Outcome', '',
    `**Safe to apply: ${plan.safeToApply ? 'YES' : 'NO'}**`, '',
    '| Metric | Count |', '|---|---:|',
    `| Parsed rows | ${t.parsedRows} |`,
    `| Source groups | ${t.groups} |`,
    `| Exact unique source spellings | ${t.uniqueExactNames} |`,
    `| Unique normalized names | ${t.uniqueNormalizedNames} |`,
    `| Exact matches | ${t.exactMatches} |`,
    `| Normalized matches | ${t.normalizedMatches} |`,
    `| Missing users | ${t.missingUsers} |`,
    `| Ambiguous users | ${t.ambiguousUsers} |`,
    `| Invalid users | ${t.invalidUsers} |`,
    `| Groups to create | ${t.groupsToCreate} |`,
    `| Existing groups reused | ${t.groupsToReuse} |`,
    `| Planned servant assignments | ${t.plannedServantAssignments} |`,
    `| Planned member assignments | ${t.plannedMemberAssignments} |`,
    `| Existing no-op assignments | ${t.existingNoOpAssignments} |`,
    `| Conflicts/report findings | ${t.conflicts} |`,
    `| Blocking errors | ${t.blockers} |`,
    `| Warnings | ${t.warnings} |`, '',
    '## Sector and meeting resolution', '',
    `Resolved sectors: ${plan.resolvedSectors.length}. Resolved meetings: ${plan.resolvedMeetings.length}. Sectors and meetings are never created by this importer.`, '',
    '## Match breakdown', '',
    `Exact matches: ${t.exactMatches}; normalized matches: ${t.normalizedMatches}; missing: ${t.missingUsers}; ambiguous: ${t.ambiguousUsers}. See \`people-matches.csv\` for every source spelling and candidate.`, '',
    '## Blocking errors', '',
  ];
  if (!plan.blockingErrors.length) lines.push('- None.');
  else plan.blockingErrors.slice(0, 100).forEach((entry) => lines.push(`- [${entry.type}] ${entry.message}`));
  if (plan.blockingErrors.length > 100) lines.push(`- ... ${plan.blockingErrors.length - 100} more; see conflicts.csv.`);
  lines.push('', '## Warnings', '');
  if (!plan.warnings.length) lines.push('- None.');
  else plan.warnings.slice(0, 100).forEach((entry) => lines.push(`- [${entry.type}] ${entry.message}`));
  if (plan.warnings.length > 100) lines.push(`- ... ${plan.warnings.length - 100} more; see conflicts.csv.`);
  lines.push('', '## Schema note', '', 'The current application has no separate Group collection or grade field. Groups are meeting-scoped strings and relationships are user ObjectIds. Grade is retained in this plan/report and is not written. Existing group IDs are therefore blank; `domainKey` is used as the immutable plan identity.', '');
  return lines.join('\n');
}

function writePreflightReports(plan, reportsRoot) {
  const reportDir = path.join(reportsRoot, timestampDirectoryName(new Date(plan.generatedAt)));
  fs.mkdirSync(reportsRoot, { recursive: true });
  fs.mkdirSync(reportDir, { recursive: false });
  plan.planChecksum = calculatePlanChecksum(plan);
  fs.writeFileSync(path.join(reportDir, 'plan.json'), `${JSON.stringify(plan, null, 2)}\n`, 'utf8');
  fs.writeFileSync(path.join(reportDir, 'summary.md'), summaryMarkdown(plan), 'utf8');
  writeCsv(path.join(reportDir, 'people-matches.csv'), Object.keys(peopleRows(plan)[0] || {}), peopleRows(plan));
  writeCsv(path.join(reportDir, 'groups-plan.csv'), Object.keys(groupRows(plan)[0] || {}), groupRows(plan));
  const conflicts = conflictRows(plan);
  const conflictHeaders = Object.keys(conflicts[0] || { Type: '', Severity: '', Sector: '', Meeting: '', Grade: '', Group: '', Name: '', 'User ID': '', 'Excel rows': '', Details: '' });
  writeCsv(path.join(reportDir, 'conflicts.csv'), conflictHeaders, conflicts);
  return { reportDir, planPath: path.join(reportDir, 'plan.json'), checksum: plan.planChecksum };
}

module.exports = { csvCell, writeCsv, timestampDirectoryName, summaryMarkdown, writePreflightReports };
