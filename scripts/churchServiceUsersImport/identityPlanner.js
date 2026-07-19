const crypto = require('crypto');
const { cleanExactName, normalizeArabicComparison } = require('../../src/utils/arabicNormalization');
const { buildPeopleMatches } = require('../churchServiceImport/planner');
const { buildNameLookup, resolveName } = require('../churchServiceImport/matching');

const FEMALE_MEMBER_MEETINGS = new Set(['شابات', 'ثانوي بنات', 'اعدادي بنات']);
const MALE_MEMBER_MEETINGS = new Set(['شباب', 'الرجال', 'ثانوي بنين', 'اعدادي بنين']);
const CHILD_STAGE_MEETINGS = new Set(['حضانة', 'ابتدائي 1', 'ابتدائي 2', 'اعدادي بنين', 'اعدادي بنات', 'ثانوي بنين', 'ثانوي بنات']);
const ADULT_STAGE_MEETINGS = new Set(['جامعيين', 'شابات', 'شباب', 'الرجال', 'الحكماء', 'الام رفقة', 'بيتي علي الصخر']);
const REVIEW_TAG = 'يجب اتخاذ إجراء تعديل';

const idOf = (value) => String(value?._id || value?.id || value || '');
const unique = (values) => [...new Set(values.filter((value) => value !== '' && value != null))];
const sortText = (values) => unique(values).sort((a, b) => String(a).localeCompare(String(b), 'ar'));

function stablePersonKey(normalizedName) {
  const digest = crypto.createHash('sha256').update(`church-service-users:v1:${normalizedName}`, 'utf8').digest('hex').slice(0, 24);
  return `church-service-person-${digest}`;
}

function canonicalSpelling(occurrences) {
  const stats = new Map();
  occurrences.forEach((occurrence, index) => {
    const spelling = cleanExactName(occurrence.original);
    if (!stats.has(spelling)) stats.set(spelling, { spelling, count: 0, firstIndex: index });
    stats.get(spelling).count += 1;
  });
  return [...stats.values()].sort((a, b) => b.count - a.count || a.firstIndex - b.firstIndex)[0]?.spelling || '';
}

function explicitMemberGender(meeting) {
  if (FEMALE_MEMBER_MEETINGS.has(meeting)) return 'female';
  if (MALE_MEMBER_MEETINGS.has(meeting)) return 'male';
  return '';
}

function deriveGender(occurrences) {
  const evidence = occurrences
    .filter((occurrence) => occurrence.role === 'member')
    .map((occurrence) => ({ meeting: occurrence.meeting, gender: explicitMemberGender(occurrence.meeting) }))
    .filter((entry) => entry.gender);
  const genders = unique(evidence.map((entry) => entry.gender));
  if (genders.length > 1) return { gender: '', conflict: true, evidence, method: 'CONTRADICTORY_EXPLICIT_MEMBER_MEETINGS' };
  if (genders.length === 1) return { gender: genders[0], conflict: false, evidence, method: 'EXPLICIT_MEMBER_MEETING' };
  return { gender: '', conflict: false, evidence: [], method: 'UNKNOWN' };
}

const GRADE_NUMBER = Object.freeze({ الاول: 1, الأول: 1, الثاني: 2, الثالث: 3, الرابع: 4, الخامس: 5, السادس: 6 });

function educationForOccurrence(occurrence) {
  if (occurrence.role !== 'member') return null;
  const meeting = occurrence.meeting;
  const grade = normalizeArabicComparison(occurrence.grade);
  if (meeting === 'حضانة') {
    if (/^kg\s*1$/i.test(occurrence.grade)) return { stage: 'kindergarten_kg1', evidence: `${meeting} + ${occurrence.grade}` };
    if (/^kg\s*2$/i.test(occurrence.grade)) return { stage: 'kindergarten_kg2', evidence: `${meeting} + ${occurrence.grade}` };
    return { stage: 'kindergarten_unspecified_year', evidence: `${meeting}; grade not exactly mapped` };
  }
  if (meeting === 'ابتدائي 1' || meeting === 'ابتدائي 2') {
    const number = GRADE_NUMBER[grade];
    return number ? { stage: `primary_grade_${number}`, evidence: `${meeting} + ${occurrence.grade}` } : { stage: 'primary_unspecified_year', evidence: `${meeting}; grade not exactly mapped` };
  }
  if (meeting === 'اعدادي بنين' || meeting === 'اعدادي بنات') {
    const number = GRADE_NUMBER[grade];
    return number ? { stage: `preparatory_grade_${number}`, evidence: `${meeting} + ${occurrence.grade}` } : { stage: 'preparatory_unspecified_year', evidence: `${meeting}; grade not exactly mapped` };
  }
  if (meeting === 'ثانوي بنين' || meeting === 'ثانوي بنات') {
    return { stage: 'secondary_unspecified_year', evidence: `${meeting}; school type is not available, so year is not guessed` };
  }
  return null;
}

