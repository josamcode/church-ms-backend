const { cleanExactName, normalizeArabicComparison } = require('../../src/utils/arabicNormalization');
const { deriveEducation } = require('../churchServiceUsersImport/identityPlanner');
const { getEducationStageGroup } = require('../../src/constants/education');

const idOf = (value) => String(value?._id || value?.id || value || '');
const unique = (values) => [...new Set((values || []).filter((value) => value !== '' && value != null))];
const groupKey = (row) => [row.sector, row.meeting, row.grade, row.group].join('\u001f');

const EXPLICIT_GENDER = Object.freeze({
  'شابات': 'female', 'ثانوي بنات': 'female', 'اعدادي بنات': 'female',
  'شباب': 'male', 'الرجال': 'male', 'ثانوي بنين': 'male', 'اعدادي بنين': 'male',
});

function occurrenceIndex(rows) {
  const byOriginal = new Map();
  const add = (original, role, row) => {
    if (!byOriginal.has(original)) byOriginal.set(original, []);
    byOriginal.get(original).push({ role, rowNumber: row.rowNumber, sector: row.sector, meeting: row.meeting, grade: row.grade, group: row.group });
  };
  rows.forEach((row) => {
    row.servants.forEach((name) => add(name, 'servant', row));
    add(row.member, 'member', row);
  });
  return byOriginal;
}

function meetingMembershipIndex(meetings) {
  const byUser = new Map();
  const touch = (userId, meeting, group, kind) => {
    const id = idOf(userId);
    if (!id) return;
    if (!byUser.has(id)) byUser.set(id, { meetings: new Set(), memberGroups: [], servantGroups: [] });
    const entry = byUser.get(id);
    entry.meetings.add(meeting.name);
    entry[kind].push({ meetingId: idOf(meeting), meeting: meeting.name, group: cleanExactName(group) });
  };
  meetings.forEach((meeting) => {
    (meeting.servedUserIds || []).forEach((id) => touch(id, meeting, '', 'memberGroups'));
    (meeting.groupAssignments || []).forEach((assignment) => (assignment.servedUserIds || []).forEach((id) => touch(id, meeting, assignment.group, 'memberGroups')));
    (meeting.servants || []).forEach((servant) => {
      touch(servant.userId, meeting, '', 'servantGroups');
      (servant.groupAssignments || []).forEach((assignment) => (assignment.servedUserIds || []).forEach((id) => touch(id, meeting, assignment.group, 'memberGroups')));
      unique([...(servant.groupsManaged || []), ...(servant.groupAssignments || []).map((assignment) => assignment.group)])
        .forEach((group) => touch(servant.userId, meeting, group, 'servantGroups'));
    });
  });
  return byUser;
}

function contextsFor(person, index) {
  const occurrences = index.get(person.original) || [];
  return {
    occurrences,
    meetings: unique(occurrences.map((entry) => entry.meeting)),
    groups: unique(occurrences.map((entry) => entry.group)),
    grades: unique(occurrences.map((entry) => entry.grade)),
  };
}

function fuzzyCandidates(normalizedName, users, limit = 5) {
  const source = normalizedName.split(' ').filter(Boolean);
  if (source.length < 2) return [];
  return users.map((user) => {
    const candidateNormalized = normalizeArabicComparison(user.fullName);
    const candidate = candidateNormalized.split(' ').filter(Boolean);
    const intersection = source.filter((token) => candidate.includes(token));
    let consecutive = 0;
    for (let i = 0; i < source.length; i += 1) {
      for (let j = 0; j < candidate.length; j += 1) {
        let count = 0;
        while (source[i + count] && source[i + count] === candidate[j + count]) count += 1;
        consecutive = Math.max(consecutive, count);
      }
    }
    const score = (intersection.length / new Set([...source, ...candidate]).size) * 70 + Math.min(consecutive, 3) * 10;
    return { id: idOf(user), name: user.fullName, supportingTokens: unique(intersection), score: Math.round(score), reason: `${intersection.length} shared token(s); longest consecutive sequence ${consecutive}` };
  }).filter((entry) => entry.supportingTokens.length >= 2).sort((a, b) => b.score - a.score || a.name.localeCompare(b.name, 'ar')).slice(0, limit);
}

