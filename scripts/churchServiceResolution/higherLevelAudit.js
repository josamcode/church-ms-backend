const crypto = require('crypto');
const { normalizeArabicComparison, cleanExactName } = require('../../src/utils/arabicNormalization');
const { stableKey } = require('./workbookSchema');

const idOf = (value) => String(value?._id || value?.id || value || '');
const unique = (values) => [...new Set((values || []).filter((value) => value !== '' && value != null))];
const boolComparison = (values) => {
  const present = values.filter((value) => value !== '' && value != null);
  if (present.length !== values.length) return present.length && new Set(present.map(String)).size === 1 ? 'COMPATIBLE_WITH_MISSING' : 'UNKNOWN';
  return new Set(present.map(String)).size === 1 ? 'YES' : 'NO';
};
const dateValue = (value) => value ? new Date(value).toISOString().slice(0, 10) : '';
const normalizedValue = (value) => normalizeArabicComparison(value || '');
const relationId = (relation) => idOf(relation?.userId) || normalizedValue(relation?.name);

function tokenSimilarity(first, second) {
  const a = unique(normalizedValue(first).split(' ').filter(Boolean));
  const b = unique(normalizedValue(second).split(' ').filter(Boolean));
  const shared = a.filter((token) => b.includes(token));
  const union = unique([...a, ...b]);
  return { score: union.length ? Math.round((shared.length / union.length) * 100) : 0, shared };
}

function buildGroupAliasAudit({ groupRows, sourceAssignmentPlan, meetings }) {
  const meetingById = new Map(meetings.map((meeting) => [idOf(meeting), meeting]));
  const pairMap = new Map();
  groupRows.forEach((conflict) => {
    const names = String(conflict.sourceGroups).split(' | ').filter(Boolean).sort((a, b) => a.localeCompare(b, 'ar'));
    if (names.length !== 2) return;
    const key = `${conflict.meetingId}\u001f${names[0]}\u001f${names[1]}`;
    if (!pairMap.has(key)) pairMap.set(key, { meetingId: conflict.meetingId, meetingName: conflict.meetingName, firstGroupName: names[0], secondGroupName: names[1], conflicts: [] });
    pairMap.get(key).conflicts.push(conflict);
  });
  return [...pairMap.values()].map((pair) => {
    const meeting = meetingById.get(pair.meetingId) || {};
    const existingNames = unique([...(meeting.groups || []), ...(meeting.groupAssignments || []).map((entry) => entry.group), ...(meeting.servants || []).flatMap((servant) => [...(servant.groupsManaged || []), ...(servant.groupAssignments || []).map((entry) => entry.group)])]);
    const firstRows = []; const secondRows = [];
    pair.conflicts.forEach((conflict) => {
      const byGroup = JSON.parse(conflict.sourceRowsByGroup || '{}');
      firstRows.push(...(byGroup[pair.firstGroupName] || [])); secondRows.push(...(byGroup[pair.secondGroupName] || []));
    });
    const similarity = tokenSimilarity(pair.firstGroupName, pair.secondGroupName);
    const firstNormalized = normalizedValue(pair.firstGroupName); const secondNormalized = normalizedValue(pair.secondGroupName);
    const parentheticalVariant = normalizedValue(pair.firstGroupName.replace(/\([^)]*\)/g, '')) === normalizedValue(pair.secondGroupName.replace(/\([^)]*\)/g, ''));
    const highImpactAddressVariant = pair.conflicts.length >= 20 && similarity.score >= 35;
    const recommendAlias = parentheticalVariant || highImpactAddressVariant;
    const sector = sourceAssignmentPlan.groups.find((group) => group.meetingId === pair.meetingId)?.sector || '';
    return {
      aliasKey: stableKey('church-service-group-alias', `${pair.meetingId}\u001f${pair.firstGroupName}\u001f${pair.secondGroupName}`), sector, meetingId: pair.meetingId, meetingName: pair.meetingName,
      firstGroupName: pair.firstGroupName, secondGroupName: pair.secondGroupName, firstGroupExisting: existingNames.some((name) => normalizedValue(name) === firstNormalized) ? 'YES' : 'NO', secondGroupExisting: existingNames.some((name) => normalizedValue(name) === secondNormalized) ? 'YES' : 'NO',
      affectedPeopleCount: pair.conflicts.length, affectedUserIds: pair.conflicts.map((entry) => entry.userId).join(' | '), firstGroupRows: unique(firstRows).sort((a, b) => a - b).join(' | '), secondGroupRows: unique(secondRows).sort((a, b) => a - b).join(' | '),
      normalizedSimilarity: `${similarity.score}%`, sharedAddressTokens: similarity.shared.join(' | '), existingDatabaseEvidence: `meeting groups: ${existingNames.join(' | ')}`,
      recommendedDecision: recommendAlias ? 'SAME_GROUP_ALIAS' : 'DIFFERENT_GROUPS', recommendationReason: parentheticalVariant ? 'One label differs only by a parenthetical scope suffix; strong alias recommendation, not approval.' : highImpactAddressVariant ? `${pair.conflicts.length} people share this address-label pair and the labels have overlapping address tokens; high-impact alias review required.` : 'Names describe materially different areas or evidence is insufficient; retain person-level conflicts unless reviewed otherwise.',
      manualDecision: '', canonicalGroupName: '', notes: '', validationStatus: '', validationMessage: '',
    };
  }).sort((a, b) => b.affectedPeopleCount - a.affectedPeopleCount || a.meetingName.localeCompare(b.meetingName, 'ar'));
}

