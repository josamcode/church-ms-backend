const { cleanExactName, normalizeArabicComparison } = require('../../src/utils/arabicNormalization');
const { buildNameLookup, resolveName } = require('../churchServiceImport/matching');
const { calculatePlanChecksum } = require('../churchServiceImport/integrity');
const { stableKey } = require('./workbookSchema');

const idOf = (value) => String(value?._id || value?.id || value || '');
const unique = (values) => [...new Set((values || []).filter(Boolean))];
const groupKey = (row) => [row.sector, row.meeting, row.grade, row.group].join('\u001f');

function existingMaps(meetings) {
  const members = new Map(); const servants = new Map(); const meetingMembers = new Set();
  const add = (map, meetingId, userId, group) => { const key = `${meetingId}\u001f${idOf(userId)}`; if (!map.has(key)) map.set(key, new Set()); if (group) map.get(key).add(cleanExactName(group)); };
  meetings.forEach((meeting) => {
    const meetingId = idOf(meeting);
    (meeting.servedUserIds || []).forEach((id) => meetingMembers.add(`${meetingId}\u001f${idOf(id)}`));
    (meeting.groupAssignments || []).forEach((assignment) => (assignment.servedUserIds || []).forEach((id) => { add(members, meetingId, id, assignment.group); meetingMembers.add(`${meetingId}\u001f${idOf(id)}`); }));
    (meeting.servants || []).forEach((servant) => {
      unique([...(servant.groupsManaged || []), ...(servant.groupAssignments || []).map((entry) => entry.group)]).forEach((group) => add(servants, meetingId, servant.userId, group));
      (servant.groupAssignments || []).forEach((assignment) => (assignment.servedUserIds || []).forEach((id) => { add(members, meetingId, id, assignment.group); meetingMembers.add(`${meetingId}\u001f${idOf(id)}`); }));
    });
  });
  return { members, servants, meetingMembers };
}