function diagnoseMissing(sourcePlan, occurrenceByOriginal, users, priorUsersPlan) {
  const priorByNormalized = new Map((priorUsersPlan?.identities || []).map((identity) => [identity.normalizedName, identity]));
  return sourcePlan.peopleMatches.filter((person) => person.status === 'MISSING').map((person) => {
    const context = contextsFor(person, occurrenceByOriginal);
    const prior = priorByNormalized.get(person.normalizedName);
    const fuzzy = fuzzyCandidates(person.normalizedName, users);
    const invalid = cleanExactName(person.original).length < 2;
    const knownHomonym = prior?.classification === 'MISSING_POTENTIAL_HOMONYM' || prior?.operation === 'POTENTIAL_HOMONYM';
    let classification = 'SAFE_NEW_USER_AFTER_REVIEW';
    if (invalid) classification = 'INVALID_NAME';
    else if (knownHomonym && (prior.homonymReasons || []).length) classification = 'MANUAL_IDENTITY_SPLIT_REQUIRED';
    else if (knownHomonym) classification = 'POTENTIAL_HOMONYM';
    else if (fuzzy[0]?.score >= 70) classification = 'POSSIBLE_EXISTING_USER';
    const safe = classification === 'SAFE_NEW_USER_AFTER_REVIEW';
    const reason = invalid ? 'Name violates the User minimum full-name length.'
      : knownHomonym ? `Excluded from missing-user creation as a potential homonym: ${(prior.homonymReasons || prior.blockers || []).join(' | ')}`
        : fuzzy.length ? 'No exact/normalized match; partial candidates require human identity verification.'
          : 'No exact/normalized or meaningful token candidate was found; manual review is still required.';
    return {
      original: person.original, normalizedName: person.normalizedName, role: person.role,
      meetings: context.meetings, groups: context.groups, grades: context.grades, rows: person.rows,
      reasonNotCreated: reason, knownPotentialHomonym: Boolean(knownHomonym), invalid,
      fuzzyCandidates: fuzzy, safeToCreateAfterReview: safe, classification,
      recommendedAction: invalid ? 'Correct the source name and regenerate the plan.'
        : knownHomonym ? 'Manually split or identify each occurrence, then map each identity explicitly.'
          : fuzzy.length ? 'Compare the listed users and enter an approved ID only with authoritative evidence.'
            : 'Confirm this is one real person, then use the separate missing-user review workflow.',
    };
  });
}

function sourceGender(occurrences) {
  const evidence = unique(occurrences.filter((entry) => entry.role === 'member').map((entry) => EXPLICIT_GENDER[entry.meeting]).filter(Boolean));
  return { gender: evidence.length === 1 ? evidence[0] : '', contradictory: evidence.length > 1, evidence };
}

function candidateDetails(user, memberships) {
  const member = memberships?.memberGroups || [];
  const servant = memberships?.servantGroups || [];
  return {
    id: idOf(user), fullName: user.fullName, gender: user.gender || '', birthDate: user.birthDate || '', ageGroup: user.ageGroup || '',
    education: user.education || null, meetings: unique([...(memberships?.meetings || [])]),
    memberGroups: member, servantGroups: servant, familyName: user.familyName || '', houseName: user.houseName || '',
    importMetadata: user.customDetails || {}, isDeleted: Boolean(user.isDeleted), accountStatus: user.accountStatus || '', role: user.role || '',
  };
}

