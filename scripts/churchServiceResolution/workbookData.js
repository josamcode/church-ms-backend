const { normalizeArabicComparison } = require('../../src/utils/arabicNormalization');
const { stableKey } = require('./workbookSchema');
const { buildGroupAliasAudit, buildDuplicateUserAudit } = require('./higherLevelAudit');

const idOf = (value) => String(value?._id || value?.id || value || '');
const unique = (values) => [...new Set((values || []).filter((value) => value !== '' && value != null))];
const join = (values) => unique(values).join(' | ');

function buildIdentityRows(resolutionPlan, { includeAmbiguous = false } = {}) {
  const clusters = new Map();
  const add = (entry, kind) => {
    const key = entry.normalizedName;
    if (!clusters.has(key)) clusters.set(key, { kind, entries: [] });
    clusters.get(key).entries.push(entry);
  };
  resolutionPlan.missingPeople.forEach((entry) => add(entry, 'missing'));
  if (includeAmbiguous) resolutionPlan.ambiguousPeople.forEach((entry) => add(entry, 'ambiguous'));
  return [...clusters.entries()].map(([normalizedName, cluster]) => {
    const entries = cluster.entries;
    const candidates = unique(entries.flatMap((entry) => entry.candidates || entry.fuzzyCandidates || []).map((candidate) => candidate.id))
      .map((id) => entries.flatMap((entry) => entry.candidates || entry.fuzzyCandidates || []).find((candidate) => candidate.id === id));
    const invalid = entries.some((entry) => entry.classification === 'INVALID_NAME');
    const currentStatus = cluster.kind === 'ambiguous' ? 'AMBIGUOUS' : invalid ? 'INVALID_NAME' : 'POTENTIAL_HOMONYM';
    const identityKey = stableKey('church-service-identity', `${currentStatus}\u001f${normalizedName}`);
    return {
      identityKey, normalizedName, sourceSpellings: join(entries.map((entry) => entry.original)), roles: join(entries.map((entry) => entry.role)),
      meetings: join(entries.flatMap((entry) => entry.meetings || [])), groups: join(entries.flatMap((entry) => entry.groups || [])), grades: join(entries.flatMap((entry) => entry.grades || [])),
      excelRows: unique(entries.flatMap((entry) => entry.rows || [])).sort((a, b) => a - b).join(' | '), currentStatus,
      candidateCount: candidates.length, candidateUserIds: join(candidates.map((candidate) => candidate.id)), candidateUserNames: join(candidates.map((candidate) => candidate.fullName || candidate.name)),
      candidateSummary: candidates.map((candidate) => `${candidate.id}:${candidate.fullName || candidate.name}${candidate.reason ? ` (${candidate.reason})` : ''}`).join(' | '),
      recommendedDecision: invalid ? 'SKIP_INVALID_SOURCE' : cluster.kind === 'ambiguous' ? 'MAP_EXISTING_USER' : 'SPLIT_SOURCE_IDENTITY',
      recommendationReason: invalid ? 'The source value is shorter than the User schema minimum.' : cluster.kind === 'ambiguous' ? 'Select only with authoritative evidence; no candidate was automatically approved.' : 'Occurrences span potentially distinct people and must be split deterministically or otherwise reviewed.',
      confidence: invalid ? 'HIGH' : 'MANUAL_REVIEW', manualDecision: '', approvedUserId: '', correctedCanonicalName: '', splitDefinition: '', notes: '', validationStatus: '', validationMessage: '',
    };
  }).sort((a, b) => a.normalizedName.localeCompare(b.normalizedName, 'ar'));
}

