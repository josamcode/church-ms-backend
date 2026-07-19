const fs = require('fs');
const ExcelJS = require('exceljs');
const { scalarCellValue } = require('../churchServiceImport/workbook');
const { sha256File, assertPlanChecksum } = require('../churchServiceImport/integrity');
const { WORKBOOK_VERSION, SHEETS, IDENTITY_DECISIONS, GROUP_DECISIONS, SERVANT_DECISIONS, ALIAS_DECISIONS, DUPLICATE_USER_DECISIONS, IDENTITY_COLUMNS, CANDIDATE_COLUMNS, GROUP_COLUMNS, SERVANT_COLUMNS, ALIAS_COLUMNS, DUPLICATE_USER_COLUMNS, generatedFieldsHash } = require('./workbookSchema');
const { splitList, parseRows } = require('./workbookSupport');
const { normalizeArabicComparison } = require('../../src/utils/arabicNormalization');

const idOf = (value) => String(value?._id || value?.id || value || '');
const unique = (values) => [...new Set((values || []).filter(Boolean))];

function valueOf(cell) {
  return scalarCellValue(cell.value, cell.address);
}

function readMetadata(workbook) {
  const sheet = workbook.getWorksheet('Instructions');
  if (!sheet) throw new Error('Missing Instructions sheet');
  let marker = 0;
  for (let row = 1; row <= sheet.rowCount; row += 1) if (valueOf(sheet.getCell(row, 1)) === 'WORKBOOK_METADATA') marker = row;
  if (!marker) throw new Error('Workbook metadata marker is missing');
  const metadata = {};
  for (let row = marker + 1; row <= sheet.rowCount; row += 1) {
    const key = valueOf(sheet.getCell(row, 1));
    if (!key) continue;
    metadata[key] = valueOf(sheet.getCell(row, 2));
  }
  return metadata;
}

function readSheetRows(workbook, sheetName, columns) {
  const sheet = workbook.getWorksheet(sheetName);
  if (!sheet) throw new Error(`Missing ${sheetName} sheet`);
  const actual = columns.map((_, index) => valueOf(sheet.getCell(1, index + 1)));
  if (JSON.stringify(actual) !== JSON.stringify(columns)) throw new Error(`${sheetName} columns or order were modified`);
  const rows = [];
  for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber += 1) {
    const row = Object.fromEntries(columns.map((column, index) => [column, valueOf(sheet.getCell(rowNumber, index + 1)).trim()]));
    if (Object.values(row).some(Boolean)) rows.push({ ...row, _rowNumber: rowNumber });
  }
  return rows;
}

function parseSplitDefinition(text, relevantRows, parsedRows) {
  let parsed;
  try { parsed = JSON.parse(text); } catch (error) { throw new Error(`splitDefinition must be valid JSON: ${error.message}`); }
  if (!Array.isArray(parsed.parts) || parsed.parts.length < 2) throw new Error('splitDefinition.parts must contain at least two parts');
  const relevant = new Set(relevantRows);
  const claimed = new Map();
  const parts = parsed.parts.map((part, index) => {
    if (!part.identityKey) throw new Error(`Split part ${index + 1} requires identityKey`);
    let rows = Array.isArray(part.rows) ? part.rows.map(Number) : [];
    if (!rows.length && (part.meeting || part.group || part.grade)) {
      rows = parsedRows.filter((row) => relevant.has(row.rowNumber)
        && (!part.meeting || row.meeting === part.meeting)
        && (!part.group || row.group === part.group)
        && (!part.grade || row.grade === part.grade)).map((row) => row.rowNumber);
    }
    if (!rows.length) throw new Error(`Split part ${part.identityKey} matches no occurrence rows`);
    rows.forEach((row) => {
      if (!relevant.has(row)) throw new Error(`Split part ${part.identityKey} includes unrelated row ${row}`);
      if (claimed.has(row)) throw new Error(`Excel row ${row} is assigned to multiple split identities`);
      claimed.set(row, part.identityKey);
    });
    return { identityKey: String(part.identityKey), rows: unique(rows), canonicalName: String(part.canonicalName || '').trim(), meeting: part.meeting || '', group: part.group || '', grade: part.grade || '' };
  });
  const missing = [...relevant].filter((row) => !claimed.has(row));
  if (missing.length) throw new Error(`Split does not assign every occurrence; missing rows: ${missing.join(', ')}`);
  if (new Set(parts.map((part) => part.identityKey)).size !== parts.length) throw new Error('Split part identityKey values must be unique');
  return parts;
}