function deriveEducation(occurrences) {
  const mappings = occurrences.map(educationForOccurrence).filter(Boolean);
  const stages = unique(mappings.map((mapping) => mapping.stage));
  if (stages.length > 1) return { education: null, conflict: true, evidence: mappings.map((mapping) => mapping.evidence), method: 'CONTRADICTORY_EXACT_STAGE_MAPPINGS' };
  if (stages.length === 1) return { education: { stage: stages[0] }, conflict: false, evidence: unique(mappings.map((mapping) => mapping.evidence)), method: 'EXACT_MEETING_GRADE_MAPPING' };
  return { education: null, conflict: false, evidence: [], method: 'UNKNOWN' };
}

function contextualContradictions(occurrences) {
  const reasons = [];
  const memberOccurrences = occurrences.filter((occurrence) => occurrence.role === 'member');
  const memberMeetings = new Set(memberOccurrences.map((occurrence) => occurrence.meeting));
  const hasChild = [...memberMeetings].some((meeting) => CHILD_STAGE_MEETINGS.has(meeting));
  const hasAdult = [...memberMeetings].some((meeting) => ADULT_STAGE_MEETINGS.has(meeting));
  if (hasChild && hasAdult) reasons.push('Same normalized name occurs as a member in child/teen and adult meeting contexts');
  const groupsByMeeting = new Map();
  for (const occurrence of memberOccurrences) {
    if (!groupsByMeeting.has(occurrence.meeting)) groupsByMeeting.set(occurrence.meeting, new Set());
    groupsByMeeting.get(occurrence.meeting).add(normalizeArabicComparison(occurrence.group));
  }
  for (const [meeting, groups] of groupsByMeeting) {
    if (groups.size > 1) reasons.push(`Same normalized name occurs in ${groups.size} groups in meeting ${meeting}`);
  }
  if (hasChild && occurrences.some((occurrence) => occurrence.role === 'servant')) {
    reasons.push('Same normalized name appears as a child/teen member and as a servant');
  }
  return reasons;
}

function sourceOccurrences(rows) {
  const occurrences = [];
  for (const row of rows) {
    for (const servant of row.servants) occurrences.push({ original: servant, role: 'servant', meeting: row.meeting, group: row.group, grade: row.grade, sector: row.sector, rowNumber: row.rowNumber });
    occurrences.push({ original: row.member, role: 'member', meeting: row.meeting, group: row.group, grade: row.grade, sector: row.sector, rowNumber: row.rowNumber });
  }
  return occurrences;
}

function compactStringList(values, maxLength = 900) {
  const serialized = sortText(values).join(' | ');
  return serialized.length <= maxLength ? serialized : `${serialized.slice(0, maxLength - 20)}… [truncated]`;
}

function buildCustomDetails(identity, batchId, workbookName) {
  return {
    importSourceWorkbook: workbookName,
    importSheet: 'Sheet2',
    importReason: 'Missing person discovered during church-service meeting import',
    importBatchId: batchId,
    importSourceKey: identity.importSourceKey,
    importOriginalNames: compactStringList(identity.originalSpellings),
    importNormalizedName: identity.normalizedName,
    importRoles: identity.roles.join(' | '),
    importMeetings: compactStringList(identity.meetings),
    importGroups: compactStringList(identity.groups),
    importGrades: compactStringList(identity.grades),
    importRowNumbers: compactStringList(identity.rowNumbers.map(String)),
    importLoginDecision: 'Login disabled: source has no verified national ID or credentials.',
    importNationalIdStatus: 'missing',
    importFamilyMatchStatus: 'none',
    importFamilyConfidence: 'none',
    importFamilyCandidateIds: '',
    importGenderEvidence: compactStringList(identity.genderEvidence),
    importEducationEvidence: compactStringList(identity.educationEvidence),
    importWarnings: compactStringList(identity.warnings),
  };
}

