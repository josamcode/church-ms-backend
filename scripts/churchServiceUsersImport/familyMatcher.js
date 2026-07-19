const { normalizeArabicComparison } = require('../../src/utils/arabicNormalization');

const idOf = (value) => String(value?._id || value?.id || value || '');
const unique = (values) => [...new Set(values.filter(Boolean))];

function normalizedTokens(value) {
  return normalizeArabicComparison(value).split(' ').filter(Boolean);
}

function fatherPrefixEvidence(missingName, candidateName) {
  const childTokens = normalizedTokens(missingName);
  const fatherTokens = normalizedTokens(candidateName);
  if (childTokens.length < 3 || fatherTokens.length < 2) return { matches: false, tokens: [], count: 0 };
  const patronymic = childTokens.slice(1);
  const supporting = [];
  for (let index = 0; index < Math.min(patronymic.length, fatherTokens.length); index += 1) {
    if (patronymic[index] !== fatherTokens[index]) break;
    supporting.push(patronymic[index]);
  }
  return { matches: supporting.length >= 2, tokens: supporting, count: supporting.length };
}

function currentAge(birthDate, now = new Date()) {
  if (!birthDate) return null;
  const birth = new Date(birthDate);
  if (Number.isNaN(birth.getTime())) return null;
  let age = now.getUTCFullYear() - birth.getUTCFullYear();
  if (now.getUTCMonth() < birth.getUTCMonth() || (now.getUTCMonth() === birth.getUTCMonth() && now.getUTCDate() < birth.getUTCDate())) age -= 1;
  return age;
}

function stageKind(identity) {
  const stages = (identity.meetings || []);
  if (stages.some((meeting) => ['حضانة', 'ابتدائي 1', 'ابتدائي 2', 'اعدادي بنين', 'اعدادي بنات', 'ثانوي بنين', 'ثانوي بنات'].includes(meeting))) return 'child_or_teen';
  if (stages.some((meeting) => ['جامعيين', 'شابات', 'شباب', 'الرجال', 'الحكماء', 'الام رفقة', 'بيتي علي الصخر'].includes(meeting))) return 'adult';
  return 'unknown';
}

function ageConflict(identity, candidate) {
  const age = currentAge(candidate.birthDate);
  if (age == null) return '';
  const kind = stageKind(identity);
  if (kind === 'child_or_teen' && age < 20) return `Candidate age ${age} is incompatible with parenthood for a child/teen meeting context`;
  if (kind === 'adult' && age < 35) return `Candidate age ${age} is implausible for parenthood for an adult meeting context`;
  return '';
}

function householdKey(user) {
  const house = normalizeArabicComparison(user.houseName);
  const family = normalizeArabicComparison(user.familyName);
  if (house || family) return `${house}\u001f${family}`;
  return `user:${idOf(user)}`;
}

function familyDetails(user) {
  return {
    gender: user.gender || '',
    birthDate: user.birthDate || null,
    familyName: user.familyName || '',
    houseName: user.houseName || '',
    fatherId: idOf(user.father?.userId),
    motherId: idOf(user.mother?.userId),
    spouseId: idOf(user.spouse?.userId),
    childrenIds: (user.children || []).map((entry) => idOf(entry.userId)).filter(Boolean),
  };
}

function buildFamilyIndex(existingUsers) {
  const fatherPrefix = new Map();
  const userById = new Map();
  for (const user of existingUsers) {
    userById.set(idOf(user), user);
    const tokens = normalizedTokens(user.fullName);
    if (tokens.length < 2) continue;
    const key = `${tokens[0]}\u001f${tokens[1]}`;
    if (!fatherPrefix.has(key)) fatherPrefix.set(key, []);
    fatherPrefix.get(key).push(user);
  }
  return { fatherPrefix, userById };
}

