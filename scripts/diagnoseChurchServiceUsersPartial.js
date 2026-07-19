#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const config = require('../src/config/env');
const User = require('../src/modules/users/user.model');
const Meeting = require('../src/modules/meetings/meeting.model');
const { normalizeArabicComparison } = require('../src/utils/arabicNormalization');
const { buildNameLookup, resolveName } = require('./churchServiceImport/matching');
const { writeCsv } = require('./churchServiceImport/reports');

function option(argv, name) {
  const prefix = `--${name}=`;
  const token = argv.find((entry) => entry.startsWith(prefix));
  return token ? path.resolve(token.slice(prefix.length).replace(/^"|"$/g, '')) : '';
}

function idOf(value) {
  return String(value?._id || value?.id || value || '');
}

function timestampName(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return `church-service-users-incident-diagnostic-${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function sourceKeyOf(user) {
  return String(user.customDetails?.importSourceKey || '').trim();
}

function nonEmpty(value) {
  if (Array.isArray(value)) return value.length > 0;
  if (value && typeof value === 'object') return Boolean(value.userId || Object.keys(value).length);
  return value !== undefined && value !== null && value !== '' && value !== false;
}

async function diagnose(planPath, reportsRoot) {
  const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
  await mongoose.connect(config.mongo.uri, { autoIndex: false, autoCreate: false, serverSelectionTimeoutMS: 10000, connectTimeoutMS: 10000, socketTimeoutMS: 30000 });
  const databaseName = mongoose.connection.name;
  const users = await User.find({ includeDeleted: true })
    .select('+passwordHash _id fullName accountStatus hasLogin role isLocked isDeleted nationalId phonePrimary phoneSecondary whatsappNumber email username birthDate ageGroup father mother spouse siblings children familyMembers familyName houseName meetingIds meetingAttendance customDetails createdAt updatedAt')
    .lean();
  const activeUsers = users.filter((user) => !user.isDeleted);
  const activeLookup = buildNameLookup(activeUsers);
  const usersBySourceKey = new Map();
  for (const user of users) {
    const key = sourceKeyOf(user);
    if (!key) continue;
    if (!usersBySourceKey.has(key)) usersBySourceKey.set(key, []);
    usersBySourceKey.get(key).push(user);
  }

  const safeIdentities = (plan.identities || []).filter((identity) => identity.operation === 'CREATE' && identity.classification === 'MISSING_SAFE_TO_CREATE');
  const identityResults = [];
  const importedIds = new Set();
  for (const identity of safeIdentities) {
    const sourceMatches = usersBySourceKey.get(identity.importSourceKey) || [];
    const activeSourceMatches = sourceMatches.filter((user) => !user.isDeleted);
    let status = 'MISSING';
    let matched = [];
    if (activeSourceMatches.length === 1) {
      status = 'NO_OP_ALREADY_IMPORTED';
      matched = activeSourceMatches;
      importedIds.add(idOf(activeSourceMatches[0]));
    } else if (activeSourceMatches.length > 1) {
      status = 'DUPLICATE_IMPORT_SOURCE_KEY';
      matched = activeSourceMatches;
      activeSourceMatches.forEach((user) => importedIds.add(idOf(user)));
    } else if (sourceMatches.some((user) => user.isDeleted)) {
      status = 'SOFT_DELETED_SOURCE_KEY_MATCH';
      matched = sourceMatches;
    } else {
      const nameMatch = resolveName(identity.canonicalFullName, activeLookup);
      if (['EXACT_MATCH', 'NORMALIZED_MATCH'].includes(nameMatch.status)) {
        status = 'REUSE_EXISTING';
        matched = [nameMatch.matched];
      } else if (nameMatch.status === 'AMBIGUOUS') {
        status = 'NEW_AMBIGUITY';
        matched = nameMatch.candidates || [];
      }
    }
    identityResults.push({ identity, status, matched });
  }

  const batchUsers = users.filter((user) => user.customDetails?.importBatchId === plan.batchId);
  batchUsers.forEach((user) => importedIds.add(idOf(user)));
  const importedUsers = users.filter((user) => importedIds.has(idOf(user)));
  const requiredMetadata = ['importSourceKey', 'importBatchId', 'importSourceWorkbook', 'importSheet', 'importNormalizedName', 'importRowNumbers'];
  const metadataFailures = importedUsers.filter((user) => requiredMetadata.some((field) => !String(user.customDetails?.[field] || '').trim()));
  const credentialOrIdentifierFields = ['passwordHash', 'nationalId', 'phonePrimary', 'phoneSecondary', 'whatsappNumber', 'email', 'username', 'birthDate', 'ageGroup'];
  const forbiddenFieldFindings = importedUsers.flatMap((user) => {
    const fields = [
      ...(user.hasLogin ? ['hasLogin'] : []),
      ...credentialOrIdentifierFields.filter((field) => nonEmpty(user[field])),
    ];
    return fields.length ? [{ userId: idOf(user), fullName: user.fullName, type: 'FORBIDDEN_FIELD', details: fields.join(' | ') }] : [];
  });
  const directRelationshipFields = ['father', 'mother', 'spouse', 'siblings', 'children', 'familyMembers', 'familyName', 'houseName', 'meetingIds', 'meetingAttendance'];
  const directRelationships = importedUsers.flatMap((user) => {
    const fields = directRelationshipFields.filter((field) => nonEmpty(user[field]));
    return fields.length ? [{ userId: idOf(user), fullName: user.fullName, type: 'DIRECT_RELATIONSHIP_DATA', details: fields.join(' | ') }] : [];
  });
  const inverseRelationships = users.flatMap((user) => {
    const references = [
      ['father', user.father?.userId], ['mother', user.mother?.userId], ['spouse', user.spouse?.userId],
      ...(user.siblings || []).map((entry) => ['siblings', entry.userId]),
      ...(user.children || []).map((entry) => ['children', entry.userId]),
      ...(user.familyMembers || []).map((entry) => ['familyMembers', entry.userId]),
    ].filter(([, ref]) => importedIds.has(idOf(ref)));
    return references.map(([field, ref]) => ({ userId: idOf(user), fullName: user.fullName, type: 'INVERSE_FAMILY_REFERENCE', details: `${field}->${idOf(ref)}` }));
  });

  const importedIdList = [...importedIds].map((id) => new mongoose.Types.ObjectId(id));
  const meetings = importedIdList.length ? await Meeting.find({
    $or: [
      { servedUserIds: { $in: importedIdList } },
      { 'groupAssignments.servedUserIds': { $in: importedIdList } },
      { 'servants.userId': { $in: importedIdList } },
      { 'servants.servedUserIds': { $in: importedIdList } },
      { 'servants.groupAssignments.servedUserIds': { $in: importedIdList } },
      { 'committees.memberUserIds': { $in: importedIdList } },
    ],
  }).select('_id name').lean() : [];

  const duplicatedSourceKeys = [...usersBySourceKey.entries()]
    .filter(([key, matches]) => safeIdentities.some((identity) => identity.importSourceKey === key) && matches.filter((user) => !user.isDeleted).length > 1)
    .map(([key, matches]) => ({ type: 'DUPLICATE_IMPORT_SOURCE_KEY', key, ids: matches.map(idOf), names: matches.map((user) => user.fullName) }));
  const normalizedImported = new Map();
  for (const user of importedUsers.filter((entry) => !entry.isDeleted)) {
    const normalized = normalizeArabicComparison(user.fullName);
    if (!normalizedImported.has(normalized)) normalizedImported.set(normalized, []);
    normalizedImported.get(normalized).push(user);
  }
  const duplicatedNormalizedCreated = [...normalizedImported.entries()]
    .filter(([, matches]) => matches.length > 1)
    .map(([key, matches]) => ({ type: 'DUPLICATE_NORMALIZED_IMPORTED_NAME', key, ids: matches.map(idOf), names: matches.map((user) => user.fullName) }));
  const normalizedAllActive = new Map();
  for (const user of activeUsers) {
    const normalized = normalizeArabicComparison(user.fullName);
    if (!normalizedAllActive.has(normalized)) normalizedAllActive.set(normalized, []);
    normalizedAllActive.get(normalized).push(user);
  }
  const duplicatedNormalizedIncludingExisting = [...normalizedAllActive.entries()]
    .filter(([, matches]) => matches.length > 1 && matches.some((user) => importedIds.has(idOf(user))))
    .map(([key, matches]) => ({ type: 'DUPLICATE_NORMALIZED_NAME_INCLUDING_IMPORTED_USER', key, ids: matches.map(idOf), names: matches.map((user) => user.fullName) }));

  let committedPrefix = 0;
  for (const result of identityResults) {
    if (result.status !== 'NO_OP_ALREADY_IMPORTED') break;
    committedPrefix += 1;
  }
  const lastCommitted = committedPrefix ? identityResults[committedPrefix - 1] : null;
  const firstUncommitted = identityResults[committedPrefix] || null;
  const counts = Object.fromEntries([...new Set(identityResults.map((entry) => entry.status))].map((status) => [status, identityResults.filter((entry) => entry.status === status).length]));
  const result = {
    generatedAt: new Date().toISOString(),
    mode: 'READ_ONLY_INCIDENT_DIAGNOSTIC',
    databaseName,
    stalePlanPath: planPath,
    stalePlanChecksum: plan.planChecksum,
    stalePlanBatchId: plan.batchId,
    originalSafeUsers: safeIdentities.length,
    counts,
    confirmedCreatedByBatchId: batchUsers.length,
    sourceKeyRecovered: identityResults.filter((entry) => entry.status === 'NO_OP_ALREADY_IMPORTED').length,
    remainingMissing: identityResults.filter((entry) => entry.status === 'MISSING').length,
    duplicateSourceKeys: duplicatedSourceKeys.length,
    duplicateNormalizedImportedNames: duplicatedNormalizedCreated.length,
    duplicateNormalizedNamesIncludingExistingUsers: duplicatedNormalizedIncludingExisting.length,
    metadataFailures: metadataFailures.length,
    forbiddenFieldFindings: forbiddenFieldFindings.length,
    directRelationshipFindings: directRelationships.length,
    inverseRelationshipFindings: inverseRelationships.length,
    meetingOrGroupDocumentsReferencingImportedUsers: meetings.length,
    committedPrefix,
    lastCommitted: lastCommitted ? { stablePersonKey: lastCommitted.identity.stablePersonKey, sourceKey: lastCommitted.identity.importSourceKey, userId: idOf(lastCommitted.matched[0]), name: lastCommitted.identity.canonicalFullName } : null,
    firstNotConfirmedCommitted: firstUncommitted ? { stablePersonKey: firstUncommitted.identity.stablePersonKey, sourceKey: firstUncommitted.identity.importSourceKey, status: firstUncommitted.status, name: firstUncommitted.identity.canonicalFullName } : null,
    relationshipMeetingIds: meetings.map(idOf),
  };

  const reportDir = path.join(reportsRoot, timestampName(new Date(result.generatedAt)));
  fs.mkdirSync(reportDir, { recursive: true });
  fs.writeFileSync(path.join(reportDir, 'diagnostic.json'), `${JSON.stringify({ ...result, identities: identityResults.map((entry) => ({ stablePersonKey: entry.identity.stablePersonKey, importSourceKey: entry.identity.importSourceKey, canonicalFullName: entry.identity.canonicalFullName, status: entry.status, matchedIds: entry.matched.map(idOf) })), duplicateDetails: [...duplicatedSourceKeys, ...duplicatedNormalizedCreated, ...duplicatedNormalizedIncludingExisting], forbiddenDetails: [...forbiddenFieldFindings, ...directRelationships, ...inverseRelationships] }, null, 2)}\n`, 'utf8');
  const summary = [
    '# Interrupted church-service users apply diagnostic', '',
    '- Mode: READ ONLY',
    `- Generated: ${result.generatedAt}`,
    `- Database: \`${databaseName}\``,
    `- Stale plan checksum: \`${plan.planChecksum}\``,
    `- Original safe users: ${result.originalSafeUsers}`,
    `- Confirmed created with the stale batch ID: ${result.confirmedCreatedByBatchId}`,
    `- Recovered by import source key: ${result.sourceKeyRecovered}`,
    `- Remaining genuinely missing: ${result.remainingMissing}`,
    `- Reused by a new name match without source key: ${counts.REUSE_EXISTING || 0}`,
    `- New ambiguities: ${counts.NEW_AMBIGUITY || 0}`,
    `- Duplicate import source keys: ${result.duplicateSourceKeys}`,
    `- Duplicate normalized imported names: ${result.duplicateNormalizedImportedNames}`,
    `- Duplicate normalized names including an imported user: ${result.duplicateNormalizedNamesIncludingExistingUsers}`,
    `- Missing required import metadata: ${result.metadataFailures}`,
    `- Forbidden credential/identifier findings: ${result.forbiddenFieldFindings}`,
    `- Direct family/household/meeting findings: ${result.directRelationshipFindings}`,
    `- Inverse family findings: ${result.inverseRelationshipFindings}`,
    `- Meeting/group documents referencing imported users: ${result.meetingOrGroupDocumentsReferencingImportedUsers}`,
    `- Consecutive committed prefix: ${result.committedPrefix}`,
    `- Last confirmed committed source key: \`${result.lastCommitted?.sourceKey || 'none'}\``,
    `- First source key not confirmed committed: \`${result.firstNotConfirmedCommitted?.sourceKey || 'none'}\``, '',
    'Per-user MongoDB transactions are atomic. A source-key record with complete metadata is committed; an absent source-key record has no partial user document. The diagnostic cannot identify a server-side commit whose record lacks all planned identifiers, so metadata and name checks are reported separately.', '',
  ].join('\n');
  fs.writeFileSync(path.join(reportDir, 'summary.md'), summary, 'utf8');
  writeCsv(path.join(reportDir, 'incident-users.csv'), ['Stable person key', 'Import source key', 'Canonical full name', 'Status', 'Matched IDs'], identityResults.map((entry) => ({ 'Stable person key': entry.identity.stablePersonKey, 'Import source key': entry.identity.importSourceKey, 'Canonical full name': entry.identity.canonicalFullName, Status: entry.status, 'Matched IDs': entry.matched.map(idOf) })));
  writeCsv(path.join(reportDir, 'duplicates.csv'), ['Type', 'Key', 'User IDs', 'Names'], [...duplicatedSourceKeys, ...duplicatedNormalizedCreated, ...duplicatedNormalizedIncludingExisting].map((entry) => ({ Type: entry.type, Key: entry.key, 'User IDs': entry.ids, Names: entry.names })));
  writeCsv(path.join(reportDir, 'forbidden-findings.csv'), ['User ID', 'Full name', 'Type', 'Details'], [...forbiddenFieldFindings, ...directRelationships, ...inverseRelationships].map((entry) => ({ 'User ID': entry.userId, 'Full name': entry.fullName, Type: entry.type, Details: entry.details })));
  return { result, reportDir };
}

async function main() {
  const planPath = option(process.argv.slice(2), 'plan-file');
  if (!planPath) throw new Error('--plan-file=<stale-plan-path> is required');
  const reportsRoot = path.resolve(__dirname, '..', 'reports');
  try {
    const output = await diagnose(planPath, reportsRoot);
    console.log(JSON.stringify({ reportDir: output.reportDir, ...output.result }, null, 2));
  } finally {
    await mongoose.disconnect();
  }
}

if (require.main === module) main().catch((error) => { console.error(`Diagnostic failed: ${error.message}`); process.exitCode = 1; });

module.exports = { diagnose, nonEmpty };
