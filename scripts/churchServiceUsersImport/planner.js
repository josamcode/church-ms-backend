const path = require('path');
const crypto = require('crypto');
const { buildMissingIdentityPlan } = require('./identityPlanner');
const { applyFamilyMatches } = require('./familyMatcher');

function conflict(type, severity, identity, message, extra = {}) {
  return {
    type,
    severity,
    stablePersonKey: identity?.stablePersonKey || '',
    name: identity?.canonicalFullName || extra.name || '',
    rows: identity?.rowNumbers || extra.rows || [],
    message,
    ...extra,
  };
}

function calculateUserStateFingerprint(users) {
  const rows = (users || []).map((user) => ({
    id: String(user._id || user.id || ''),
    fullName: String(user.fullName || ''),
    isDeleted: Boolean(user.isDeleted),
    importSourceKey: String(user.customDetails?.importSourceKey || ''),
  })).sort((a, b) => a.id.localeCompare(b.id));
  return crypto.createHash('sha256').update(JSON.stringify(rows), 'utf8').digest('hex');
}

function buildUsersImportPlan({ parsed, activeUsers, allUsers, databaseName, inputPath, inputHash, generatedAt, validateUserPayload }) {
  const batchId = `church-service-users-${generatedAt.replace(/[^0-9]/g, '').slice(0, 14)}`;
  const built = buildMissingIdentityPlan({ rows: parsed.rows, activeUsers, allUsers, batchId, workbookName: path.basename(inputPath) });
  const identities = applyFamilyMatches(built.identities, activeUsers);
  const conflicts = [];

  for (const source of built.classifications) {
    if (source.classification === 'EXISTING_AMBIGUOUS') conflicts.push(conflict('EXISTING_AMBIGUOUS_PERSON', 'BLOCKER', null, `Existing user match is ambiguous for ${source.original}`, { name: source.original, rows: source.rows, candidates: source.candidates }));
    if (source.classification === 'INVALID_SOURCE_NAME') conflicts.push(conflict('INVALID_SOURCE_NAME', 'BLOCKER', null, `Invalid Excel person name: ${source.original}`, { name: source.original, rows: source.rows }));
    if (source.classification === 'MANUAL_REVIEW_REQUIRED') conflicts.push(conflict('SOFT_DELETED_OR_HISTORICAL_MATCH', 'BLOCKER', null, `A deleted or historical user matches ${source.original}`, { name: source.original, rows: source.rows }));
  }

  for (const identity of identities) {
    if (identity.operation === 'CREATE' && validateUserPayload) {
      const validationErrors = validateUserPayload(identity.plannedUser);
      if (validationErrors.length) {
        identity.operation = 'BLOCKED';
        identity.classification = 'MANUAL_REVIEW_REQUIRED';
        identity.blockers.push(...validationErrors);
      }
    }
    for (const reason of identity.homonymReasons) conflicts.push(conflict(reason.includes('gender') || reason.includes('Gender') ? 'CONTRADICTORY_GENDER_CONTEXT' : 'POTENTIAL_HOMONYM', 'BLOCKER', identity, reason));
    for (const blocker of identity.blockers.filter((reason) => !identity.homonymReasons.includes(reason))) conflicts.push(conflict(blocker.includes('name requirements') ? 'INVALID_SOURCE_NAME' : blocker.includes('schema') ? 'REQUIRED_FIELD_OR_SCHEMA_FAILURE' : 'BLOCKED_USER', 'BLOCKER', identity, blocker));
    if (identity.family.confidence === 'AMBIGUOUS_FAMILY') conflicts.push(conflict('AMBIGUOUS_FAMILY', 'WARNING', identity, identity.family.conflicts.join(' | ')));
    if (identity.family.confidence === 'FAMILY_CONFLICT') conflicts.push(conflict('EXISTING_FAMILY_CONFLICT', 'WARNING', identity, identity.family.conflicts.join(' | ')));
  }

  const safeIdentities = identities.filter((identity) => identity.operation === 'CREATE');
  const automaticFamilyLinks = safeIdentities.flatMap((identity) => {
    if (identity.family.confidence !== 'HIGH_CONFIDENCE_AUTO_LINK') return [];
    return [
      ...(identity.family.father ? [{ stablePersonKey: identity.stablePersonKey, relation: 'father', parentUserId: identity.family.father.id, evidence: identity.family.evidence }] : []),
      ...(identity.family.mother ? [{ stablePersonKey: identity.stablePersonKey, relation: 'mother', parentUserId: identity.family.mother.id, evidence: identity.family.evidence }] : []),
    ];
  });
  const recordBlockers = conflicts.filter((entry) => entry.severity === 'BLOCKER');
  const globalExecutionErrors = [];
  const familyCounts = (confidence) => identities.filter((identity) => identity.family.confidence === confidence).length;
  const totals = {
    totalExcelNames: built.classifications.length,
    existingExactUsers: built.classifications.filter((entry) => entry.sourceMatchStatus === 'EXACT_MATCH').length,
    existingNormalizedUsers: built.classifications.filter((entry) => entry.sourceMatchStatus === 'NORMALIZED_MATCH').length,
    noOpAlreadyImported: new Set(built.classifications.filter((entry) => entry.classification === 'NO_OP_ALREADY_IMPORTED').map((entry) => entry.normalizedName)).size,
    reuseExisting: new Set(built.classifications.filter((entry) => entry.classification === 'REUSE_EXISTING').map((entry) => entry.normalizedName)).size,
    existingAmbiguousUsers: built.classifications.filter((entry) => entry.classification === 'EXISTING_AMBIGUOUS').length,
    missingIdentityCandidates: identities.length,
    safeUsersToCreate: safeIdentities.length,
    potentialHomonyms: identities.filter((identity) => identity.operation === 'POTENTIAL_HOMONYM').length,
    invalidNames: built.classifications.filter((entry) => entry.classification === 'INVALID_SOURCE_NAME').length + identities.filter((identity) => identity.classification === 'INVALID_SOURCE_NAME').length,
    blockedUsers: identities.filter((identity) => ['BLOCKED', 'AMBIGUOUS', 'POTENTIAL_HOMONYM'].includes(identity.operation)).length,
    usersWithKnownGender: identities.filter((identity) => identity.gender).length,
    usersWithUnknownGender: identities.filter((identity) => !identity.gender).length,
    usersWithMappedEducation: identities.filter((identity) => identity.education).length,
    usersWithUnknownEducation: identities.filter((identity) => !identity.education).length,
    highConfidenceFamilyLinks: automaticFamilyLinks.length,
    highConfidenceFamilyIdentities: familyCounts('HIGH_CONFIDENCE_AUTO_LINK'),
    mediumConfidenceFamilySuggestions: familyCounts('MEDIUM_CONFIDENCE_SUGGESTION'),
    lowConfidenceFamilySuggestions: familyCounts('LOW_CONFIDENCE_SUGGESTION'),
    ambiguousFamilies: familyCounts('AMBIGUOUS_FAMILY'),
    familyConflicts: familyCounts('FAMILY_CONFLICT'),
    noFamilyCandidates: familyCounts('NO_FAMILY_CANDIDATE'),
    recordBlockers: recordBlockers.length,
    globalExecutionErrors: globalExecutionErrors.length,
  };
  return {
    schemaVersion: 3,
    executionModel: 'RESILIENT_SEPARATE_USERS_FAMILIES_ASSIGNMENTS_V2',
    generatedAt,
    mode: 'DRY_RUN',
    batchId,
    input: { path: inputPath, sha256: inputHash, sheet: parsed.sheetName },
    database: { name: databaseName, userStateFingerprint: calculateUserStateFingerprint(allUsers) },
    sourceClassifications: built.classifications,
    identities,
    proposedHighConfidenceFamilyRelationships: automaticFamilyLinks,
    approvedAutomaticFamilyRelationships: [],
    approvedManualFamilyRelationships: [],
    warnings: conflicts.filter((entry) => entry.severity === 'WARNING'),
    recordBlockers,
    globalExecutionErrors,
    blockers: recordBlockers,
    blockingErrors: globalExecutionErrors,
    conflicts,
    totals,
    safeToApplyUsersOnly: globalExecutionErrors.length === 0,
    safeToApply: globalExecutionErrors.length === 0,
    planChecksum: null,
  };
}

module.exports = { calculateUserStateFingerprint, buildUsersImportPlan };