function userEvidence(user, meetings) {
  const userId = idOf(user);
  let groupCount = 0; let attendanceCount = (user.meetingAttendance || []).length + (user.divineLiturgyAttendance || []).length; let activityCount = (user.confessionSessionIds || []).length; let noteCount = 0;
  meetings.forEach((meeting) => {
    (meeting.groupAssignments || []).forEach((entry) => { if ((entry.servedUserIds || []).map(idOf).includes(userId)) groupCount += 1; });
    (meeting.servants || []).forEach((servant) => {
      if (idOf(servant.userId) === userId) groupCount += unique([...(servant.groupsManaged || []), ...(servant.groupAssignments || []).map((entry) => entry.group)]).length;
      (servant.groupAssignments || []).forEach((entry) => { if ((entry.servedUserIds || []).map(idOf).includes(userId)) groupCount += 1; });
    });
    (meeting.attendanceRecords || []).forEach((record) => { if ((record.attendedMemberUserIds || []).map(idOf).includes(userId)) attendanceCount += 1; });
    noteCount += (meeting.memberNotes || []).filter((note) => idOf(note.memberUserId) === userId).length;
  });
  activityCount += attendanceCount + noteCount;
  const relationships = [user.father, user.mother, user.spouse, ...(user.siblings || []), ...(user.children || []), ...(user.familyMembers || [])].filter((entry) => relationId(entry)).length;
  const fields = ['fullName', 'gender', 'birthDate', 'nationalId', 'phonePrimary', 'whatsappNumber', 'familyName', 'houseName', 'education', 'father', 'mother', 'spouse', 'confessionFatherUserId'];
  const completeness = fields.reduce((score, field) => score + (user[field] && (typeof user[field] !== 'object' || Object.keys(user[field]).length) ? 1 : 0), 0) + Math.min(relationships, 5) + Math.min(activityCount, 5) + (user.hasLogin ? 2 : 0) + Math.min((user.changeLog || []).length, 3);
  return { userId, meetingCount: unique((user.meetingIds || []).map(idOf)).length, groupCount, attendanceCount, activityCount, noteCount, relationships, completeness };
}