function addResult(state, type, key, status, message) {
  state.results.push({ resultType: type, recordKey: key, status, message });
  if (status === 'ERROR') state.errors.push(`${type} ${key}: ${message}`);
  if (status === 'WARNING') state.warnings.push(`${type} ${key}: ${message}`);
}

function validateIdentityRows(rows, context, state) {
  const usersById = new Map(context.users.map((user) => [idOf(user), user]));
  const claimedUsers = new Map();
  rows.forEach((row) => {
    const decision = row.manualDecision;
    if (!decision) { state.unresolved += 1; addResult(state, 'IDENTITY', row.identityKey, 'WARNING', 'Manual decision is blank; identity remains unresolved'); return; }
    state.completed += 1;
    if (!IDENTITY_DECISIONS.includes(decision)) { addResult(state, 'IDENTITY', row.identityKey, 'ERROR', `Unknown decision ${decision}`); return; }
    const relevantRows = parseRows(row.excelRows);
    let error = '';
    let parsedDecision = { identityKey: row.identityKey, decision };
    if (decision === 'MAP_EXISTING_USER') {
      const user = usersById.get(row.approvedUserId);
      if (!row.approvedUserId) error = 'approvedUserId is required';
      else if (!user) error = 'approvedUserId does not exist';
      else if (user.isDeleted) error = 'approvedUserId belongs to a deleted user';
      else if (!user.fullName || !user.role) error = 'approvedUserId is not a valid person record';
      else if (!splitList(row.candidateUserIds).includes(row.approvedUserId) && !/^OVERRIDE:\s*\S/i.test(row.notes)) error = 'User is outside the candidate set; notes must begin OVERRIDE: and document authoritative evidence';
      else if (claimedUsers.has(row.approvedUserId) && claimedUsers.get(row.approvedUserId) !== row.identityKey) error = `User is already mapped by identity ${claimedUsers.get(row.approvedUserId)}`;
      else { claimedUsers.set(row.approvedUserId, row.identityKey); parsedDecision.approvedUserId = row.approvedUserId; parsedDecision.override = !splitList(row.candidateUserIds).includes(row.approvedUserId); }
    } else if (decision === 'SPLIT_SOURCE_IDENTITY') {
      if (!row.splitDefinition) error = 'splitDefinition is required';
      else { try { parsedDecision.parts = parseSplitDefinition(row.splitDefinition, relevantRows, context.parsedRows); } catch (splitError) { error = splitError.message; } }
    } else if (decision === 'CREATE_NEW_PERSON') {
      if (row.currentStatus === 'INVALID_NAME') error = 'Invalid source names cannot be selected for CREATE_NEW_PERSON';
      else if (!row.notes) error = 'Notes must document why the occurrences represent one distinct real person';
    } else if (decision === 'CORRECT_SOURCE_NAME') {
      if (!row.correctedCanonicalName || row.correctedCanonicalName.trim().length < 2) error = 'correctedCanonicalName of at least two characters is required';
      else parsedDecision.correctedCanonicalName = row.correctedCanonicalName.trim();
    } else if (decision === 'SKIP_INVALID_SOURCE') {
      if (row.currentStatus !== 'INVALID_NAME') error = 'SKIP_INVALID_SOURCE is permitted only for invalid source identities';
      else parsedDecision.rows = relevantRows;
    } else if (decision === 'SKIP_OCCURRENCES') {
      const all = /^ALL$/i.test(row.notes.trim());
      const match = row.notes.match(/rows\s*:\s*([\d\s,;|]+)/i);
      const selected = all ? relevantRows : parseRows(match?.[1] || '');
      if (!selected.length) error = 'Notes must specify ALL or rows: 2,3';
      else if (selected.some((number) => !relevantRows.includes(number))) error = 'SKIP_OCCURRENCES includes a row outside this identity';
      else parsedDecision.rows = selected;
    }
    if (error) addResult(state, 'IDENTITY', row.identityKey, 'ERROR', error);
    else { state.identityDecisions.set(row.identityKey, parsedDecision); addResult(state, 'IDENTITY', row.identityKey, 'VALID', `${decision} validated`); }
  });
}

