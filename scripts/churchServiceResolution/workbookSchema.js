const crypto = require('crypto');
const { canonicalize } = require('./workbookSupport');

const WORKBOOK_VERSION = '2.0';
const SHEETS = Object.freeze(['Instructions', 'Summary', 'Group Alias Review', 'Duplicate User Review', 'Identity Review', 'Identity Candidates', 'Group Conflicts', 'Servant Conflicts', 'Validation Results']);
const IDENTITY_DECISIONS = Object.freeze(['MAP_EXISTING_USER', 'SPLIT_SOURCE_IDENTITY', 'CREATE_NEW_PERSON', 'CORRECT_SOURCE_NAME', 'SKIP_INVALID_SOURCE', 'SKIP_OCCURRENCES']);
const GROUP_DECISIONS = Object.freeze(['KEEP_ONE_GROUP', 'ALLOW_BOTH_GROUPS', 'KEEP_EXISTING_GROUP', 'SKIP_PERSON_IN_MEETING', 'SOURCE_DATA_ERROR']);
const SERVANT_DECISIONS = Object.freeze(['USE_SOURCE_SET', 'USE_MANUAL_SERVANT_IDS', 'MERGE_ALL_RESOLVED_SERVANTS', 'KEEP_EXISTING_SERVANTS', 'SKIP_SERVANT_ASSIGNMENTS']);
const ALIAS_DECISIONS = Object.freeze(['SAME_GROUP_ALIAS', 'DIFFERENT_GROUPS', 'SOURCE_NAME_ERROR', 'REVIEW_REQUIRED']);
const DUPLICATE_USER_DECISIONS = Object.freeze(['MAP_TO_CANONICAL_USER', 'DISTINCT_PEOPLE', 'REQUIRES_DATABASE_DEDUPLICATION', 'SKIP_SOURCE_IDENTITY']);

const IDENTITY_COLUMNS = Object.freeze(['identityKey', 'normalizedName', 'sourceSpellings', 'roles', 'meetings', 'groups', 'grades', 'excelRows', 'currentStatus', 'candidateCount', 'candidateUserIds', 'candidateUserNames', 'candidateSummary', 'recommendedDecision', 'recommendationReason', 'confidence', 'manualDecision', 'approvedUserId', 'correctedCanonicalName', 'splitDefinition', 'notes', 'validationStatus', 'validationMessage']);
const CANDIDATE_COLUMNS = Object.freeze(['identityKey', 'sourceName', 'normalizedName', 'candidateUserId', 'candidateFullName', 'candidateGender', 'candidateBirthDate', 'candidateAgeGroup', 'candidateEducation', 'candidateFamilyName', 'candidateHouseName', 'candidateMeetings', 'candidateGroups', 'candidateImportSource', 'candidateIsDeleted', 'candidateHasLogin', 'matchReason', 'conflictingEvidence', 'supportingEvidence', 'aiAmbiguityReason', 'aiConfidence']);
const GROUP_COLUMNS = Object.freeze(['conflictKey', 'userId', 'userFullName', 'meetingId', 'meetingName', 'sourceGroups', 'sourceRowsByGroup', 'existingMeetingMembership', 'existingGroupMembership', 'domainAllowsMultipleGroups', 'recommendedDecision', 'recommendationReason', 'manualDecision', 'approvedGroupName', 'notes', 'validationStatus', 'validationMessage']);
const SERVANT_COLUMNS = Object.freeze(['conflictKey', 'sector', 'meeting', 'grade', 'groupName', 'candidateServantSets', 'candidateServantIds', 'sourceRowsBySet', 'resolvedSameUsers', 'recommendedDecision', 'recommendationReason', 'manualDecision', 'approvedServantUserIds', 'approvedSourceSet', 'notes', 'validationStatus', 'validationMessage']);
const ALIAS_COLUMNS = Object.freeze(['aliasKey', 'sector', 'meetingId', 'meetingName', 'firstGroupName', 'secondGroupName', 'firstGroupExisting', 'secondGroupExisting', 'affectedPeopleCount', 'affectedUserIds', 'firstGroupRows', 'secondGroupRows', 'normalizedSimilarity', 'sharedAddressTokens', 'existingDatabaseEvidence', 'recommendedDecision', 'recommendationReason', 'manualDecision', 'canonicalGroupName', 'notes', 'validationStatus', 'validationMessage']);
const DUPLICATE_USER_COLUMNS = Object.freeze(['duplicateReviewKey', 'identityKey', 'sourceName', 'meeting', 'group', 'candidateUserIds', 'candidateNames', 'sameNormalizedName', 'sameGender', 'sameBirthDate', 'sameNationalId', 'samePhone', 'sameFamilyName', 'sameHouseName', 'sameParents', 'sameImportSource', 'candidateDataCompleteness', 'candidateLoginStatus', 'candidateRelationshipCounts', 'candidateMeetingCounts', 'candidateActivityCounts', 'classification', 'recommendedCanonicalUserId', 'recommendationReason', 'manualDecision', 'approvedCanonicalUserId', 'notes', 'validationStatus', 'validationMessage']);

