const { cleanExactName, normalizeArabicComparison } = require('../../src/utils/arabicNormalization');
const { buildNameLookup, resolveName } = require('./matching');

const idOf = (value) => String(value?._id || value?.id || value || '');
const sortedUnique = (values) => [...new Set(values.filter(Boolean))].sort();
const groupSourceKey = (row) => [row.sector, row.meeting, row.grade, row.group].join('\u001f');
const groupDomainKey = (meetingId, groupName) => `${meetingId}\u001f${normalizeArabicComparison(groupName)}`;

function existingGroupNames(meeting) {
  return sortedUnique([
    ...(meeting.groups || []),
    ...(meeting.groupAssignments || []).map((entry) => entry.group),
    ...(meeting.servants || []).flatMap((servant) => [
      ...(servant.groupsManaged || []),
      ...(servant.groupAssignments || []).map((entry) => entry.group),
    ]),
  ].map(cleanExactName));
}

function resolveExistingGroup(sourceName, meeting) {
  const names = existingGroupNames(meeting);
  const exact = names.filter((name) => name === sourceName);
  if (exact.length === 1) return { status: 'REUSE', name: exact[0], method: 'EXACT', candidates: exact };
  const normalized = normalizeArabicComparison(sourceName);
  const candidates = names.filter((name) => normalizeArabicComparison(name) === normalized);
  if (candidates.length === 1) return { status: 'REUSE', name: candidates[0], method: 'NORMALIZED', candidates };
  if (candidates.length > 1) return { status: 'AMBIGUOUS', name: '', method: 'NORMALIZED', candidates };
  return { status: 'CREATE', name: sourceName, method: '', candidates: [] };
}

function aggregatePeople(rows) {
  const people = new Map();
  const add = (name, role, rowNumber) => {
    const original = String(name ?? '').normalize('NFKC').trim();
    if (!people.has(original)) people.set(original, { original, roles: new Set(), rows: new Set() });
    const person = people.get(original);
    person.roles.add(role);
    person.rows.add(rowNumber);
  };
  for (const row of rows) {
    row.servants.forEach((name) => add(name, 'servant', row.rowNumber));
    add(row.member, 'member', row.rowNumber);
  }
  return people;
}

function candidateSummary(candidates) {
  return (candidates || []).map((record) => ({ id: idOf(record), name: record.fullName || record.name || '' }));
}

function buildPeopleMatches(rows, users) {
  const lookup = buildNameLookup(users);
  const aggregate = aggregatePeople(rows);
  const matches = [];
  const byOriginal = new Map();
  for (const person of aggregate.values()) {
    const resolution = resolveName(person.original, lookup);
    const matched = resolution.matched;
    const record = {
      role: person.roles.size === 2 ? 'both' : [...person.roles][0],
      original: person.original,
      normalizedName: resolution.normalizedName,
      rows: [...person.rows].sort((a, b) => a - b),
      status: resolution.status,
      matchedId: matched ? idOf(matched) : '',
      matchedName: matched?.fullName || '',
      matchMethod: resolution.matchMethod,
      accountStatus: matched?.accountStatus || '',
      systemRole: matched?.role || '',
      candidateCount: resolution.candidates.length,
      candidates: candidateSummary(resolution.candidates),
      notes: matched?.isLocked ? 'Account is locked' : matched?.accountStatus && matched.accountStatus !== 'approved' ? `Account status is ${matched.accountStatus}` : '',
    };
    matches.push(record);
    byOriginal.set(person.original, record);
  }
  matches.sort((a, b) => a.original.localeCompare(b.original, 'ar'));
  return { matches, byOriginal };
}

function resolveScopedName(value, records, nameSelector) {
  return resolveName(value, buildNameLookup(records, nameSelector));
}

function numericValues(rows, field) {
  return sortedUnique(rows.map((row) => normalizeArabicComparison(row[field])).filter(Boolean));
}

function membersInMeetingGroups(meeting) {
  const map = new Map();
  const add = (group, ids) => {
    for (const id of ids || []) {
      const key = idOf(id);
      if (!map.has(key)) map.set(key, new Set());
      map.get(key).add(cleanExactName(group));
    }
  };
  (meeting.groupAssignments || []).forEach((entry) => add(entry.group, entry.servedUserIds));
  (meeting.servants || []).forEach((servant) =>
    (servant.groupAssignments || []).forEach((entry) => add(entry.group, entry.servedUserIds))
  );
  return map;
}