function buildCandidateRows(resolutionPlan, identityRows, users) {
  const keyByNormalized = new Map(identityRows.map((row) => [row.normalizedName, row.identityKey]));
  const usersById = new Map(users.map((user) => [idOf(user), user]));
  return resolutionPlan.ambiguousPeople.flatMap((identity) => identity.candidates.map((candidate) => {
    const live = usersById.get(candidate.id) || {};
    const eliminated = identity.eliminatedCandidates?.[candidate.id] || [];
    return {
      identityKey: keyByNormalized.get(identity.normalizedName), sourceName: identity.original, normalizedName: identity.normalizedName,
      candidateUserId: candidate.id, candidateFullName: candidate.fullName, candidateGender: candidate.gender || '', candidateBirthDate: candidate.birthDate || '', candidateAgeGroup: candidate.ageGroup || '',
      candidateEducation: JSON.stringify(candidate.education || {}), candidateFamilyName: candidate.familyName || '', candidateHouseName: candidate.houseName || '',
      candidateMeetings: join(candidate.meetings || []), candidateGroups: JSON.stringify({ member: candidate.memberGroups || [], servant: candidate.servantGroups || [] }),
      candidateImportSource: JSON.stringify(candidate.importMetadata || {}), candidateIsDeleted: Boolean(live.isDeleted ?? candidate.isDeleted), candidateHasLogin: Boolean(live.hasLogin),
      matchReason: identity.ambiguityReason, conflictingEvidence: join(eliminated), supportingEvidence: identity.recommendedCandidateId === candidate.id ? identity.recommendationReason : '',
    };
  })).sort((a, b) => a.identityKey.localeCompare(b.identityKey) || a.candidateFullName.localeCompare(b.candidateFullName, 'ar'));
}

function buildGroupRows(resolutionPlan, sourceAssignmentPlan, users, meetings) {
  const groupsByMeetingName = new Map();
  sourceAssignmentPlan.groups.forEach((group) => {
    if (!groupsByMeetingName.has(group.meeting)) groupsByMeetingName.set(group.meeting, group.meetingId);
  });
  const usersById = new Map(users.map((user) => [idOf(user), user]));
  const meetingsById = new Map(meetings.map((meeting) => [idOf(meeting), meeting]));
  const grouped = new Map();
  resolutionPlan.membershipConflicts.filter((entry) => entry.classification === 'MULTIPLE_EXCEL_GROUPS_SAME_MEETING').forEach((entry) => {
    const meetingId = groupsByMeetingName.get(entry.meeting) || '';
    const key = `${meetingId}\u001f${entry.userId}`;
    if (!grouped.has(key)) grouped.set(key, { userId: entry.userId, meetingId, meetingName: entry.meeting, entries: [] });
    grouped.get(key).entries.push(entry);
  });
  return [...grouped.values()].map((conflict) => {
    const user = usersById.get(conflict.userId) || {};
    const meeting = meetingsById.get(conflict.meetingId) || {};
    const sourceGroups = unique(conflict.entries.map((entry) => entry.group));
    const rowsByGroup = Object.fromEntries(sourceGroups.map((group) => [group, unique(conflict.entries.filter((entry) => entry.group === group).flatMap((entry) => entry.rows || [])).sort((a, b) => a - b)]));
    const existingGroups = unique(conflict.entries.flatMap((entry) => entry.existingGroups || []));
    const meetingMember = (user.meetingIds || []).map(idOf).includes(conflict.meetingId) || (meeting.servedUserIds || []).map(idOf).includes(conflict.userId);
    return {
      conflictKey: stableKey('church-service-group-conflict', `${conflict.meetingId}\u001f${conflict.userId}`), userId: conflict.userId, userFullName: user.fullName || '', meetingId: conflict.meetingId, meetingName: conflict.meetingName,
      sourceGroups: join(sourceGroups), sourceRowsByGroup: JSON.stringify(rowsByGroup), existingMeetingMembership: meetingMember ? 'YES' : 'NO', existingGroupMembership: join(existingGroups),
      domainAllowsMultipleGroups: 'NO', recommendedDecision: 'KEEP_ONE_GROUP', recommendationReason: 'The current meeting service rejects one member in multiple groups in the same meeting.',
      manualDecision: '', approvedGroupName: '', notes: '', validationStatus: '', validationMessage: '',
    };
  }).sort((a, b) => a.meetingName.localeCompare(b.meetingName, 'ar') || a.userFullName.localeCompare(b.userFullName, 'ar'));
}