function validateGroupRows(rows, context, state) {
  const meetingsById = new Map(context.meetings.map((meeting) => [idOf(meeting), meeting]));
  rows.forEach((row) => {
    const decision = row.manualDecision;
    if (!decision) { state.unresolved += 1; addResult(state, 'GROUP', row.conflictKey, 'WARNING', 'Manual decision is blank; conflict remains unresolved'); return; }
    state.completed += 1;
    if (!GROUP_DECISIONS.includes(decision)) { addResult(state, 'GROUP', row.conflictKey, 'ERROR', `Unknown decision ${decision}`); return; }
    let error = '';
    const parsedDecision = { conflictKey: row.conflictKey, decision, userId: row.userId, meetingId: row.meetingId };
    const sourceGroups = splitList(row.sourceGroups);
    const existingGroups = splitList(row.existingGroupMembership);
    const meeting = meetingsById.get(row.meetingId);
    const validMeetingGroups = unique([...(meeting?.groups || []), ...(meeting?.groupAssignments || []).map((entry) => entry.group), ...(meeting?.servants || []).flatMap((servant) => [...(servant.groupsManaged || []), ...(servant.groupAssignments || []).map((entry) => entry.group)])]);
    if (decision === 'KEEP_ONE_GROUP') {
      if (!row.approvedGroupName) error = 'approvedGroupName is required';
      else if (![...sourceGroups, ...validMeetingGroups].includes(row.approvedGroupName)) error = 'approvedGroupName is not a source or existing group in this meeting';
      else parsedDecision.approvedGroupName = row.approvedGroupName;
    } else if (decision === 'ALLOW_BOTH_GROUPS') {
      if (row.domainAllowsMultipleGroups !== 'YES') error = 'Current meeting service rejects multiple groups for one member in the same meeting';
    } else if (decision === 'KEEP_EXISTING_GROUP') {
      if (!existingGroups.length) error = 'No existing group membership is available to keep';
    } else if (decision === 'SOURCE_DATA_ERROR' && !row.notes) error = 'SOURCE_DATA_ERROR requires explanatory notes';
    if (error) addResult(state, 'GROUP', row.conflictKey, 'ERROR', error);
    else { state.groupDecisions.set(row.conflictKey, parsedDecision); addResult(state, 'GROUP', row.conflictKey, 'VALID', `${decision} validated`); }
  });
}

function parseLabelledLines(value) {
  const map = new Map();
  String(value || '').split(/\r?\n/).forEach((line) => {
    const match = line.match(/^(SET_\d+):\s*(.*)$/);
    if (match) map.set(match[1], splitList(match[2]));
  });
  return map;
}

function validateServantRows(rows, context, state) {
  const usersById = new Map(context.users.map((user) => [idOf(user), user]));
  rows.forEach((row) => {
    const decision = row.manualDecision;
    if (!decision) { state.unresolved += 1; addResult(state, 'SERVANT', row.conflictKey, 'WARNING', 'Manual decision is blank; conflict remains unresolved'); return; }
    state.completed += 1;
    if (!SERVANT_DECISIONS.includes(decision)) { addResult(state, 'SERVANT', row.conflictKey, 'ERROR', `Unknown decision ${decision}`); return; }
    const nameSets = parseLabelledLines(row.candidateServantSets);
    const idSets = parseLabelledLines(row.candidateServantIds);
    let error = '';
    const parsedDecision = { conflictKey: row.conflictKey, decision };
    if (decision === 'USE_SOURCE_SET') {
      if (!row.approvedSourceSet || !nameSets.has(row.approvedSourceSet)) error = 'approvedSourceSet must select a listed SET_n';
      else { const ids = idSets.get(row.approvedSourceSet) || []; if (ids.length !== nameSets.get(row.approvedSourceSet).length) error = 'Selected source set contains unresolved servant identities'; else { parsedDecision.approvedSourceSet = row.approvedSourceSet; parsedDecision.approvedServantUserIds = ids; } }
    } else if (decision === 'USE_MANUAL_SERVANT_IDS') {
      const ids = splitList(row.approvedServantUserIds);
      if (!ids.length) error = 'approvedServantUserIds is required';
      else if (ids.some((id) => !usersById.has(id) || usersById.get(id).isDeleted)) error = 'One or more approved servant IDs do not exist or are deleted';
      else parsedDecision.approvedServantUserIds = unique(ids);
    } else if (decision === 'MERGE_ALL_RESOLVED_SERVANTS') {
      if ([...nameSets].some(([label, names]) => (idSets.get(label) || []).length !== names.length)) error = 'Cannot merge while any source servant remains unresolved';
      else parsedDecision.approvedServantUserIds = unique([...idSets.values()].flat());
    }
    if (error) addResult(state, 'SERVANT', row.conflictKey, 'ERROR', error);
    else { state.servantDecisions.set(row.conflictKey, parsedDecision); addResult(state, 'SERVANT', row.conflictKey, 'VALID', `${decision} validated; existing servants will not be removed`); }
  });
}