function compareCandidateSet(candidates, evidence, nationalIdCounts) {
  const values = (selector) => candidates.map(selector);
  const comparisons = {
    sameNormalizedName: boolComparison(values((user) => normalizedValue(user.fullName))), sameGender: boolComparison(values((user) => user.gender || '')),
    sameBirthDate: boolComparison(values((user) => dateValue(user.birthDate))), sameNationalId: boolComparison(values((user) => String(user.nationalId || '').trim())),
    samePhone: boolComparison(values((user) => normalizeArabicComparison(user.phonePrimary || user.whatsappNumber || ''))), sameFamilyName: boolComparison(values((user) => normalizedValue(user.familyName))),
    sameHouseName: boolComparison(values((user) => normalizedValue(user.houseName))),
    sameParents: boolComparison(values((user) => `${relationId(user.father)}|${relationId(user.mother)}`)),
    sameImportSource: boolComparison(values((user) => `${user.customDetails?.importSourceWorkbook || ''}|${user.customDetails?.importSheet || ''}`)),
  };
  const sameStrongNational = comparisons.sameNationalId === 'YES' && candidates[0]?.nationalId;
  const conflictingNational = comparisons.sameNationalId === 'NO' && candidates.every((user) => user.nationalId);
  const birthConflict = comparisons.sameBirthDate === 'NO' && candidates.every((user) => user.birthDate);
  const genderConflict = comparisons.sameGender === 'NO' && candidates.every((user) => user.gender);
  const supportive = ['sameGender', 'sameBirthDate', 'sameFamilyName', 'sameHouseName', 'sameParents', 'sameImportSource'].filter((key) => ['YES', 'COMPATIBLE_WITH_MISSING'].includes(comparisons[key])).length;
  let classification = 'INSUFFICIENT_EVIDENCE';
  if (conflictingNational || genderConflict) classification = 'DATA_CONFLICT';
  else if (birthConflict) classification = 'DISTINCT_PEOPLE';
  else if (comparisons.sameNormalizedName === 'YES' && (sameStrongNational || supportive >= 4)) classification = 'LIKELY_DUPLICATE_DATABASE_RECORDS';
  const scored = candidates.map((user) => {
    const item = evidence.get(idOf(user));
    let score = item.completeness;
    if (user.nationalId && nationalIdCounts.get(String(user.nationalId)) === 1) score += 8;
    if (user.hasLogin) score += 3;
    score += Math.min(item.meetingCount + item.groupCount + item.activityCount, 10);
    return { user, evidence: item, score };
  }).sort((a, b) => b.score - a.score);
  const canonical = classification === 'LIKELY_DUPLICATE_DATABASE_RECORDS' && scored[0] && (!scored[1] || scored[0].score > scored[1].score) ? scored[0] : null;
  const reason = classification === 'LIKELY_DUPLICATE_DATABASE_RECORDS'
    ? `${sameStrongNational ? 'Candidates share the same national ID (strong duplicate-data finding). ' : ''}${supportive} compatible identity/profile evidence dimensions. ${canonical ? `Canonical recommendation uses uniquely greater profile/relationship/activity completeness (${canonical.score}).` : 'No canonical candidate has a deterministic completeness advantage.'}`
    : classification === 'DISTINCT_PEOPLE' ? 'Candidate birth dates conflict, which is affirmative evidence of distinct people.'
      : classification === 'DATA_CONFLICT' ? 'Authoritative identity fields conflict and require database investigation.' : 'Available matching fields do not prove that the records are the same real person.';
  return { comparisons, classification, canonical, scored, reason };
}