function analyzeAmbiguous(sourcePlan, occurrenceByOriginal, users, membershipByUser) {
  return sourcePlan.peopleMatches.filter((person) => person.status === 'AMBIGUOUS').map((person) => {
    const context = contextsFor(person, occurrenceByOriginal);
    const gender = sourceGender(context.occurrences);
    const sourceEducation = deriveEducation(context.occurrences);
    const exactCandidates = users.filter((user) => cleanExactName(user.fullName) === cleanExactName(person.original));
    const normalizedCandidates = users.filter((user) => normalizeArabicComparison(user.fullName) === person.normalizedName);
    const candidateUsers = person.matchMethod === 'EXACT' && exactCandidates.length ? exactCandidates : normalizedCandidates;
    const candidates = candidateUsers.map((user) => candidateDetails(user, membershipByUser.get(idOf(user))));
    const eliminated = new Map();
    candidates.forEach((candidate) => {
      const reasons = [];
      if (candidate.isDeleted) reasons.push('deleted candidate');
      if (gender.gender && candidate.gender && candidate.gender !== gender.gender) reasons.push(`gender ${candidate.gender} conflicts with explicit member context ${gender.gender}`);
      const sourceStageGroup = getEducationStageGroup(sourceEducation.education?.stage);
      const candidateStageGroup = getEducationStageGroup(candidate.education?.stage);
      if (sourceStageGroup && candidateStageGroup && sourceStageGroup !== candidateStageGroup) reasons.push(`education stage group ${candidateStageGroup} conflicts with source stage group ${sourceStageGroup}`);
      if (reasons.length) eliminated.set(candidate.id, reasons);
    });
    let viable = candidates.filter((candidate) => !eliminated.has(candidate.id));
    let recommendationReason = '';
    let confidence = 'NONE';
    if (viable.length === 1 && candidates.length > 1) {
      recommendationReason = `All other candidates are impossible: ${[...eliminated.entries()].map(([id, reasons]) => `${id} (${reasons.join('; ')})`).join(' | ')}`;
      confidence = 'DETERMINISTIC';
    } else if (viable.length > 1) {
      const exactAssignments = viable.filter((candidate) => context.occurrences.some((occurrence) => candidate.memberGroups.some((membership) =>
        membership.meeting === occurrence.meeting && normalizeArabicComparison(membership.group) === normalizeArabicComparison(occurrence.group))));
      if (exactAssignments.length === 1) {
        viable = exactAssignments;
        recommendationReason = 'Exactly one viable candidate already has the exact meeting/group assignment; no contradictory evidence was found.';
        confidence = 'DETERMINISTIC_ASSIGNMENT';
      }
    }
    const recommended = viable.length === 1 ? viable[0] : null;
    return {
      original: person.original, normalizedName: person.normalizedName, role: person.role,
      meetings: context.meetings, groups: context.groups, grades: context.grades, rows: person.rows,
      candidates, ambiguityReason: `${person.candidateCount} active database records matched by ${person.matchMethod || 'normalized full name'}`,
      sourceGender: gender.gender, sourceGenderEvidence: gender.evidence, sourceEducation: sourceEducation.education || null,
      eliminatedCandidates: Object.fromEntries(eliminated), recommendedCandidateId: recommended?.id || '',
      recommendationReason, confidence, automaticallyResolvable: Boolean(recommended && confidence.startsWith('DETERMINISTIC')),
    };
  });
}

function existingGroupMaps(meetings) {
  const members = new Map();
  const servants = new Map();
  const meetingMembers = new Map();
  const add = (map, meetingId, userId, group) => {
    const key = `${meetingId}\u001f${idOf(userId)}`;
    if (!map.has(key)) map.set(key, new Set());
    if (group) map.get(key).add(cleanExactName(group));
  };
  meetings.forEach((meeting) => {
    const meetingId = idOf(meeting);
    (meeting.servedUserIds || []).forEach((id) => meetingMembers.set(`${meetingId}\u001f${idOf(id)}`, true));
    (meeting.groupAssignments || []).forEach((assignment) => (assignment.servedUserIds || []).forEach((id) => { add(members, meetingId, id, assignment.group); meetingMembers.set(`${meetingId}\u001f${idOf(id)}`, true); }));
    (meeting.servants || []).forEach((servant) => {
      unique([...(servant.groupsManaged || []), ...(servant.groupAssignments || []).map((entry) => entry.group)]).forEach((group) => add(servants, meetingId, servant.userId, group));
      (servant.groupAssignments || []).forEach((assignment) => (assignment.servedUserIds || []).forEach((id) => { add(members, meetingId, id, assignment.group); meetingMembers.set(`${meetingId}\u001f${idOf(id)}`, true); }));
    });
  });
  return { members, servants, meetingMembers };
}