function validateAliasRows(rows, context, state) {
  const meetingsById = new Map(context.meetings.map((meeting) => [idOf(meeting), meeting]));
  const claims = new Map();
  rows.forEach((row) => {
    const decision = row.manualDecision;
    if (!decision) { state.unresolved += 1; addResult(state, 'GROUP_ALIAS', row.aliasKey, 'WARNING', 'Manual decision is blank; person-level conflicts remain'); return; }
    state.completed += 1;
    if (!ALIAS_DECISIONS.includes(decision)) { addResult(state, 'GROUP_ALIAS', row.aliasKey, 'ERROR', `Unknown decision ${decision}`); return; }
    let error = '';
    const parsedDecision = { aliasKey: row.aliasKey, decision, meetingId: row.meetingId, firstGroupName: row.firstGroupName, secondGroupName: row.secondGroupName };
    if (decision === 'SAME_GROUP_ALIAS') {
      const meeting = meetingsById.get(row.meetingId);
      const existing = unique([...(meeting?.groups || []), ...(meeting?.groupAssignments || []).map((entry) => entry.group), ...(meeting?.servants || []).flatMap((servant) => [...(servant.groupsManaged || []), ...(servant.groupAssignments || []).map((entry) => entry.group)])]);
      const allowed = [row.firstGroupName, row.secondGroupName, ...existing];
      if (!row.canonicalGroupName) error = 'canonicalGroupName is required';
      else if (!allowed.includes(row.canonicalGroupName) && !/^CORRECTED:\s*\S/i.test(row.notes)) error = 'Canonical group must be a source/existing meeting group or notes must begin CORRECTED: with evidence';
      else {
        parsedDecision.canonicalGroupName = row.canonicalGroupName;
        for (const name of [row.firstGroupName, row.secondGroupName]) {
          const claimKey = `${row.meetingId}\u001f${normalizeForKey(name)}`;
          const canonical = normalizeForKey(row.canonicalGroupName);
          if (claims.has(claimKey) && claims.get(claimKey) !== canonical) error = `Alias cycle/conflict: ${name} maps to two canonical groups in this meeting`;
          claims.set(claimKey, canonical);
        }
      }
    } else if (['SOURCE_NAME_ERROR', 'REVIEW_REQUIRED'].includes(decision) && !row.notes) error = `${decision} requires explanatory notes`;
    if (error) addResult(state, 'GROUP_ALIAS', row.aliasKey, 'ERROR', error);
    else { state.aliasDecisions.set(row.aliasKey, parsedDecision); addResult(state, 'GROUP_ALIAS', row.aliasKey, 'VALID', `${decision} validated; no database group is modified`); }
  });
}

function normalizeForKey(value) {
  return normalizeArabicComparison(value);
}

function validateDuplicateRows(rows, context, state) {
  const usersById = new Map(context.users.map((user) => [idOf(user), user]));
  const candidateClaims = new Map();
  rows.forEach((row) => {
    const decision = row.manualDecision;
    if (!decision) { state.unresolved += 1; addResult(state, 'DUPLICATE_USER', row.duplicateReviewKey, 'WARNING', 'Manual decision is blank; source identity remains ambiguous'); return; }
    state.completed += 1;
    if (!DUPLICATE_USER_DECISIONS.includes(decision)) { addResult(state, 'DUPLICATE_USER', row.duplicateReviewKey, 'ERROR', `Unknown decision ${decision}`); return; }
    const candidateIds = splitList(row.candidateUserIds);
    let error = '';
    const parsedDecision = { duplicateReviewKey: row.duplicateReviewKey, identityKey: row.identityKey, decision, candidateUserIds: candidateIds };
    if (decision === 'MAP_TO_CANONICAL_USER') {
      const user = usersById.get(row.approvedCanonicalUserId);
      if (!row.approvedCanonicalUserId) error = 'approvedCanonicalUserId is required';
      else if (!candidateIds.includes(row.approvedCanonicalUserId)) error = 'Approved canonical user must be one of the candidate users';
      else if (!user || user.isDeleted || !user.fullName || !user.role) error = 'Approved canonical user does not exist, is deleted, or is not a valid person';
      else {
        parsedDecision.approvedCanonicalUserId = row.approvedCanonicalUserId;
        for (const candidateId of candidateIds) {
          if (candidateClaims.has(candidateId) && candidateClaims.get(candidateId) !== row.approvedCanonicalUserId) error = `Conflicting canonical mappings for candidate ${candidateId}`;
          candidateClaims.set(candidateId, row.approvedCanonicalUserId);
        }
      }
    } else if (decision === 'REQUIRES_DATABASE_DEDUPLICATION' && !row.notes) error = 'REQUIRES_DATABASE_DEDUPLICATION requires review notes';
    if (error) addResult(state, 'DUPLICATE_USER', row.duplicateReviewKey, 'ERROR', error);
    else { state.duplicateDecisions.set(row.duplicateReviewKey, parsedDecision); addResult(state, 'DUPLICATE_USER', row.duplicateReviewKey, 'VALID', `${decision} validated; no database records will be merged or changed`); }
  });
}