function buildOccurrenceResolutions({ rows, currentPlan, validation, users }) {
  const people = new Map(currentPlan.peopleMatches.map((person) => [person.original, person]));
  const identityRows = new Map(validation.identityRows.map((row) => [row.normalizedName, row]));
  const decisions = new Map(validation.decisions.identities.map((decision) => [decision.identityKey, decision]));
  const duplicateRows = new Map((validation.duplicateRows || []).map((row) => [normalizeArabicComparison(row.sourceName), row]));
  const duplicateDecisions = new Map((validation.decisions.duplicates || []).map((decision) => [decision.duplicateReviewKey, decision]));
  const lookup = buildNameLookup(users.filter((user) => !user.isDeleted));
  const results = new Map(); const missingUserReviewPlan = new Map(); const skipped = []; const identityResults = [];
  const resolveCorrected = (name) => resolveName(name, lookup);
  const resolveOccurrence = (original, role, row) => {
    const key = `${role}\u001f${row.rowNumber}\u001f${original}`;
    if (results.has(key)) return results.get(key);
    const current = people.get(original);
    if (current?.matchedId) { const result = { status: 'RESOLVED', userId: current.matchedId, method: current.matchMethod, original }; results.set(key, result); return result; }
    const duplicateReview = duplicateRows.get(normalizeArabicComparison(original));
    const duplicateDecision = duplicateReview ? duplicateDecisions.get(duplicateReview.duplicateReviewKey) : null;
    if (duplicateDecision?.decision === 'MAP_TO_CANONICAL_USER') { const result = { status: 'RESOLVED', userId: duplicateDecision.approvedCanonicalUserId, method: 'APPROVED_DUPLICATE_CANONICAL', original, duplicateReviewKey: duplicateReview.duplicateReviewKey }; results.set(key, result); return result; }
    if (duplicateDecision?.decision === 'SKIP_SOURCE_IDENTITY') { const result = { status: 'SKIPPED', original, reason: 'SKIP_SOURCE_IDENTITY', duplicateReviewKey: duplicateReview.duplicateReviewKey }; skipped.push({ duplicateReviewKey: duplicateReview.duplicateReviewKey, role, rowNumber: row.rowNumber, original, reason: result.reason }); results.set(key, result); return result; }
    if (duplicateReview) { const result = { status: 'UNRESOLVED', original, reason: duplicateDecision ? `Duplicate review decision ${duplicateDecision.decision} does not select a planning user` : 'Duplicate-user review decision is blank', duplicateReviewKey: duplicateReview.duplicateReviewKey }; results.set(key, result); return result; }
    const identity = identityRows.get(normalizeArabicComparison(original));
    const decision = identity ? decisions.get(identity.identityKey) : null;
    let result = { status: 'UNRESOLVED', original, reason: identity ? 'Manual identity decision is blank' : 'No resolution workbook identity row' };
    if (decision?.decision === 'MAP_EXISTING_USER') result = { status: 'RESOLVED', userId: decision.approvedUserId, method: 'MANUAL_MAPPING', original, identityKey: identity.identityKey };
    else if (decision?.decision === 'SKIP_INVALID_SOURCE' || (decision?.decision === 'SKIP_OCCURRENCES' && decision.rows.includes(row.rowNumber))) {
      result = { status: 'SKIPPED', original, reason: decision.decision, identityKey: identity.identityKey }; skipped.push({ identityKey: identity.identityKey, role, rowNumber: row.rowNumber, original, reason: decision.decision });
    } else if (decision?.decision === 'CORRECT_SOURCE_NAME') {
      const match = resolveCorrected(decision.correctedCanonicalName);
      if (match.matched) result = { status: 'RESOLVED', userId: idOf(match.matched), method: `CORRECTED_${match.matchMethod}`, original, correctedName: decision.correctedCanonicalName, identityKey: identity.identityKey };
      else { result = { status: 'NEW_USER_REQUIRED', original, canonicalName: decision.correctedCanonicalName, reason: `Corrected name is ${match.status}` }; missingUserReviewPlan.set(identity.identityKey, result); }
    } else if (decision?.decision === 'CREATE_NEW_PERSON') {
      result = { status: 'NEW_USER_REQUIRED', original, canonicalName: identity.sourceSpellings.split(' | ')[0], reason: 'Manually approved for future missing-user review' }; missingUserReviewPlan.set(identity.identityKey, result);
    } else if (decision?.decision === 'SPLIT_SOURCE_IDENTITY') {
      const part = decision.parts.find((entry) => entry.rows.includes(row.rowNumber));
      if (!part) result = { status: 'UNRESOLVED', original, reason: 'No split part covers this row' };
      else {
        const canonicalName = part.canonicalName || original;
        const match = resolveCorrected(canonicalName);
        if (match.matched) result = { status: 'RESOLVED', userId: idOf(match.matched), method: `SPLIT_${match.matchMethod}`, original, splitIdentityKey: part.identityKey };
        else { result = { status: 'NEW_USER_REQUIRED', original, canonicalName, reason: `Split identity is ${match.status}`, splitIdentityKey: part.identityKey }; missingUserReviewPlan.set(part.identityKey, result); }
      }
    }
    results.set(key, result); return result;
  };
  rows.forEach((row) => { row.servants.forEach((name) => resolveOccurrence(name, 'servant', row)); resolveOccurrence(row.member, 'member', row); });
  validation.identityRows.forEach((identity) => {
    const decision = decisions.get(identity.identityKey);
    const occurrenceResults = [...results.entries()].filter(([key]) => key.endsWith(`\u001f${identity.sourceSpellings.split(' | ')[0]}`) || identity.sourceSpellings.split(' | ').some((name) => key.endsWith(`\u001f${name}`))).map(([, value]) => value.status);
    identityResults.push({ identityKey: identity.identityKey, normalizedName: identity.normalizedName, manualDecision: decision?.decision || '', result: decision ? unique(occurrenceResults).join(' | ') : 'UNRESOLVED', message: decision ? '' : 'Blank decision remains a blocker' });
  });
  return { resolveOccurrence, results, skipped, missingUserReviewPlan: [...missingUserReviewPlan.entries()].map(([identityKey, entry]) => ({ identityKey, ...entry })), identityResults };
}