function analyzeAssignments(sourcePlan, rows, meetings) {
  const people = new Map(sourcePlan.peopleMatches.map((person) => [person.original, person]));
  const groupsByKey = new Map(sourcePlan.groups.map((group) => [group.sourceKey, group]));
  const sourceGroups = new Map();
  rows.forEach((row) => { const key = groupKey(row); if (!sourceGroups.has(key)) sourceGroups.set(key, []); sourceGroups.get(key).push(row); });
  const existing = existingGroupMaps(meetings);
  const resolvedSourceGroups = new Map();
  sourceGroups.forEach((groupRows, key) => {
    const group = groupsByKey.get(key);
    groupRows.forEach((row) => {
      const match = people.get(row.member);
      if (!match?.matchedId || !group?.meetingId) return;
      const userKey = `${group.meetingId}\u001f${match.matchedId}`;
      if (!resolvedSourceGroups.has(userKey)) resolvedSourceGroups.set(userKey, new Set());
      resolvedSourceGroups.get(userKey).add(group.targetGroupName);
    });
  });
  const conflicts = [];
  const impacts = [];
  const reconciliation = { originalPlanServantAdds: sourcePlan.totals?.plannedServantAssignments || 0, originalPlanMemberAdds: sourcePlan.totals?.plannedMemberAssignments || 0, servantSourceOccurrences: 0, servantUnresolvedOccurrences: 0, servantUnresolvedUniqueAssignments: 0, servantResolvedUniqueAssignments: 0, servantRepeatedOccurrences: 0, servantSafeAdds: 0, servantNoOps: 0, servantBlocked: 0, servantBlockedAssignments: 0, memberSourceRows: rows.length, memberUnresolvedRows: 0, memberUnresolvedUniqueAssignments: 0, memberResolvedUniqueAssignments: 0, memberDuplicateRows: 0, memberSafeAdds: 0, memberNoOps: 0, memberBlocked: 0, memberBlockedAssignments: 0, multipleExcelGroupUsers: 0 };
  reconciliation.multipleExcelGroupUsers = [...resolvedSourceGroups.values()].filter((set) => set.size > 1).length;

  for (const [key, groupRows] of sourceGroups) {
    const group = groupsByKey.get(key);
    const servantOccurrences = groupRows.flatMap((row) => row.servants.map((name) => ({ name, row: row.rowNumber })));
    reconciliation.servantSourceOccurrences += servantOccurrences.length;
    reconciliation.servantUnresolvedOccurrences += servantOccurrences.filter((entry) => !people.get(entry.name)?.matchedId).length;
    reconciliation.servantUnresolvedUniqueAssignments += unique(servantOccurrences.filter((entry) => !people.get(entry.name)?.matchedId).map((entry) => normalizeArabicComparison(entry.name))).length;
    const servantIds = unique(servantOccurrences.map((entry) => people.get(entry.name)?.matchedId).filter(Boolean));
    reconciliation.servantResolvedUniqueAssignments += servantIds.length;
    reconciliation.servantRepeatedOccurrences += servantOccurrences.filter((entry) => people.get(entry.name)?.matchedId).length - servantIds.length;
    const inconsistent = (group?.blockers || []).some((text) => text.includes('contradictory or unresolved servant lists'));
    let safeServants = 0; let blockedServants = 0; let noopServants = 0;
    servantIds.forEach((userId) => {
      const groups = existing.servants.get(`${group.meetingId}\u001f${userId}`) || new Set();
      const target = [...groups].some((name) => normalizeArabicComparison(name) === normalizeArabicComparison(group.targetGroupName));
      let classification; let disposition;
      if (target) { classification = 'SERVANT_ALREADY_ASSIGNED'; disposition = 'NO_OP'; noopServants += 1; }
      else if (inconsistent) { classification = 'SOURCE_INCONSISTENCY'; disposition = 'BLOCKING_CONFLICT'; blockedServants += 1; }
      else { classification = groups.size ? 'SERVANT_ASSIGNED_TO_DIFFERENT_GROUP' : 'SAFE_SERVANT_ADD'; disposition = groups.size ? 'WARNING_SAFE_ADDITIVE' : 'SAFE_ADDITIVE'; safeServants += 1; }
      conflicts.push({ kind: 'servant', userId, sector: group.sector, meeting: group.meeting, group: group.originalGroupName, classification, disposition, existingGroups: [...groups], rows: unique(servantOccurrences.filter((entry) => people.get(entry.name)?.matchedId === userId).map((entry) => entry.row)), details: inconsistent ? 'Contradictory servant sets must be reviewed before servant assignment.' : '' });
    });
    reconciliation.servantSafeAdds += safeServants; reconciliation.servantNoOps += noopServants; reconciliation.servantBlocked += blockedServants;

    const memberRows = groupRows.map((row) => ({ row, match: people.get(row.member) }));
    const resolvedById = new Map();
    memberRows.forEach(({ row, match }) => {
      if (!match?.matchedId) { reconciliation.memberUnresolvedRows += 1; conflicts.push({ kind: 'member', userId: '', name: row.member, sector: group.sector, meeting: group.meeting, group: group.originalGroupName, classification: 'UNRESOLVED_IDENTITY', disposition: 'BLOCKING_CONFLICT', existingGroups: [], rows: [row.rowNumber], details: match?.status || 'MISSING' }); return; }
      if (!resolvedById.has(match.matchedId)) resolvedById.set(match.matchedId, []);
      resolvedById.get(match.matchedId).push(row.rowNumber);
    });
    reconciliation.memberResolvedUniqueAssignments += resolvedById.size;
    reconciliation.memberDuplicateRows += [...resolvedById.values()].reduce((sum, memberRowsForId) => sum + Math.max(0, memberRowsForId.length - 1), 0);
    reconciliation.memberUnresolvedUniqueAssignments += unique(memberRows.filter((entry) => !entry.match?.matchedId).map((entry) => normalizeArabicComparison(entry.row.member))).length;
    let safeMembers = 0; let blockedMembers = 0; let noopMembers = 0;
    resolvedById.forEach((memberRowsForId, userId) => {
      const mapKey = `${group.meetingId}\u001f${userId}`;
      const groups = existing.members.get(mapKey) || new Set();
      const target = [...groups].some((name) => normalizeArabicComparison(name) === normalizeArabicComparison(group.targetGroupName));
      const sourceGroupCount = resolvedSourceGroups.get(mapKey)?.size || 1;
      let classification; let disposition;
      if (target) { classification = 'EXACT_ASSIGNMENT_ALREADY_EXISTS'; disposition = 'NO_OP'; noopMembers += 1; }
      else if (groups.size) { classification = 'DIFFERENT_GROUP_IN_SAME_MEETING'; disposition = 'BLOCKING_CONFLICT'; blockedMembers += 1; }
      else if (sourceGroupCount > 1) { classification = 'MULTIPLE_EXCEL_GROUPS_SAME_MEETING'; disposition = 'BLOCKING_CONFLICT'; blockedMembers += 1; }
      else if (existing.meetingMembers.has(mapKey)) { classification = 'MEETING_MEMBERSHIP_EXISTS_GROUP_MISSING'; disposition = 'SAFE_ADDITIVE'; safeMembers += 1; }
      else { classification = 'SAFE_MEMBER_ADD'; disposition = 'SAFE_ADDITIVE'; safeMembers += 1; }
      conflicts.push({ kind: 'member', userId, sector: group.sector, meeting: group.meeting, group: group.originalGroupName, classification, disposition, existingGroups: [...groups], rows: memberRowsForId, details: sourceGroupCount > 1 ? `${sourceGroupCount} Excel groups in this meeting` : '' });
      if (memberRowsForId.length > 1) conflicts.push({ kind: 'member', userId, sector: group.sector, meeting: group.meeting, group: group.originalGroupName, classification: 'SOURCE_DUPLICATE', disposition: 'WARNING', existingGroups: [...groups], rows: memberRowsForId, details: `${memberRowsForId.length} source rows collapse to one resolved group membership` });
    });
    reconciliation.memberSafeAdds += safeMembers; reconciliation.memberNoOps += noopMembers; reconciliation.memberBlocked += blockedMembers;
    const unresolvedServants = unique(servantOccurrences.filter((entry) => !people.get(entry.name)?.matchedId).map((entry) => entry.name));
    const unresolvedMembers = unique(memberRows.filter((entry) => !entry.match?.matchedId).map((entry) => entry.row.member));
    impacts.push({
      sourceKey: key, sector: group.sector, meeting: group.meeting, grade: group.grade, group: group.originalGroupName,
      groupStatus: group.groupAction, groupOperation: group.operations.group, resolvedServants: servantIds.length, blockedServants: blockedServants + unresolvedServants.length,
      servantAdds: safeServants, servantNoOps: noopServants, resolvedMembers: resolvedById.size, blockedMembers: blockedMembers + unresolvedMembers.length,
      memberAdds: safeMembers, memberNoOps: noopMembers, membershipConflicts: blockedMembers,
      groupCreationSafe: ['CREATE', 'REUSE'].includes(group.groupAction), servantAssignmentSafe: blockedServants + unresolvedServants.length === 0,
      memberAssignmentSafe: blockedMembers + unresolvedMembers.length === 0,
      blockerReasons: unique([...(inconsistent ? ['Inconsistent servant lists'] : []), ...unresolvedServants.map((name) => `Unresolved servant: ${name}`), ...unresolvedMembers.map((name) => `Unresolved member: ${name}`), ...(blockedMembers ? [`${blockedMembers} member conflict(s)`] : [])]),
    });
  }
  const meetingsByUser = new Map();
  for (const conflict of conflicts.filter((entry) => entry.kind === 'member' && entry.userId && !['SOURCE_DUPLICATE', 'MULTIPLE_MEETINGS_ALLOWED'].includes(entry.classification))) {
    if (!meetingsByUser.has(conflict.userId)) meetingsByUser.set(conflict.userId, new Set());
    meetingsByUser.get(conflict.userId).add(conflict.meeting);
  }
  for (const [userId, sourceMeetings] of meetingsByUser) {
    if (sourceMeetings.size > 1) conflicts.push({ kind: 'member', userId, sector: '', meeting: [...sourceMeetings].join(' | '), group: '', classification: 'MULTIPLE_MEETINGS_ALLOWED', disposition: 'WARNING', existingGroups: [], rows: [], details: 'The current meeting domain permits the same person in different meetings; no move or removal is planned.' });
  }
  reconciliation.servantBlockedAssignments = reconciliation.servantBlocked + reconciliation.servantUnresolvedUniqueAssignments;
  reconciliation.memberBlockedAssignments = reconciliation.memberBlocked + reconciliation.memberUnresolvedUniqueAssignments;
  return { conflicts, impacts, reconciliation };
}