function assertUniqueKeys(rows, key, label, errors) {
  const seen = new Set();
  rows.forEach((row) => { if (!row[key]) errors.push(`${label} row ${row._rowNumber} has blank ${key}`); else if (seen.has(row[key])) errors.push(`Duplicate ${label} key: ${row[key]}`); else seen.add(row[key]); });
}

async function parseAndValidateResolutionWorkbook({ workbookPath, expectedSourceExcelHash, expectedDatabaseFingerprint, users, meetings, parsedRows, expectedData = null, writeResults = false }) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(workbookPath);
  const errors = [];
  if (JSON.stringify(workbook.worksheets.map((sheet) => sheet.name)) !== JSON.stringify(SHEETS)) errors.push(`Workbook sheets/order must be exactly: ${SHEETS.join(', ')}`);
  const metadata = readMetadata(workbook);
  if (metadata.workbookVersion !== WORKBOOK_VERSION) errors.push(`Unsupported workbook version ${metadata.workbookVersion || '(blank)'}`);
  if (metadata.sourceExcelHash !== expectedSourceExcelHash) errors.push('Source Excel hash mismatch');
  if (metadata.databaseFingerprint !== expectedDatabaseFingerprint) errors.push('Database target fingerprint mismatch');
  if (!metadata.sourceResolutionPlanPath || !fs.existsSync(metadata.sourceResolutionPlanPath)) errors.push('Source blocker-resolution report path is missing or unavailable');
  let resolutionPlan = null;
  if (!errors.some((message) => message.includes('Source blocker-resolution'))) {
    try { resolutionPlan = JSON.parse(fs.readFileSync(metadata.sourceResolutionPlanPath, 'utf8')); assertPlanChecksum(resolutionPlan, metadata.sourceResolutionPlanChecksum); } catch (error) { errors.push(`Source blocker-resolution plan verification failed: ${error.message}`); }
  }
  const identityRows = readSheetRows(workbook, 'Identity Review', IDENTITY_COLUMNS);
  const candidateRows = readSheetRows(workbook, 'Identity Candidates', CANDIDATE_COLUMNS);
  const groupRows = readSheetRows(workbook, 'Group Conflicts', GROUP_COLUMNS);
  const servantRows = readSheetRows(workbook, 'Servant Conflicts', SERVANT_COLUMNS);
  const aliasRows = readSheetRows(workbook, 'Group Alias Review', ALIAS_COLUMNS);
  const duplicateRows = readSheetRows(workbook, 'Duplicate User Review', DUPLICATE_USER_COLUMNS);
  assertUniqueKeys(identityRows, 'identityKey', 'identity', errors);
  assertUniqueKeys(groupRows, 'conflictKey', 'group conflict', errors);
  assertUniqueKeys(servantRows, 'conflictKey', 'servant conflict', errors);
  assertUniqueKeys(aliasRows, 'aliasKey', 'group alias', errors);
  assertUniqueKeys(duplicateRows, 'duplicateReviewKey', 'duplicate-user review', errors);
  if (expectedData) {
    for (const [label, rows, expectedRows, key] of [['identity', identityRows, expectedData.identityRows, 'identityKey'], ['group conflict', groupRows, expectedData.groupRows, 'conflictKey'], ['servant conflict', servantRows, expectedData.servantRows, 'conflictKey'], ['group alias', aliasRows, expectedData.aliasRows, 'aliasKey'], ['duplicate-user review', duplicateRows, expectedData.duplicateRows, 'duplicateReviewKey']]) {
      const expected = new Set(expectedRows.map((row) => row[key]));
      rows.forEach((row) => { if (!expected.has(row[key])) errors.push(`Unknown ${label} key: ${row[key]}`); });
      const actual = new Set(rows.map((row) => row[key]));
      expectedRows.forEach((row) => { if (!actual.has(row[key])) errors.push(`Missing ${label} key: ${row[key]}`); });
    }
  }
  const recomputedHash = generatedFieldsHash({ identityRows, candidateRows, groupRows, servantRows, aliasRows, duplicateRows });
  if (metadata.generatedFieldsHash !== recomputedHash) errors.push('Generated workbook fields were modified or corrupted');
  const state = { errors, warnings: [], results: [], completed: 0, unresolved: 0, identityDecisions: new Map(), groupDecisions: new Map(), servantDecisions: new Map(), aliasDecisions: new Map(), duplicateDecisions: new Map() };
  if (!errors.length) {
    validateAliasRows(aliasRows, { meetings }, state);
    validateDuplicateRows(duplicateRows, { users }, state);
    validateIdentityRows(identityRows, { users, parsedRows }, state);
    validateGroupRows(groupRows, { meetings }, state);
    validateServantRows(servantRows, { users }, state);
  }
  errors.filter((message) => !state.results.some((entry) => entry.message === message)).forEach((message) => state.results.push({ resultType: 'WORKBOOK', recordKey: '', status: 'ERROR', message }));
  if (writeResults) await writeValidationResults(workbook, { identityRows, groupRows, servantRows, aliasRows, duplicateRows, state, workbookPath });
  return {
    workbookPath, workbookHash: sha256File(workbookPath), metadata, resolutionPlan, identityRows, candidateRows, groupRows, servantRows, aliasRows, duplicateRows,
    decisions: { identities: [...state.identityDecisions.values()], groups: [...state.groupDecisions.values()], servants: [...state.servantDecisions.values()], aliases: [...state.aliasDecisions.values()], duplicates: [...state.duplicateDecisions.values()] },
    results: state.results, errors: state.errors, warnings: state.warnings.length ? state.warnings : state.results.filter((entry) => entry.status === 'WARNING').map((entry) => entry.message),
    completedDecisions: state.completed, unresolvedDecisions: state.unresolved, structurallyValid: state.errors.length === 0, complete: state.errors.length === 0 && state.unresolved === 0,
  };
}