function buildDuplicateUserAudit({ resolutionPlan, users, meetings }) {
  const usersById = new Map(users.map((user) => [idOf(user), user]));
  const evidence = new Map(users.map((user) => [idOf(user), userEvidence(user, meetings)]));
  const nationalIdCounts = new Map(); users.forEach((user) => { if (user.nationalId) nationalIdCounts.set(String(user.nationalId), (nationalIdCounts.get(String(user.nationalId)) || 0) + 1); });
  const reviews = []; const details = []; const cleanup = [];
  resolutionPlan.ambiguousPeople.forEach((identity) => {
    const candidates = identity.candidates.map((entry) => usersById.get(entry.id)).filter(Boolean);
    const comparison = compareCandidateSet(candidates, evidence, nationalIdCounts);
    const identityKey = stableKey('church-service-identity', `AMBIGUOUS\u001f${identity.normalizedName}`);
    const reviewKey = stableKey('church-service-duplicate-review', `${identityKey}\u001f${candidates.map(idOf).sort().join('|')}`);
    reviews.push({
      duplicateReviewKey: reviewKey, identityKey, sourceName: identity.original, meeting: identity.meetings.join(' | '), group: identity.groups.join(' | '),
      candidateUserIds: candidates.map(idOf).join(' | '), candidateNames: candidates.map((user) => user.fullName).join(' | '), ...comparison.comparisons,
      candidateDataCompleteness: comparison.scored.map((item) => `${idOf(item.user)}:${item.score}`).join(' | '), candidateLoginStatus: candidates.map((user) => `${idOf(user)}:${user.hasLogin ? 'LOGIN' : 'NO_LOGIN'}`).join(' | '),
      candidateRelationshipCounts: candidates.map((user) => `${idOf(user)}:${evidence.get(idOf(user)).relationships}`).join(' | '), candidateMeetingCounts: candidates.map((user) => `${idOf(user)}:${evidence.get(idOf(user)).meetingCount}/${evidence.get(idOf(user)).groupCount}`).join(' | '),
      candidateActivityCounts: candidates.map((user) => `${idOf(user)}:${evidence.get(idOf(user)).activityCount}`).join(' | '), classification: comparison.classification,
      recommendedCanonicalUserId: comparison.canonical ? idOf(comparison.canonical.user) : '', recommendationReason: comparison.reason,
      manualDecision: '', approvedCanonicalUserId: '', notes: '', validationStatus: '', validationMessage: '',
    });
    candidates.forEach((user) => {
      const item = evidence.get(idOf(user));
      details.push({ duplicateReviewKey: reviewKey, identityKey, candidateUserId: idOf(user), candidateFullName: user.fullName, gender: user.gender || '', birthDate: dateValue(user.birthDate), nationalIdStatus: user.nationalId ? `PRESENT_SHA256_${crypto.createHash('sha256').update(String(user.nationalId)).digest('hex').slice(0, 10)}` : 'MISSING', phoneStatus: user.phonePrimary || user.whatsappNumber ? 'PRESENT_REDACTED' : 'MISSING', familyName: user.familyName || '', houseName: user.houseName || '', education: JSON.stringify(user.education || {}), father: relationId(user.father), mother: relationId(user.mother), spouse: relationId(user.spouse), relationshipCount: item.relationships, meetingCount: item.meetingCount, groupCount: item.groupCount, attendanceCount: item.attendanceCount, activityCount: item.activityCount, confessionFather: idOf(user.confessionFatherUserId) || user.confessionFatherName || '', hasLogin: Boolean(user.hasLogin), accountStatus: user.accountStatus || '', isLocked: Boolean(user.isLocked), isDeleted: Boolean(user.isDeleted), importSourceKey: user.customDetails?.importSourceKey || '', importWorkbook: user.customDetails?.importSourceWorkbook || '', importRow: user.customDetails?.importRowNumber || user.customDetails?.importSourceRows || '', createdAt: user.createdAt || '', updatedAt: user.updatedAt || '', changeLogCount: (user.changeLog || []).length, completenessScore: comparison.scored.find((entry) => idOf(entry.user) === idOf(user))?.score || item.completeness });
    });
    if (comparison.classification === 'LIKELY_DUPLICATE_DATABASE_RECORDS') {
      const canonicalId = comparison.canonical ? idOf(comparison.canonical.user) : '';
      candidates.filter((user) => idOf(user) !== canonicalId).forEach((user) => cleanup.push({ duplicateReviewKey: reviewKey, sourceName: identity.original, canonicalCandidateId: canonicalId, duplicateCandidateId: idOf(user), fieldsUniqueToCanonical: canonicalId ? 'See duplicate-user-detail.csv completeness and evidence fields' : 'Canonical selection requires review', fieldsUniqueToDuplicate: 'See duplicate-user-detail.csv completeness and evidence fields', relationshipsOwnedByEach: candidates.map((candidate) => `${idOf(candidate)}:${evidence.get(idOf(candidate)).relationships}`).join(' | '), meetingGroupAssignments: candidates.map((candidate) => `${idOf(candidate)}:meetings=${evidence.get(idOf(candidate)).meetingCount},groups=${evidence.get(idOf(candidate)).groupCount}`).join(' | '), attendance: candidates.map((candidate) => `${idOf(candidate)}:${evidence.get(idOf(candidate)).attendanceCount}`).join(' | '), loginImplications: candidates.map((candidate) => `${idOf(candidate)}:${candidate.hasLogin ? 'LOGIN_ENABLED' : 'NO_LOGIN'}`).join(' | '), safeMergeRequirements: 'Separate reviewed cleanup: preserve unique fields and relationships, re-point references transactionally, resolve authentication, audit, then soft-delete only with approval.', manualReviewNotes: '' }));
    }
  });
  return { reviews, details, cleanup };
}

module.exports = { tokenSimilarity, buildGroupAliasAudit, userEvidence, compareCandidateSet, buildDuplicateUserAudit };