function buildMissingIdentityPlan({ rows, activeUsers, allUsers, batchId, workbookName }) {
  const activePeople = buildPeopleMatches(rows, activeUsers);
  const activeByOriginal = activePeople.byOriginal;
  const activeUsersById = new Map(activeUsers.map((user) => [idOf(user), user]));
  const allLookup = buildNameLookup(allUsers);
  const occurrences = sourceOccurrences(rows);
  const missingClusters = new Map();
  const classifications = [];

  for (const person of activePeople.matches) {
    let classification;
    let plannedOperation = '';
    if (person.status === 'EXACT_MATCH' || person.status === 'NORMALIZED_MATCH') {
      const matchedUser = activeUsersById.get(person.matchedId);
      const expectedSourceKey = `church-service-users::${stablePersonKey(person.normalizedName)}`;
      if (String(matchedUser?.customDetails?.importSourceKey || '') === expectedSourceKey) {
        classification = 'NO_OP_ALREADY_IMPORTED';
        plannedOperation = 'NO_OP_ALREADY_IMPORTED';
      } else {
        classification = 'REUSE_EXISTING';
        plannedOperation = 'REUSE_EXISTING';
      }
    }
    else if (person.status === 'AMBIGUOUS') classification = 'EXISTING_AMBIGUOUS';
    else if (person.status === 'INVALID') classification = 'INVALID_SOURCE_NAME';
    else {
      const includingDeleted = resolveName(person.original, allLookup);
      classification = includingDeleted.status === 'MISSING' ? 'PENDING_MISSING_CLUSTER' : 'MANUAL_REVIEW_REQUIRED';
    }
    classifications.push({ ...person, sourceMatchStatus: person.status, classification, plannedOperation });
  }

  for (const occurrence of occurrences) {
    const person = activeByOriginal.get(occurrence.original);
    if (!person || person.status !== 'MISSING') continue;
    const includingDeleted = resolveName(occurrence.original, allLookup);
    if (includingDeleted.status !== 'MISSING') continue;
    const normalizedName = normalizeArabicComparison(occurrence.original);
    if (!missingClusters.has(normalizedName)) missingClusters.set(normalizedName, []);
    missingClusters.get(normalizedName).push(occurrence);
  }

  const existingBySourceKey = new Map();
  for (const user of allUsers) {
    const sourceKey = String(user.customDetails?.importSourceKey || '').trim();
    if (sourceKey) {
      if (!existingBySourceKey.has(sourceKey)) existingBySourceKey.set(sourceKey, []);
      existingBySourceKey.get(sourceKey).push(user);
    }
  }

  const identities = [];
  for (const [normalizedName, cluster] of missingClusters) {
    const personKey = stablePersonKey(normalizedName);
    const importSourceKey = `church-service-users::${personKey}`;
    const gender = deriveGender(cluster);
    const education = deriveEducation(cluster);
    const homonymReasons = contextualContradictions(cluster);
    if (gender.conflict) homonymReasons.push('Contradictory explicit gender-specific member meetings');
    if (education.conflict) homonymReasons.push('Contradictory education-stage contexts');
    const canonicalFullName = canonicalSpelling(cluster);
    const warnings = [];
    const blockers = [];
    if (!gender.gender) warnings.push('Gender is unknown and will be omitted');
    if (!education.education) warnings.push('Education is unknown and will be omitted');
    const invalidSourceName = canonicalFullName.length < 2 || canonicalFullName.length > 100 || !normalizedName;
    if (invalidSourceName) blockers.push('Canonical name fails User schema name requirements');
    if (homonymReasons.length) blockers.push(...homonymReasons);
    const importedMatches = existingBySourceKey.get(importSourceKey) || [];
    let operation = blockers.length ? (homonymReasons.length ? 'POTENTIAL_HOMONYM' : 'BLOCKED') : 'CREATE';
    if (importedMatches.length === 1 && !importedMatches[0].isDeleted) operation = 'NO_OP_ALREADY_IMPORTED';
    else if (importedMatches.length > 1) {
      operation = 'AMBIGUOUS';
      blockers.push('Multiple users already share this importSourceKey');
    } else if (importedMatches.length === 1 && importedMatches[0].isDeleted) {
      operation = 'BLOCKED';
      blockers.push('A soft-deleted user already has this importSourceKey');
    }
    const identity = {
      stablePersonKey: personKey,
      importSourceKey,
      canonicalFullName,
      normalizedName,
      originalSpellings: sortText(cluster.map((item) => item.original)),
      roles: sortText(cluster.map((item) => item.role)),
      meetings: sortText(cluster.map((item) => item.meeting)),
      groups: sortText(cluster.map((item) => item.group)),
      grades: sortText(cluster.map((item) => item.grade)),
      rowNumbers: [...new Set(cluster.map((item) => item.rowNumber))].sort((a, b) => a - b),
      occurrences: cluster,
      classification: invalidSourceName ? 'INVALID_SOURCE_NAME' : operation === 'POTENTIAL_HOMONYM' ? 'MISSING_POTENTIAL_HOMONYM' : blockers.length ? 'MANUAL_REVIEW_REQUIRED' : 'MISSING_SAFE_TO_CREATE',
      operation,
      gender: gender.gender || null,
      genderMethod: gender.method,
      genderEvidence: gender.evidence.map((entry) => `${entry.meeting}:${entry.gender}`),
      education: education.education,
      educationMethod: education.method,
      educationEvidence: education.evidence,
      homonymReasons,
      warnings: unique(warnings),
      blockers: unique(blockers),
      existingImportedUserId: importedMatches.length === 1 ? idOf(importedMatches[0]) : '',
      plannedUser: null,
      family: null,
    };
    identity.plannedUser = {
      fullName: canonicalFullName,
      ...(identity.gender ? { gender: identity.gender } : {}),
      ...(identity.education ? { education: identity.education } : {}),
      accountStatus: 'approved',
      hasLogin: false,
      role: 'USER',
      isLocked: false,
      isDeleted: false,
      tags: [REVIEW_TAG],
      customDetails: buildCustomDetails(identity, batchId, workbookName),
    };
    identities.push(identity);
  }
  identities.sort((a, b) => a.canonicalFullName.localeCompare(b.canonicalFullName, 'ar'));
  return { identities, classifications, activePeopleMatches: activePeople.matches };
}

module.exports = {
  REVIEW_TAG,
  stablePersonKey,
  canonicalSpelling,
  explicitMemberGender,
  deriveGender,
  educationForOccurrence,
  deriveEducation,
  contextualContradictions,
  sourceOccurrences,
  buildMissingIdentityPlan,
};