async function loadResolutionWorkbookMetadata(workbookPath) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(workbookPath);
  return readMetadata(workbook);
}

async function writeValidationResults(workbook, { identityRows, groupRows, servantRows, aliasRows, duplicateRows, state, workbookPath }) {
  const resultsSheet = workbook.getWorksheet('Validation Results');
  const previousRowCount = resultsSheet.rowCount;
  state.results.forEach((entry, index) => { resultsSheet.getRow(index + 2).values = [entry.resultType, entry.recordKey, entry.status, entry.message]; });
  for (let rowNumber = state.results.length + 2; rowNumber <= previousRowCount; rowNumber += 1) resultsSheet.getRow(rowNumber).values = [];
  const resultByKey = new Map(state.results.filter((entry) => entry.recordKey).map((entry) => [entry.recordKey, entry]));
  for (const [sheetName, rows, columns, key] of [['Identity Review', identityRows, IDENTITY_COLUMNS, 'identityKey'], ['Group Conflicts', groupRows, GROUP_COLUMNS, 'conflictKey'], ['Servant Conflicts', servantRows, SERVANT_COLUMNS, 'conflictKey'], ['Group Alias Review', aliasRows, ALIAS_COLUMNS, 'aliasKey'], ['Duplicate User Review', duplicateRows, DUPLICATE_USER_COLUMNS, 'duplicateReviewKey']]) {
    const sheet = workbook.getWorksheet(sheetName);
    rows.forEach((row) => {
      const result = resultByKey.get(row[key]);
      sheet.getCell(row._rowNumber, columns.indexOf('validationStatus') + 1).value = result?.status || '';
      sheet.getCell(row._rowNumber, columns.indexOf('validationMessage') + 1).value = result?.message || '';
    });
  }
  await workbook.xlsx.writeFile(workbookPath);
}

module.exports = { readMetadata, readSheetRows, parseSplitDefinition, parseLabelledLines, validateAliasRows, validateDuplicateRows, parseAndValidateResolutionWorkbook, loadResolutionWorkbookMetadata };