const MANUAL_COLUMNS = Object.freeze({
  'Identity Review': new Set(['manualDecision', 'approvedUserId', 'correctedCanonicalName', 'splitDefinition', 'notes']),
  'Group Conflicts': new Set(['manualDecision', 'approvedGroupName', 'notes']),
  'Servant Conflicts': new Set(['manualDecision', 'approvedServantUserIds', 'approvedSourceSet', 'notes']),
  'Group Alias Review': new Set(['manualDecision', 'canonicalGroupName', 'notes']),
  'Duplicate User Review': new Set(['manualDecision', 'approvedCanonicalUserId', 'notes']),
});
const VALIDATION_COLUMNS = new Set(['validationStatus', 'validationMessage']);

/**
 * Advisory columns are excluded from `generatedFieldsHash`.
 *
 * They hold model-generated explanations, which are non-deterministic: the same
 * input can produce different wording on a later run, and the columns are empty
 * entirely when AI is disabled. Including them would make the integrity hash
 * fail on every regeneration, which would train reviewers to ignore a
 * tampering signal that is supposed to mean something.
 *
 * These columns are explanatory only. No decision reads them.
 */
const ADVISORY_COLUMNS = new Set(['aiAmbiguityReason', 'aiConfidence']);

function stableKey(prefix, value) {
  return `${prefix}-${crypto.createHash('sha256').update(String(value), 'utf8').digest('hex').slice(0, 24)}`;
}

function generatedRowsPayload(data) {
  const sheets = {
    'Identity Review': { columns: IDENTITY_COLUMNS, rows: data.identityRows || [] },
    'Identity Candidates': { columns: CANDIDATE_COLUMNS, rows: data.candidateRows || [] },
    'Group Conflicts': { columns: GROUP_COLUMNS, rows: data.groupRows || [] },
    'Servant Conflicts': { columns: SERVANT_COLUMNS, rows: data.servantRows || [] },
    'Group Alias Review': { columns: ALIAS_COLUMNS, rows: data.aliasRows || [] },
    'Duplicate User Review': { columns: DUPLICATE_USER_COLUMNS, rows: data.duplicateRows || [] },
  };
  return Object.fromEntries(Object.entries(sheets).map(([sheet, value]) => {
    const generatedColumns = value.columns.filter((column) => !MANUAL_COLUMNS[sheet]?.has(column) && !VALIDATION_COLUMNS.has(column) && !ADVISORY_COLUMNS.has(column));
    return [sheet, value.rows.map((row) => Object.fromEntries(generatedColumns.map((column) => [column, row[column] == null ? '' : String(row[column])])))];
  }));
}

function generatedFieldsHash(data) {
  return crypto.createHash('sha256').update(JSON.stringify(canonicalize(generatedRowsPayload(data))), 'utf8').digest('hex');
}

module.exports = { WORKBOOK_VERSION, SHEETS, IDENTITY_DECISIONS, GROUP_DECISIONS, SERVANT_DECISIONS, ALIAS_DECISIONS, DUPLICATE_USER_DECISIONS, IDENTITY_COLUMNS, CANDIDATE_COLUMNS, GROUP_COLUMNS, SERVANT_COLUMNS, ALIAS_COLUMNS, DUPLICATE_USER_COLUMNS, MANUAL_COLUMNS, VALIDATION_COLUMNS, ADVISORY_COLUMNS, stableKey, generatedRowsPayload, generatedFieldsHash };