function buildFatherCandidates(identity, existingUsers, familyIndex = null) {
  const candidates = [];
  const childTokens = normalizedTokens(identity.canonicalFullName);
  const prefixKey = childTokens.length >= 3 ? `${childTokens[1]}\u001f${childTokens[2]}` : '';
  const candidateUsers = familyIndex && prefixKey ? (familyIndex.fatherPrefix.get(prefixKey) || []) : existingUsers;
  for (const user of candidateUsers) {
    if (user.isDeleted) continue;
    const evidence = fatherPrefixEvidence(identity.canonicalFullName, user.fullName);
    if (!evidence.matches) continue;
    const conflicts = [];
    if (user.gender && user.gender !== 'male') conflicts.push(`Candidate gender is ${user.gender}, not male`);
    const ageIssue = ageConflict(identity, user);
    if (ageIssue) conflicts.push(ageIssue);
    const score = 60 + Math.min(20, (evidence.count - 2) * 10) + (user.gender === 'male' ? 10 : 0) + (user.houseName || user.familyName ? 5 : 0) - conflicts.length * 30;
    const hasEstablishedHousehold = Boolean(
      user.houseName
      || user.familyName
      || user.spouse?.userId
      || (user.children || []).some((entry) => entry.userId)
    );
    candidates.push({
      candidateUserId: idOf(user),
      candidateName: user.fullName,
      relationType: 'father',
      household: [user.houseName, user.familyName].filter(Boolean).join(' / '),
      householdKey: householdKey(user),
      supportingTokens: evidence.tokens,
      similarityReason: `The tokens after the missing person's first name match the first ${evidence.count} candidate-name token(s)`,
      score,
      existingFamilyDetails: familyDetails(user),
      hasEstablishedHousehold,
      conflicts,
      user,
    });
  }
  return candidates.sort((a, b) => b.score - a.score || a.candidateName.localeCompare(b.candidateName, 'ar')).slice(0, 20);
}

function resolveMotherFromFather(father, userById) {
  const spouseId = idOf(father?.spouse?.userId);
  if (!spouseId) return { mother: null, conflict: '' };
  const spouse = userById.get(spouseId);
  if (!spouse || spouse.isDeleted) return { mother: null, conflict: 'Father spouse link does not resolve to an active user' };
  if (spouse.gender && spouse.gender !== 'female') return { mother: null, conflict: 'Father spouse gender is not compatible with mother relation' };
  return { mother: spouse, conflict: '' };
}

function matchFamily(identity, existingUsers, familyIndex = null) {
  const index = familyIndex || buildFamilyIndex(existingUsers);
  const userById = index.userById;
  const candidates = buildFatherCandidates(identity, existingUsers, index);
  if (!candidates.length) {
    return { confidence: 'NO_FAMILY_CANDIDATE', father: null, mother: null, household: null, evidence: [], conflicts: [], plannedAction: 'NONE', manualApprovalRequired: true, candidates: [] };
  }
  const viable = candidates.filter((candidate) => candidate.conflicts.length === 0);
  const householdKeys = new Set(viable.map((candidate) => candidate.householdKey));
  const exactlyOneCandidate = viable.length === 1;
  const exactlyOneHousehold = householdKeys.size === 1;
  const topTie = viable.length > 1 && viable[0].score === viable[1].score;
  if (
    exactlyOneCandidate
    && exactlyOneHousehold
    && viable[0].user.gender === 'male'
    && viable[0].hasEstablishedHousehold
  ) {
    const father = viable[0].user;
    const motherResult = resolveMotherFromFather(father, userById);
    const conflicts = motherResult.conflict ? [motherResult.conflict] : [];
    return {
      confidence: 'HIGH_CONFIDENCE_AUTO_LINK',
      father: { id: idOf(father), name: father.fullName },
      mother: motherResult.mother ? { id: idOf(motherResult.mother), name: motherResult.mother.fullName } : null,
      household: { houseName: father.houseName || '', familyName: father.familyName || '', householdUserId: idOf(father) },
      evidence: [viable[0].similarityReason, `Supporting tokens: ${viable[0].supportingTokens.join(' ')}`, 'Exactly one compatible father and household candidate'],
      conflicts,
      plannedAction: motherResult.mother ? 'PROPOSE_LINK_FATHER_AND_MOTHER' : 'PROPOSE_LINK_FATHER',
      manualApprovalRequired: true,
      candidates,
    };
  }
  if (!viable.length) {
    return { confidence: 'FAMILY_CONFLICT', father: null, mother: null, household: null, evidence: [], conflicts: unique(candidates.flatMap((candidate) => candidate.conflicts)), plannedAction: 'NONE', manualApprovalRequired: true, candidates };
  }
  if (topTie || householdKeys.size > 1) {
    return { confidence: 'AMBIGUOUS_FAMILY', father: null, mother: null, household: null, evidence: viable.slice(0, 5).map((candidate) => candidate.similarityReason), conflicts: ['More than one father or household candidate remains plausible'], plannedAction: 'SUGGEST_ONLY', manualApprovalRequired: true, candidates };
  }
  const best = viable[0];
  return {
    confidence: best.user.gender === 'male' ? 'MEDIUM_CONFIDENCE_SUGGESTION' : 'LOW_CONFIDENCE_SUGGESTION',
    father: { id: best.candidateUserId, name: best.candidateName },
    mother: null,
    household: { houseName: best.user.houseName || '', familyName: best.user.familyName || '', householdUserId: best.candidateUserId },
    evidence: [best.similarityReason, `Supporting tokens: ${best.supportingTokens.join(' ')}`],
    conflicts: viable.length > 1 ? ['Other father candidates exist'] : [],
    plannedAction: 'SUGGEST_ONLY',
    manualApprovalRequired: true,
    candidates,
  };
}