function servantGroups(meeting) {
  const map = new Map();
  for (const servant of meeting.servants || []) {
    const servantId = idOf(servant.userId);
    if (!servantId) continue;
    map.set(servantId, new Set([
      ...(servant.groupsManaged || []),
      ...(servant.groupAssignments || []).map((entry) => entry.group),
    ].map(cleanExactName)));
  }
  return map;
}

function makeConflict(type, severity, data, message) {
  return { type, severity, ...data, message };
}

function buildImportPlan({ parsed, users, sectors, meetings, databaseName, inputPath, inputHash, generatedAt }) {
  const { matches: peopleMatches, byOriginal: peopleByOriginal } = buildPeopleMatches(parsed.rows, users);
  const conflicts = [];
  for (const person of peopleMatches) {
    if (['MISSING', 'AMBIGUOUS', 'INVALID'].includes(person.status)) {
      conflicts.push(makeConflict(`${person.status}_USER`, 'BLOCKER', { rows: person.rows, name: person.original, role: person.role }, `${person.status} user: ${person.original}`));
    } else if (person.notes) {
      conflicts.push(makeConflict('ACCOUNT_STATUS_WARNING', 'WARNING', { rows: person.rows, name: person.original, role: person.role }, person.notes));
    }
  }

  const sectorLookup = buildNameLookup(sectors, (record) => record.name);
  const sourceGroups = new Map();
  for (const row of parsed.rows) {
    const key = groupSourceKey(row);
    if (!sourceGroups.has(key)) sourceGroups.set(key, { key, sector: row.sector, meeting: row.meeting, grade: row.grade, originalGroupName: row.group, rows: [] });
    sourceGroups.get(key).rows.push(row);
  }

  const groupPlans = [];
  const resolvedSectorMap = new Map();
  const resolvedMeetingMap = new Map();
  for (const sourceGroup of sourceGroups.values()) {
    const context = { sector: sourceGroup.sector, meeting: sourceGroup.meeting, grade: sourceGroup.grade, group: sourceGroup.originalGroupName, rows: sourceGroup.rows.map((row) => row.rowNumber) };
    const warnings = [];
    const blockers = [];
    const sectorResolution = resolveName(sourceGroup.sector, sectorLookup);
    let sector = sectorResolution.matched;
    if (!sector || !['EXACT_MATCH', 'NORMALIZED_MATCH'].includes(sectorResolution.status)) {
      const message = `${sectorResolution.status} sector: ${sourceGroup.sector}`;
      blockers.push(message);
      conflicts.push(makeConflict(`${sectorResolution.status}_SECTOR`, 'BLOCKER', context, message));
    } else {
      resolvedSectorMap.set(idOf(sector), { id: idOf(sector), name: sector.name, sourceName: sourceGroup.sector, method: sectorResolution.matchMethod });
    }

    const scopedMeetings = sector ? meetings.filter((meeting) => idOf(meeting.sectorId) === idOf(sector)) : [];
    const meetingResolution = resolveScopedName(sourceGroup.meeting, scopedMeetings, (record) => record.name);
    const meeting = meetingResolution.matched;
    if (!meeting || !['EXACT_MATCH', 'NORMALIZED_MATCH'].includes(meetingResolution.status)) {
      const message = `${meetingResolution.status} meeting: ${sourceGroup.meeting}`;
      blockers.push(message);
      conflicts.push(makeConflict(`${meetingResolution.status}_MEETING`, 'BLOCKER', context, message));
    } else {
      resolvedMeetingMap.set(idOf(meeting), { id: idOf(meeting), name: meeting.name, sectorId: idOf(meeting.sectorId), sourceName: sourceGroup.meeting, method: meetingResolution.matchMethod });
    }

    const groupResolution = meeting ? resolveExistingGroup(sourceGroup.originalGroupName, meeting) : { status: 'BLOCKED', name: '', method: '', candidates: [] };
    if (groupResolution.status === 'AMBIGUOUS') {
      const message = `Multiple existing groups normalize to ${sourceGroup.originalGroupName}: ${groupResolution.candidates.join(', ')}`;
      blockers.push(message);
      conflicts.push(makeConflict('AMBIGUOUS_GROUP', 'BLOCKER', context, message));
    }
    const targetGroupName = groupResolution.name || sourceGroup.originalGroupName;
    if (targetGroupName.length > 120) {
      const message = `Group name exceeds the meeting schema maximum of 120 characters (${targetGroupName.length})`;
      blockers.push(message);
      conflicts.push(makeConflict('SERVICE_VALIDATION_FAILURE', 'BLOCKER', context, message));
    }

    const rawServantSignatures = sortedUnique(sourceGroup.rows.map((row) => sortedUnique(row.servants).join('|')));
    const resolvedServantSets = [];
    let hasUnresolvedServant = false;
    for (const row of sourceGroup.rows) {
      const ids = [];
      for (const original of row.servants) {
        const person = peopleByOriginal.get(original);
        if (!person?.matchedId) hasUnresolvedServant = true;
        else ids.push(person.matchedId);
      }
      resolvedServantSets.push(sortedUnique(ids));
    }
    const resolvedServantSignatures = sortedUnique(resolvedServantSets.map((ids) => ids.join('|')));
    if (rawServantSignatures.length > 1) {
      if (!hasUnresolvedServant && resolvedServantSignatures.length === 1) {
        const message = `Inconsistent servant spellings safely resolve to the same ${resolvedServantSets[0].length} user IDs`;
        warnings.push(message);
        conflicts.push(makeConflict('INCONSISTENT_SERVANT_SPELLING', 'WARNING', context, message));
      } else {
        const message = 'Repeated rows contain contradictory or unresolved servant lists';
        blockers.push(message);
        conflicts.push(makeConflict('INCONSISTENT_SERVANT_LIST', 'BLOCKER', context, message));
      }
    }
    const servantIds = sortedUnique(resolvedServantSets.flat());
    const servantVariantsById = {};
    for (const row of sourceGroup.rows) {
      for (const original of row.servants) {
        const id = peopleByOriginal.get(original)?.matchedId;
        if (!id) continue;
        if (!servantVariantsById[id]) servantVariantsById[id] = [];
        servantVariantsById[id].push(original);
      }
    }
    Object.keys(servantVariantsById).forEach((id) => { servantVariantsById[id] = sortedUnique(servantVariantsById[id]); });

    const memberOccurrences = new Map();
    const sourceMemberOccurrences = new Map();
    for (const row of sourceGroup.rows) {
      const sourceMemberKey = cleanExactName(row.member);
      if (!sourceMemberOccurrences.has(sourceMemberKey)) sourceMemberOccurrences.set(sourceMemberKey, []);
      sourceMemberOccurrences.get(sourceMemberKey).push(row.rowNumber);
      const match = peopleByOriginal.get(row.member);
      if (!match?.matchedId) continue;
      if (!memberOccurrences.has(match.matchedId)) memberOccurrences.set(match.matchedId, []);
      memberOccurrences.get(match.matchedId).push(row.rowNumber);
    }
    for (const [sourceMemberName, rows] of sourceMemberOccurrences) {
      if (rows.length > 1) {
        const message = `Source member row is duplicated ${rows.length} times: ${sourceMemberName}`;
        warnings.push(message);
        conflicts.push(makeConflict('DUPLICATE_SOURCE_ROW', 'WARNING', { ...context, rows, name: sourceMemberName }, message));
      }
    }
    for (const [memberId, rows] of memberOccurrences) {
      if (rows.length > 1) {
        const message = `Resolved member ${memberId} appears ${rows.length} times in the same source group`;
        warnings.push(message);
        conflicts.push(makeConflict('DUPLICATE_MEMBER_ROWS', 'WARNING', { ...context, rows }, message));
      }
    }
    const memberIds = sortedUnique([...memberOccurrences.keys()]);

    const declaredServants = numericValues(sourceGroup.rows, 'declaredServants');
    const declaredMembers = numericValues(sourceGroup.rows, 'declaredMembers');
    if (declaredServants.length > 1 || declaredMembers.length > 1) {
      const message = `Declared counts vary across rows (servants: ${declaredServants.join('/') || 'blank'}, members: ${declaredMembers.join('/') || 'blank'})`;
      warnings.push(message);
      conflicts.push(makeConflict('INCONSISTENT_DECLARED_COUNTS', 'WARNING', context, message));
    }
    const declaredServantNumber = declaredServants.length === 1 && /^\d+$/.test(declaredServants[0]) ? Number(declaredServants[0]) : null;
    const declaredMemberNumber = declaredMembers.length === 1 && /^\d+$/.test(declaredMembers[0]) ? Number(declaredMembers[0]) : null;
    if (declaredServantNumber != null && declaredServantNumber !== servantIds.length) {
      const message = `Declared servant count ${declaredServantNumber} differs from ${servantIds.length} unique resolved servants`;
      warnings.push(message);
      conflicts.push(makeConflict('SERVANT_COUNT_MISMATCH', 'WARNING', context, message));
    }
    const declaredMembersMatchSourceRows = declaredMembers.length === 1
      && declaredMemberNumber != null
      && declaredMemberNumber === sourceGroup.rows.length;
    if (declaredMembers.length && !declaredMembersMatchSourceRows) {
      const message = `Declared member count(s) ${declaredMembers.join('/')} differ from ${sourceGroup.rows.length} source member rows`;
      warnings.push(message);
      conflicts.push(makeConflict('MEMBER_SOURCE_ROW_COUNT_MISMATCH', 'WARNING', context, message));
    }
    const declaredMembersMatchResolved = declaredMembers.length === 1
      && declaredMemberNumber != null
      && declaredMemberNumber === memberIds.length;
    if (declaredMembers.length && !declaredMembersMatchResolved) {
      const message = `Declared member count(s) ${declaredMembers.join('/')} differ from ${memberIds.length} unique resolved members`;
      warnings.push(message);
      conflicts.push(makeConflict('MEMBER_RESOLVED_COUNT_MISMATCH', 'WARNING', context, message));
    }

    const existingMemberGroups = meeting ? membersInMeetingGroups(meeting) : new Map();
    const existingServantGroups = meeting ? servantGroups(meeting) : new Map();
    let memberAdds = 0;
    let memberNoOps = 0;
    for (const memberId of memberIds) {
      const groups = existingMemberGroups.get(memberId) || new Set();
      const targetMatch = [...groups].some((name) => normalizeArabicComparison(name) === normalizeArabicComparison(targetGroupName));
      if (targetMatch) memberNoOps += 1;
      else if (groups.size) {
        const message = `User ${memberId} is already assigned to other group(s) in this meeting: ${[...groups].join(', ')}`;
        blockers.push(message);
        conflicts.push(makeConflict('EXISTING_GROUP_MEMBERSHIP_CONFLICT', 'BLOCKER', { ...context, userId: memberId }, message));
      } else memberAdds += 1;
    }
    let servantAdds = 0;
    let servantNoOps = 0;
    for (const servantId of servantIds) {
      const groups = existingServantGroups.get(servantId) || new Set();
      if ([...groups].some((name) => normalizeArabicComparison(name) === normalizeArabicComparison(targetGroupName))) servantNoOps += 1;
      else servantAdds += 1;
    }

    if (memberIds.length !== sourceGroup.rows.length) {
      const unresolvedRows = sourceGroup.rows.filter((row) => !peopleByOriginal.get(row.member)?.matchedId).map((row) => row.rowNumber);
      if (unresolvedRows.length) blockers.push(`${unresolvedRows.length} member rows are unresolved`);
    }
    if (hasUnresolvedServant) blockers.push('One or more servants are unresolved');

    groupPlans.push({
      sourceKey: sourceGroup.key,
      domainKey: meeting ? groupDomainKey(idOf(meeting), targetGroupName) : '',
      sector: sourceGroup.sector,
      sectorId: sector ? idOf(sector) : '',
      meeting: sourceGroup.meeting,
      meetingId: meeting ? idOf(meeting) : '',
      grade: sourceGroup.grade,
      originalGroupName: sourceGroup.originalGroupName,
      normalizedGroupName: normalizeArabicComparison(sourceGroup.originalGroupName),
      targetGroupName,
      groupAction: groupResolution.status,
      existingGroupId: null,
      groupIdentityNote: 'Groups are meeting-scoped strings in the current schema; domainKey is the stable plan identifier.',
      groupMatchMethod: groupResolution.method,
      declaredServantCounts: declaredServants,
      resolvedServantIds: servantIds,
      servantVariantsById,
      declaredMemberCounts: declaredMembers,
      sourceMemberRows: sourceGroup.rows.length,
      resolvedMemberIds: memberIds,
      memberSourceRowsById: Object.fromEntries(memberOccurrences),
      operations: {
        group: groupResolution.status === 'CREATE' ? 'CREATE' : groupResolution.status === 'REUSE' ? 'REUSE' : 'BLOCKED',
        servantAssignments: { ADD: servantAdds, NO_OP: servantNoOps },
        memberAssignments: { ADD: memberAdds, NO_OP: memberNoOps },
      },
      warnings: sortedUnique(warnings),
      blockers: sortedUnique(blockers),
    });
  }

  const sourceMeetingGroups = new Map();
  const sourceUserMeetings = new Map();
  for (const group of groupPlans) {
    for (const memberId of group.resolvedMemberIds) {
      const meetingUserKey = `${group.meetingId}\u001f${memberId}`;
      if (!sourceMeetingGroups.has(meetingUserKey)) sourceMeetingGroups.set(meetingUserKey, []);
      sourceMeetingGroups.get(meetingUserKey).push(group);
      if (!sourceUserMeetings.has(memberId)) sourceUserMeetings.set(memberId, new Set());
      sourceUserMeetings.get(memberId).add(group.meetingId);
    }
  }
  for (const [key, groups] of sourceMeetingGroups) {
    const distinct = sortedUnique(groups.map((group) => group.domainKey));
    if (distinct.length > 1) {
      const [meetingId, userId] = key.split('\u001f');
      const message = `User ${userId} appears in multiple source groups in meeting ${meetingId}: ${groups.map((g) => g.originalGroupName).join(', ')}`;
      conflicts.push(makeConflict('MULTIPLE_GROUPS_SAME_MEETING', 'BLOCKER', { userId, meetingId }, message));
      groups.forEach((group) => group.blockers.push(message));
    }
  }
  for (const [userId, meetingIds] of sourceUserMeetings) {
    if (meetingIds.size > 1) {
      conflicts.push(makeConflict('MULTIPLE_MEETINGS', 'WARNING', { userId, meetingIds: [...meetingIds] }, `User ${userId} appears in ${meetingIds.size} meetings; allowed by current domain rules`));
    }
  }

  groupPlans.forEach((group) => {
    group.blockers = sortedUnique(group.blockers);
    if (group.blockers.length) {
      group.operations.group = 'BLOCKED';
      group.operations.servantAssignments.ADD = 0;
      group.operations.memberAssignments.ADD = 0;
    }
  });
  const blockingErrors = conflicts.filter((entry) => entry.severity === 'BLOCKER');
  const warnings = conflicts.filter((entry) => entry.severity === 'WARNING');
  const totals = {
    parsedRows: parsed.rows.length,
    groups: groupPlans.length,
    uniqueExactNames: peopleMatches.length,
    uniqueNormalizedNames: new Set(peopleMatches.map((person) => person.normalizedName).filter(Boolean)).size,
    exactMatches: peopleMatches.filter((person) => person.status === 'EXACT_MATCH').length,
    normalizedMatches: peopleMatches.filter((person) => person.status === 'NORMALIZED_MATCH').length,
    missingUsers: peopleMatches.filter((person) => person.status === 'MISSING').length,
    ambiguousUsers: peopleMatches.filter((person) => person.status === 'AMBIGUOUS').length,
    invalidUsers: peopleMatches.filter((person) => person.status === 'INVALID').length,
    groupsToCreate: groupPlans.filter((group) => group.groupAction === 'CREATE').length,
    groupsToReuse: groupPlans.filter((group) => group.groupAction === 'REUSE').length,
    plannedServantAssignments: groupPlans.reduce((sum, group) => sum + group.operations.servantAssignments.ADD, 0),
    plannedMemberAssignments: groupPlans.reduce((sum, group) => sum + group.operations.memberAssignments.ADD, 0),
    existingNoOpAssignments: groupPlans.reduce((sum, group) => sum + group.operations.servantAssignments.NO_OP + group.operations.memberAssignments.NO_OP, 0),
    conflicts: conflicts.length,
    blockers: blockingErrors.length,
    warnings: warnings.length,
  };
  return {
    schemaVersion: 1,
    generatedAt,
    mode: 'DRY_RUN',
    input: { path: inputPath, sha256: inputHash, sheet: parsed.sheetName },
    database: { name: databaseName },
    resolvedSectors: [...resolvedSectorMap.values()],
    resolvedMeetings: [...resolvedMeetingMap.values()],
    peopleMatches,
    groups: groupPlans,
    conflicts,
    blockingErrors,
    warnings,
    totals,
    safeToApply: blockingErrors.length === 0,
    planChecksum: null,
  };
}

function planSingleAssignment({ existingIds = [], requestedIds = [] }) {
  const existing = new Set(existingIds.map(String));
  return sortedUnique(requestedIds.map(String)).map((id) => ({ id, action: existing.has(id) ? 'NO_OP' : 'ADD' }));
}

module.exports = {
  aggregatePeople,
  buildPeopleMatches,
  buildImportPlan,
  existingGroupNames,
  resolveExistingGroup,
  planSingleAssignment,
};