function buildResolutionAwarePlan({ parsed, currentPlan, validation, users, meetings, workbookPath, workbookHash, databaseFingerprint, generatedAt }) {
  const occurrence = buildOccurrenceResolutions({ rows: parsed.rows, currentPlan, validation, users });
  const existing = existingMaps(meetings);
  const groupDecisions = new Map(validation.decisions.groups.map((entry) => [entry.conflictKey, entry]));
  const servantDecisions = new Map(validation.decisions.servants.map((entry) => [entry.conflictKey, entry]));
  const aliasDecisions = new Map((validation.decisions.aliases || []).map((entry) => [entry.aliasKey, entry]));
  const duplicateDecisions = new Map((validation.decisions.duplicates || []).map((entry) => [entry.duplicateReviewKey, entry]));
  const baseGroups = new Map(currentPlan.groups.map((group) => [group.sourceKey, group]));
  const sourceGroups = new Map();
  parsed.rows.forEach((row) => { const key = groupKey(row); if (!sourceGroups.has(key)) sourceGroups.set(key, []); sourceGroups.get(key).push(row); });
  const memberSourceGroups = new Map();
  const aliasRows = validation.aliasRows || [];
  const aliasForPair = (meetingId, names) => {
    const normalized = names.map(normalizeArabicComparison).sort();
    return aliasRows.find((row) => row.meetingId === meetingId && [normalizeArabicComparison(row.firstGroupName), normalizeArabicComparison(row.secondGroupName)].sort().every((name, index) => name === normalized[index]));
  };
  const canonicalGroupName = (meetingId, name) => {
    const row = aliasRows.find((entry) => entry.meetingId === meetingId && [entry.firstGroupName, entry.secondGroupName].some((candidate) => normalizeArabicComparison(candidate) === normalizeArabicComparison(name)) && aliasDecisions.get(entry.aliasKey)?.decision === 'SAME_GROUP_ALIAS');
    return row ? aliasDecisions.get(row.aliasKey).canonicalGroupName : name;
  };
  sourceGroups.forEach((groupRows, key) => {
    const group = baseGroups.get(key);
    groupRows.forEach((row) => {
      const resolution = occurrence.resolveOccurrence(row.member, 'member', row);
      if (resolution.status !== 'RESOLVED') return;
      const userKey = `${group.meetingId}\u001f${resolution.userId}`;
      if (!memberSourceGroups.has(userKey)) memberSourceGroups.set(userKey, new Set());
      memberSourceGroups.get(userKey).add(canonicalGroupName(group.meetingId, group.targetGroupName));
    });
  });
  const remainingBlockers = []; const decisionsAudit = []; const groups = [];
  const addBlocker = (type, data, message) => remainingBlockers.push({ type, severity: 'BLOCKER', ...data, message });
  validation.identityRows.forEach((row) => { if (!validation.decisions.identities.some((decision) => decision.identityKey === row.identityKey)) addBlocker('UNRESOLVED_IDENTITY_DECISION', { identityKey: row.identityKey }, `Identity decision is blank: ${row.normalizedName}`); });
  (validation.duplicateRows || []).forEach((row) => { if (!duplicateDecisions.has(row.duplicateReviewKey)) addBlocker('UNRESOLVED_DUPLICATE_USER_DECISION', { duplicateReviewKey: row.duplicateReviewKey, identityKey: row.identityKey }, 'Duplicate-user decision is blank'); });
  aliasRows.forEach((row) => { if (!aliasDecisions.has(row.aliasKey)) addBlocker('UNRESOLVED_GROUP_ALIAS_DECISION', { aliasKey: row.aliasKey, meetingId: row.meetingId }, 'Group-alias decision is blank'); });
  validation.groupRows.forEach((row) => {
    const alias = aliasForPair(row.meetingId, String(row.sourceGroups).split(' | ').filter(Boolean));
    const collapsed = alias && aliasDecisions.get(alias.aliasKey)?.decision === 'SAME_GROUP_ALIAS';
    if (!collapsed && !groupDecisions.has(row.conflictKey)) addBlocker('UNRESOLVED_GROUP_DECISION', { conflictKey: row.conflictKey, userId: row.userId, meetingId: row.meetingId }, 'Group conflict decision is blank');
  });
  validation.servantRows.forEach((row) => { if (!servantDecisions.has(row.conflictKey)) addBlocker('UNRESOLVED_SERVANT_DECISION', { conflictKey: row.conflictKey }, 'Servant conflict decision is blank'); });

  const plannedMemberKeys = new Set(); const plannedServantKeys = new Set(); const plannedGroupKeys = new Set();
  const meetingsById = new Map(meetings.map((meeting) => [idOf(meeting), meeting]));
  for (const [key, groupRows] of sourceGroups) {
    const base = baseGroups.get(key);
    const effectiveGroupName = canonicalGroupName(base.meetingId, base.targetGroupName);
    const servantConflictKey = stableKey('church-service-servant-conflict', `${base.sector}\u001f${base.meeting}\u001f${base.grade}\u001f${base.originalGroupName}`);
    const servantWorkbookRow = validation.servantRows.find((row) => row.conflictKey === servantConflictKey);
    const servantDecision = servantDecisions.get(servantConflictKey);
    let requestedServants = [];
    const servantUnresolved = [];
    if (servantWorkbookRow) {
      if (servantDecision?.decision === 'KEEP_EXISTING_SERVANTS' || servantDecision?.decision === 'SKIP_SERVANT_ASSIGNMENTS') requestedServants = [];
      else if (servantDecision?.approvedServantUserIds) requestedServants = servantDecision.approvedServantUserIds;
      else servantUnresolved.push('Servant-list conflict remains unresolved');
    } else {
      groupRows.forEach((row) => row.servants.forEach((name) => {
        const resolved = occurrence.resolveOccurrence(name, 'servant', row);
        if (resolved.status === 'RESOLVED') requestedServants.push(resolved.userId);
        else if (resolved.status !== 'SKIPPED') servantUnresolved.push(`${name} row ${row.rowNumber}: ${resolved.reason}`);
      }));
    }
    requestedServants = unique(requestedServants);
    let servantAdds = 0; let servantNoOps = 0;
    requestedServants.forEach((userId) => {
      const groupsForUser = existing.servants.get(`${base.meetingId}\u001f${userId}`) || new Set();
      if ([...groupsForUser].some((name) => normalizeArabicComparison(name) === normalizeArabicComparison(effectiveGroupName))) servantNoOps += 1;
      else { const operationKey = `${base.meetingId}\u001f${normalizeArabicComparison(effectiveGroupName)}\u001f${userId}`; if (!plannedServantKeys.has(operationKey)) { plannedServantKeys.add(operationKey); servantAdds += 1; } }
    });
    const requestedMembers = new Set(); const memberSkipped = []; const memberUnresolved = [];
    groupRows.forEach((row) => {
      const resolved = occurrence.resolveOccurrence(row.member, 'member', row);
      if (resolved.status === 'SKIPPED') { memberSkipped.push({ row: row.rowNumber, name: row.member, reason: resolved.reason }); return; }
      if (resolved.status !== 'RESOLVED') { memberUnresolved.push(`${row.member} row ${row.rowNumber}: ${resolved.reason}`); return; }
      const conflictSet = memberSourceGroups.get(`${base.meetingId}\u001f${resolved.userId}`) || new Set();
      if (conflictSet.size > 1) {
        const conflictKey = stableKey('church-service-group-conflict', `${base.meetingId}\u001f${resolved.userId}`);
        const decision = groupDecisions.get(conflictKey);
        if (!decision) { memberUnresolved.push(`Group conflict ${conflictKey} is unresolved`); return; }
        if (decision.decision === 'KEEP_ONE_GROUP') {
          if (normalizeArabicComparison(decision.approvedGroupName) !== normalizeArabicComparison(effectiveGroupName)) { memberSkipped.push({ row: row.rowNumber, name: row.member, reason: 'Non-selected source group' }); return; }
        } else if (['KEEP_EXISTING_GROUP', 'SKIP_PERSON_IN_MEETING', 'SOURCE_DATA_ERROR'].includes(decision.decision)) { memberSkipped.push({ row: row.rowNumber, name: row.member, reason: decision.decision }); return; }
        else { memberUnresolved.push('ALLOW_BOTH_GROUPS is not supported by the domain'); return; }
      }
      requestedMembers.add(resolved.userId);
    });
    let memberAdds = 0; let memberNoOps = 0; let memberConflicts = 0;
    requestedMembers.forEach((userId) => {
      const existingGroups = existing.members.get(`${base.meetingId}\u001f${userId}`) || new Set();
      const target = [...existingGroups].some((name) => normalizeArabicComparison(name) === normalizeArabicComparison(effectiveGroupName));
      if (target) memberNoOps += 1;
      else if (existingGroups.size) { memberConflicts += 1; addBlocker('EXISTING_GROUP_MEMBERSHIP_CONFLICT', { userId, meetingId: base.meetingId, group: effectiveGroupName }, `Existing group(s): ${[...existingGroups].join(', ')}`); }
      else { const operationKey = `${base.meetingId}\u001f${normalizeArabicComparison(effectiveGroupName)}\u001f${userId}`; if (!plannedMemberKeys.has(operationKey)) { plannedMemberKeys.add(operationKey); memberAdds += 1; } }
    });
    if (servantUnresolved.length) addBlocker('UNRESOLVED_SERVANT_OPERATION', { sourceKey: key }, servantUnresolved.join(' | '));
    if (memberUnresolved.length) addBlocker('UNRESOLVED_MEMBER_OPERATION', { sourceKey: key }, memberUnresolved.join(' | '));
    decisionsAudit.push(...memberSkipped.map((entry) => ({ type: 'SKIPPED_MEMBER_OCCURRENCE', sourceKey: key, ...entry })));
    const meeting = meetingsById.get(base.meetingId) || {};
    const existingNames = unique([...(meeting.groups || []), ...(meeting.groupAssignments || []).map((entry) => entry.group), ...(meeting.servants || []).flatMap((servant) => [...(servant.groupsManaged || []), ...(servant.groupAssignments || []).map((entry) => entry.group)])]);
    const effectiveExisting = existingNames.some((name) => normalizeArabicComparison(name) === normalizeArabicComparison(effectiveGroupName));
    const effectiveKey = `${base.meetingId}\u001f${normalizeArabicComparison(effectiveGroupName)}`;
    const groupOperation = effectiveExisting || plannedGroupKeys.has(effectiveKey) ? 'REUSE' : 'CREATE'; plannedGroupKeys.add(effectiveKey);
    groups.push({ ...base, targetGroupName: effectiveGroupName, canonicalGroupName: effectiveGroupName, originalSourceGroupName: base.originalGroupName, aliasApplied: effectiveGroupName !== base.targetGroupName, resolutionAware: true, requestedServantIds: requestedServants, requestedMemberIds: [...requestedMembers], skippedMembers: memberSkipped, operationBlockers: { servants: servantUnresolved, members: memberUnresolved }, operations: { group: groupOperation, servantAssignments: { ADD: servantAdds, NO_OP: servantNoOps, BLOCKED: servantUnresolved.length }, memberAssignments: { ADD: memberAdds, NO_OP: memberNoOps, BLOCKED: memberUnresolved.length + memberConflicts } } });
  }
  validation.decisions.identities.forEach((entry) => decisionsAudit.push({ type: 'IDENTITY_DECISION', ...entry }));
  validation.decisions.groups.forEach((entry) => decisionsAudit.push({ type: 'GROUP_DECISION', ...entry }));
  validation.decisions.servants.forEach((entry) => decisionsAudit.push({ type: 'SERVANT_DECISION', ...entry }));
  (validation.decisions.aliases || []).forEach((entry) => decisionsAudit.push({ type: 'GROUP_ALIAS_DECISION', ...entry }));
  (validation.decisions.duplicates || []).forEach((entry) => decisionsAudit.push({ type: 'DUPLICATE_USER_DECISION', ...entry }));
  const totals = {
    manualDecisionsLoaded: validation.completedDecisions, invalidDecisions: validation.errors.length, blankUnresolvedDecisions: validation.unresolvedDecisions,
    identitiesMapped: validation.decisions.identities.filter((entry) => entry.decision === 'MAP_EXISTING_USER').length,
    identitiesSplit: validation.decisions.identities.filter((entry) => entry.decision === 'SPLIT_SOURCE_IDENTITY').length,
    identitiesRequiringNewUsers: occurrence.missingUserReviewPlan.length, sourceOccurrencesSkipped: occurrence.skipped.length + decisionsAudit.filter((entry) => entry.type === 'SKIPPED_MEMBER_OCCURRENCE').length,
    multipleGroupConflictsResolved: validation.decisions.groups.length, multipleGroupConflictsRemaining: validation.groupRows.length - validation.decisions.groups.length,
    servantConflictsResolved: validation.decisions.servants.length, servantConflictsRemaining: validation.servantRows.length - validation.decisions.servants.length,
    groupAliasesResolved: (validation.decisions.aliases || []).filter((entry) => entry.decision === 'SAME_GROUP_ALIAS').length, duplicateUsersMapped: (validation.decisions.duplicates || []).filter((entry) => entry.decision === 'MAP_TO_CANONICAL_USER').length,
    groupsToCreate: groups.filter((group) => group.groupAction === 'CREATE').length, groupsToReuse: groups.filter((group) => group.groupAction === 'REUSE').length,
    safeServantAssignments: groups.reduce((sum, group) => sum + group.operations.servantAssignments.ADD, 0), safeMemberAssignments: groups.reduce((sum, group) => sum + group.operations.memberAssignments.ADD, 0),
    existingNoOps: groups.reduce((sum, group) => sum + group.operations.servantAssignments.NO_OP + group.operations.memberAssignments.NO_OP, 0), remainingBlockers: remainingBlockers.length,
  };
  const plan = {
    schemaVersion: 2, generatedAt, mode: 'RESOLUTION_AWARE_DRY_RUN', input: currentPlan.input, database: currentPlan.database,
    databaseFingerprint, sourceAssignmentPlanChecksum: currentPlan.planChecksum,
    resolutionWorkbook: { path: workbookPath, sha256: workbookHash, sourceResolutionPlanChecksum: validation.metadata.sourceResolutionPlanChecksum, generatedFieldsHash: validation.metadata.generatedFieldsHash },
    resolutionValidation: { completedDecisions: validation.completedDecisions, unresolvedDecisions: validation.unresolvedDecisions, errors: validation.errors, warnings: validation.warnings },
    resolutionReview: { identities: validation.identityRows, groups: validation.groupRows, servants: validation.servantRows, aliases: validation.aliasRows, duplicates: validation.duplicateRows },
    resolutionDecisions: decisionsAudit, identityResolutionResults: occurrence.identityResults, missingUserReviewPlan: occurrence.missingUserReviewPlan,
    skippedSourceOccurrences: occurrence.skipped, peopleMatches: currentPlan.peopleMatches, groups, conflicts: [...remainingBlockers], blockingErrors: remainingBlockers,
    warnings: currentPlan.warnings, totals, safeOperationsAvailable: totals.safeServantAssignments + totals.safeMemberAssignments > 0, safeForFullApply: remainingBlockers.length === 0 && validation.complete, safeToApply: remainingBlockers.length === 0 && validation.complete, planChecksum: null,
  };
  plan.planChecksum = calculatePlanChecksum(plan);
  return plan;
}

module.exports = { existingMaps, buildOccurrenceResolutions, buildResolutionAwarePlan };