function applyFamilyMatches(identities, existingUsers) {
  const familyIndex = buildFamilyIndex(existingUsers);
  for (const identity of identities) {
    identity.family = matchFamily(identity, existingUsers, familyIndex);
    identity.plannedUser.customDetails.importFamilyMatchStatus = identity.family.plannedAction === 'NONE' ? 'none' : 'suggested';
    identity.plannedUser.customDetails.importFamilyConfidence = identity.family.confidence;
    identity.plannedUser.customDetails.importFamilyCandidateIds = identity.family.candidates.slice(0, 5).map((candidate) => candidate.candidateUserId).join(' | ');
    identity.family.candidates = identity.family.candidates.map(({ user, ...candidate }) => candidate);
  }
  return identities;
}

function validateManualFamilyMappings(mappings, identities, existingUsers) {
  const identitiesByKey = new Map(identities.map((identity) => [identity.stablePersonKey, identity]));
  const usersById = new Map(existingUsers.map((user) => [idOf(user), user]));
  const errors = [];
  const approved = [];
  for (const mapping of mappings) {
    if (!mapping.decision) continue;
    if (!['APPROVE', 'REJECT', 'SKIP'].includes(mapping.decision)) {
      errors.push(`Invalid decision for ${mapping.stablePersonKey}`);
      continue;
    }
    if (mapping.decision !== 'APPROVE') continue;
    const identity = identitiesByKey.get(mapping.stablePersonKey);
    if (!identity) { errors.push(`Unknown stable person key ${mapping.stablePersonKey}`); continue; }
    if (identity.blockers.length) { errors.push(`Blocked identity cannot receive manual family approval: ${mapping.stablePersonKey}`); continue; }
    const father = mapping.approvedFatherId ? usersById.get(mapping.approvedFatherId) : null;
    const mother = mapping.approvedMotherId ? usersById.get(mapping.approvedMotherId) : null;
    const household = mapping.approvedHouseholdUserId ? usersById.get(mapping.approvedHouseholdUserId) : null;
    if (mapping.approvedFatherId && !father) errors.push(`Approved father does not exist: ${mapping.approvedFatherId}`);
    if (mapping.approvedMotherId && !mother) errors.push(`Approved mother does not exist: ${mapping.approvedMotherId}`);
    if (mapping.approvedHouseholdUserId && !household) errors.push(`Approved household user does not exist: ${mapping.approvedHouseholdUserId}`);
    if (father?.gender && father.gender !== 'male') errors.push(`Approved father gender is incompatible: ${mapping.approvedFatherId}`);
    if (mother?.gender && mother.gender !== 'female') errors.push(`Approved mother gender is incompatible: ${mapping.approvedMotherId}`);
    if (father && mother && idOf(father) === idOf(mother)) errors.push(`Father and mother cannot be the same user: ${mapping.stablePersonKey}`);
    if ((mapping.approvedFatherId && !father) || (mapping.approvedMotherId && !mother) || (mapping.approvedHouseholdUserId && !household)) continue;
    approved.push({ stablePersonKey: mapping.stablePersonKey, fatherId: mapping.approvedFatherId || '', motherId: mapping.approvedMotherId || '', householdUserId: mapping.approvedHouseholdUserId || '', notes: mapping.notes || '' });
  }
  return { approved, errors };
}

module.exports = {
  normalizedTokens,
  fatherPrefixEvidence,
  currentAge,
  ageConflict,
  householdKey,
  buildFamilyIndex,
  buildFatherCandidates,
  resolveMotherFromFather,
  matchFamily,
  applyFamilyMatches,
  validateManualFamilyMappings,
};