function blockerBreakdown(sourcePlan) {
  const raw = new Map();
  (sourcePlan.blockingErrors || []).forEach((entry) => raw.set(entry.type, (raw.get(entry.type) || 0) + 1));
  const sum = (...types) => types.reduce((total, type) => total + (raw.get(type) || 0), 0);
  const rows = [
    ['MISSING_PERSON_BLOCKER', sum('MISSING_USER'), 'MISSING_USER'],
    ['AMBIGUOUS_PERSON_BLOCKER', sum('AMBIGUOUS_USER'), 'AMBIGUOUS_USER'],
    ['INVALID_NAME', sum('INVALID_USER'), 'INVALID_USER'],
    ['POTENTIAL_HOMONYM', sum('POTENTIAL_HOMONYM'), 'POTENTIAL_HOMONYM'],
    ['SECTOR_MEETING_GROUP_RESOLUTION', sum('MISSING_SECTOR', 'AMBIGUOUS_SECTOR', 'MISSING_MEETING', 'AMBIGUOUS_MEETING', 'MISSING_GROUP', 'AMBIGUOUS_GROUP'), 'missing/ambiguous sector, meeting, or group'],
    ['EXISTING_MEMBERSHIP_OTHER_GROUP', sum('EXISTING_GROUP_MEMBERSHIP_CONFLICT'), 'EXISTING_GROUP_MEMBERSHIP_CONFLICT'],
    ['MULTIPLE_EXCEL_GROUPS_SAME_MEETING', sum('MULTIPLE_GROUPS_SAME_MEETING'), 'MULTIPLE_GROUPS_SAME_MEETING'],
    ['EXISTING_DATABASE_RELATIONSHIP_CONFLICT', sum('DATABASE_RELATIONSHIP_CONFLICT'), 'DATABASE_RELATIONSHIP_CONFLICT'],
    ['SERVANT_ASSIGNMENT_CONFLICT', sum('SERVANT_ASSIGNMENT_CONFLICT'), 'SERVANT_ASSIGNMENT_CONFLICT'],
    ['INCONSISTENT_SERVANT_LIST', sum('INCONSISTENT_SERVANT_LIST'), 'INCONSISTENT_SERVANT_LIST'],
    ['DUPLICATE_SOURCE_ROW_BLOCKING', sum('DUPLICATE_SOURCE_ROW'), 'DUPLICATE_SOURCE_ROW'],
    ['COUNT_MISMATCH_BLOCKING', sum('COUNT_MISMATCH', 'MEMBER_SOURCE_ROW_COUNT_MISMATCH', 'MEMBER_RESOLVED_COUNT_MISMATCH', 'SERVANT_COUNT_MISMATCH'), 'count mismatch blocker types only'],
    ['DOMAIN_SERVICE_VALIDATION_BLOCKER', sum('SERVICE_VALIDATION_FAILURE'), 'SERVICE_VALIDATION_FAILURE'],
  ].map(([type, count, notes]) => ({ type, count, severity: 'BLOCKER', notes }));
  const accounted = new Set(['MISSING_USER', 'AMBIGUOUS_USER', 'INVALID_USER', 'POTENTIAL_HOMONYM', 'MISSING_SECTOR', 'AMBIGUOUS_SECTOR', 'MISSING_MEETING', 'AMBIGUOUS_MEETING', 'MISSING_GROUP', 'AMBIGUOUS_GROUP', 'EXISTING_GROUP_MEMBERSHIP_CONFLICT', 'MULTIPLE_GROUPS_SAME_MEETING', 'DATABASE_RELATIONSHIP_CONFLICT', 'SERVANT_ASSIGNMENT_CONFLICT', 'INCONSISTENT_SERVANT_LIST', 'DUPLICATE_SOURCE_ROW', 'COUNT_MISMATCH', 'MEMBER_SOURCE_ROW_COUNT_MISMATCH', 'MEMBER_RESOLVED_COUNT_MISMATCH', 'SERVANT_COUNT_MISMATCH', 'SERVICE_VALIDATION_FAILURE']);
  const other = [...raw.entries()].filter(([type]) => !accounted.has(type)).reduce((total, [, count]) => total + count, 0);
  rows.push({ type: 'OTHER_BLOCKER', count: other, severity: 'BLOCKER', notes: other ? 'See source plan blockers' : 'No other blocker type' });
  return rows;
}