function buildServantRows(resolutionPlan, sourceAssignmentPlan, parsedRows) {
  const matches = new Map(sourceAssignmentPlan.peopleMatches.map((person) => [person.original, person]));
  return resolutionPlan.sourceInconsistencies.filter((entry) => entry.type === 'INCONSISTENT_SERVANT_LIST').map((conflict) => {
    const rows = parsedRows.filter((row) => row.sector === conflict.sector && row.meeting === conflict.meeting && row.grade === conflict.grade && row.group === conflict.group);
    const sets = new Map();
    rows.forEach((row) => {
      const names = unique(row.servants).sort((a, b) => a.localeCompare(b, 'ar'));
      const signature = names.join(' | ');
      if (!sets.has(signature)) sets.set(signature, { names, rows: [], ids: [] });
      const set = sets.get(signature); set.rows.push(row.rowNumber); set.ids = unique([...set.ids, ...names.map((name) => matches.get(name)?.matchedId).filter(Boolean)]).sort();
    });
    const setEntries = [...sets.values()].map((set, index) => ({ label: `SET_${index + 1}`, ...set }));
    const idSignatures = unique(setEntries.map((set) => set.ids.join('|')));
    return {
      conflictKey: stableKey('church-service-servant-conflict', `${conflict.sector}\u001f${conflict.meeting}\u001f${conflict.grade}\u001f${conflict.group}`),
      sector: conflict.sector, meeting: conflict.meeting, grade: conflict.grade, groupName: conflict.group,
      candidateServantSets: setEntries.map((set) => `${set.label}: ${join(set.names)}`).join('\n'), candidateServantIds: setEntries.map((set) => `${set.label}: ${join(set.ids)}`).join('\n'),
      sourceRowsBySet: JSON.stringify(Object.fromEntries(setEntries.map((set) => [set.label, set.rows]))), resolvedSameUsers: idSignatures.length === 1 && setEntries.every((set) => set.ids.length === set.names.length) ? 'YES' : 'NO',
      recommendedDecision: '', recommendationReason: 'Select a source set or explicitly approve a safe servant ID list; no union is assumed.', manualDecision: '', approvedServantUserIds: '', approvedSourceSet: '', notes: '', validationStatus: '', validationMessage: '',
      _sets: setEntries,
    };
  });
}

function buildWorkbookData({ resolutionPlan, sourceAssignmentPlan, parsedRows, users, meetings }) {
  const identityRows = buildIdentityRows(resolutionPlan);
  const ambiguousIdentityRows = buildIdentityRows(resolutionPlan, { includeAmbiguous: true }).filter((row) => row.currentStatus === 'AMBIGUOUS');
  const candidateKeyRows = [...identityRows, ...ambiguousIdentityRows];
  const groupRows = buildGroupRows(resolutionPlan, sourceAssignmentPlan, users, meetings);
  const duplicateAudit = buildDuplicateUserAudit({ resolutionPlan, users, meetings });
  return {
    identityRows,
    candidateRows: buildCandidateRows(resolutionPlan, candidateKeyRows, users),
    groupRows,
    servantRows: buildServantRows(resolutionPlan, sourceAssignmentPlan, parsedRows),
    aliasRows: buildGroupAliasAudit({ groupRows, sourceAssignmentPlan, meetings }),
    duplicateRows: duplicateAudit.reviews,
    duplicateDetailRows: duplicateAudit.details,
    duplicateCleanupRows: duplicateAudit.cleanup,
  };
}

module.exports = { buildIdentityRows, buildCandidateRows, buildGroupRows, buildServantRows, buildWorkbookData };