function buildResolutionAnalysis({ sourcePlan, rows, users, meetings, priorUsersPlan, databaseName, generatedAt }) {
  const occurrenceByOriginal = occurrenceIndex(rows);
  const membershipByUser = meetingMembershipIndex(meetings);
  const missing = diagnoseMissing(sourcePlan, occurrenceByOriginal, users, priorUsersPlan);
  const ambiguous = analyzeAmbiguous(sourcePlan, occurrenceByOriginal, users, membershipByUser);
  const assignments = analyzeAssignments(sourcePlan, rows, meetings);
  const breakdown = blockerBreakdown(sourcePlan);
  const countMismatchTypes = new Set(['MEMBER_SOURCE_ROW_COUNT_MISMATCH', 'MEMBER_RESOLVED_COUNT_MISMATCH', 'SERVANT_COUNT_MISMATCH', 'INCONSISTENT_DECLARED_COUNTS']);
  const sourceInconsistencies = (sourcePlan.conflicts || []).filter((entry) => entry.type === 'INCONSISTENT_SERVANT_LIST' || countMismatchTypes.has(entry.type));
  const analysis = {
    schemaVersion: 1, generatedAt, mode: 'READ_ONLY_BLOCKER_RESOLUTION', database: { name: databaseName },
    input: sourcePlan.input, sourcePlan: { path: '', checksum: sourcePlan.planChecksum, blockers: sourcePlan.blockingErrors.length },
    blockerBreakdown: breakdown, missingPeople: missing, ambiguousPeople: ambiguous,
    manualIdentityMappings: [], membershipConflicts: assignments.conflicts, groupsImpact: assignments.impacts,
    assignmentReconciliation: assignments.reconciliation, sourceInconsistencies,
    totals: {
      blockers: sourcePlan.blockingErrors.length, missingPeople: missing.length, ambiguousPeople: ambiguous.length,
      invalidNames: missing.filter((entry) => entry.classification === 'INVALID_NAME').length,
      potentialHomonyms: missing.filter((entry) => ['POTENTIAL_HOMONYM', 'MANUAL_IDENTITY_SPLIT_REQUIRED'].includes(entry.classification)).length,
      automaticallyResolvableAmbiguous: ambiguous.filter((entry) => entry.automaticallyResolvable).length,
      manualAmbiguous: ambiguous.filter((entry) => !entry.automaticallyResolvable).length,
      safeGroupsToCreate: assignments.impacts.filter((entry) => entry.groupStatus === 'CREATE' && entry.groupCreationSafe).length,
      safeGroupsToReuse: assignments.impacts.filter((entry) => entry.groupStatus === 'REUSE' && entry.groupCreationSafe).length,
      groupsBlockedServants: assignments.impacts.filter((entry) => !entry.servantAssignmentSafe).length,
      groupsBlockedMembers: assignments.impacts.filter((entry) => !entry.memberAssignmentSafe).length,
    },
    safeOperationsAvailable: assignments.reconciliation.servantSafeAdds + assignments.reconciliation.memberSafeAdds > 0,
    safeForFullApply: false,
    warnings: ['Manual identity columns remain intentionally empty.', 'Count mismatches are warnings when row-level identities are clear.', 'No database mutations were performed.'],
    blockers: sourcePlan.blockingErrors,
    planChecksum: null,
  };
  return analysis;
}

module.exports = { occurrenceIndex, meetingMembershipIndex, fuzzyCandidates, diagnoseMissing, analyzeAmbiguous, analyzeAssignments, blockerBreakdown, buildResolutionAnalysis };
