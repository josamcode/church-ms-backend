const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');
const { WORKBOOK_VERSION, SHEETS, IDENTITY_DECISIONS, GROUP_DECISIONS, SERVANT_DECISIONS, ALIAS_DECISIONS, DUPLICATE_USER_DECISIONS, IDENTITY_COLUMNS, CANDIDATE_COLUMNS, GROUP_COLUMNS, SERVANT_COLUMNS, ALIAS_COLUMNS, DUPLICATE_USER_COLUMNS, MANUAL_COLUMNS, generatedFieldsHash } = require('./workbookSchema');

const HEADER_FILL = 'FF1F4E78';
const MANUAL_FILL = 'FFFFE699';
const INFO_FILL = 'FFD9EAF7';

function reportDirectoryName(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return `church-service-manual-resolution-${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function styleHeader(row) {
  row.height = 32;
  row.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER_FILL } };
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    cell.border = { bottom: { style: 'thin', color: { argb: 'FF808080' } } };
  });
}

function widthFor(column) {
  if (/Key|Id$|Ids$|UserId/i.test(column)) return 30;
  if (/Summary|Reason|Evidence|Definition|Message|Sets|RowsBy|ImportSource/i.test(column)) return 45;
  if (/Name|Spellings|Meetings|Groups|Education|notes/i.test(column)) return 28;
  return 20;
}

function addDataSheet(workbook, name, columns, rows, decisions = []) {
  const sheet = workbook.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1 }] });
  sheet.columns = columns.map((key) => ({ header: key, key, width: widthFor(key) }));
  rows.forEach((row) => sheet.addRow(row));
  styleHeader(sheet.getRow(1));
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: Math.max(1, sheet.rowCount), column: columns.length } };
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    row.height = 42;
    row.eachCell({ includeEmpty: true }, (cell) => { cell.alignment = { vertical: 'top', wrapText: true }; cell.protection = { locked: true }; });
  });
  const manual = MANUAL_COLUMNS[name] || new Set();
  columns.forEach((column, index) => {
    if (!manual.has(column)) return;
    for (let rowNumber = 2; rowNumber <= Math.max(2, sheet.rowCount); rowNumber += 1) {
      const cell = sheet.getCell(rowNumber, index + 1);
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: MANUAL_FILL } };
      cell.protection = { locked: false };
    }
  });
  if (decisions.length && columns.includes('manualDecision')) {
    const columnLetter = sheet.getColumn(columns.indexOf('manualDecision') + 1).letter;
    for (let rowNumber = 2; rowNumber <= Math.max(2, sheet.rowCount); rowNumber += 1) {
      sheet.getCell(`${columnLetter}${rowNumber}`).dataValidation = { type: 'list', allowBlank: true, formulae: [`"${decisions.join(',')}"`], showErrorMessage: true, errorTitle: 'Invalid decision', error: 'Choose a value from the dropdown or leave blank.' };
    }
  }
  return sheet;
}

function addInstructions(workbook, metadata) {
  const sheet = workbook.addWorksheet('Instructions', { views: [{ state: 'frozen', ySplit: 2 }] });
  sheet.columns = [{ width: 31 }, { width: 115 }];
  sheet.mergeCells('A1:B1');
  sheet.getCell('A1').value = 'Church Service Manual Resolution Workbook';
  sheet.getCell('A1').font = { bold: true, size: 16, color: { argb: 'FFFFFFFF' } };
  sheet.getCell('A1').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER_FILL } };
  const instructions = [
    ['Important', 'This workbook is a review artifact only. It never modifies the database; a new validated dry run is required afterward.'],
    ['Editing', 'Do not edit generated identity/conflict keys or Excel row numbers. Edit only yellow manual-decision cells. Blank decisions remain unresolved.'],
    ['Existing user', 'MAP_EXISTING_USER requires approvedUserId from listed candidates. An outside ID requires notes beginning OVERRIDE: with authoritative evidence.'],
    ['Split identity', 'SPLIT_SOURCE_IDENTITY requires JSON: {"parts":[{"identityKey":"part-a","rows":[2,3],"canonicalName":"..."}, ...]}. Every listed occurrence must be assigned exactly once. A part may instead specify meeting/group/grade.'],
    ['New/corrected', 'CREATE_NEW_PERSON only produces a future missing-user review entry. CORRECT_SOURCE_NAME requires correctedCanonicalName and is rematched before any new-user conclusion.'],
    ['Skip identity', 'SKIP_INVALID_SOURCE skips the whole invalid identity. SKIP_OCCURRENCES requires notes containing ALL or rows: 2,3 and skips only those rows.'],
    ['Group conflict', 'KEEP_ONE_GROUP requires approvedGroupName. KEEP_EXISTING_GROUP never moves a person. ALLOW_BOTH_GROUPS is rejected when domain rules prohibit multiple groups in one meeting.'],
    ['Group aliases', 'Review Group Alias Review first. SAME_GROUP_ALIAS requires one canonical group name and collapses both source labels before person-level conflicts. Similarity is recommendation evidence only and never approval.'],
    ['Duplicate users', 'Duplicate User Review maps church-service planning to an approved canonical candidate only. It never merges, deletes, or updates database records.'],
    ['Servant conflict', 'USE_SOURCE_SET requires SET_n. USE_MANUAL_SERVANT_IDS requires valid IDs. MERGE_ALL_RESOLVED_SERVANTS may only union users explicitly present in source sets. No decision removes existing servants.'],
    ['IDs', 'Database IDs must come from listed candidates unless an explicit documented override is used. No fuzzy suggestion is automatically accepted.'],
    ['Workflow', 'Complete decisions, validate this workbook, generate a new church-service dry run, review remaining blockers, and only then consider a separately guarded apply.'],
  ];
  instructions.forEach((values, index) => {
    const row = sheet.getRow(index + 3); row.values = values; row.height = 45;
    row.getCell(1).font = { bold: true }; row.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: INFO_FILL } };
    row.eachCell((cell) => { cell.alignment = { vertical: 'top', wrapText: true }; });
  });
  const markerRow = 17;
  sheet.getCell(markerRow, 1).value = 'WORKBOOK_METADATA';
  sheet.getCell(markerRow, 1).font = { bold: true };
  Object.entries(metadata).forEach(([key, value], index) => {
    sheet.getCell(markerRow + 1 + index, 1).value = key;
    sheet.getCell(markerRow + 1 + index, 2).value = String(value ?? '');
  });
  return sheet;
}

function addSummary(workbook, data) {
  const sheet = workbook.addWorksheet('Summary', { views: [{ state: 'frozen', ySplit: 1 }] });
  sheet.columns = [{ header: 'Metric', width: 48 }, { header: 'Value', width: 28 }, { header: 'Meaning', width: 80 }];
  const identityDecisionColumn = IDENTITY_COLUMNS.indexOf('manualDecision') + 1;
  const groupDecisionColumn = GROUP_COLUMNS.indexOf('manualDecision') + 1;
  const servantDecisionColumn = SERVANT_COLUMNS.indexOf('manualDecision') + 1;
  const aliasDecisionColumn = ALIAS_COLUMNS.indexOf('manualDecision') + 1;
  const duplicateDecisionColumn = DUPLICATE_USER_COLUMNS.indexOf('manualDecision') + 1;
  const identityRange = `'Identity Review'!${sheetNameColumn(identityDecisionColumn)}2:${sheetNameColumn(identityDecisionColumn)}${data.identityRows.length + 1}`;
  const groupRange = `'Group Conflicts'!${sheetNameColumn(groupDecisionColumn)}2:${sheetNameColumn(groupDecisionColumn)}${data.groupRows.length + 1}`;
  const servantRange = `'Servant Conflicts'!${sheetNameColumn(servantDecisionColumn)}2:${sheetNameColumn(servantDecisionColumn)}${data.servantRows.length + 1}`;
  const aliasRange = `'Group Alias Review'!${sheetNameColumn(aliasDecisionColumn)}2:${sheetNameColumn(aliasDecisionColumn)}${data.aliasRows.length + 1}`;
  const duplicateRange = `'Duplicate User Review'!${sheetNameColumn(duplicateDecisionColumn)}2:${sheetNameColumn(duplicateDecisionColumn)}${data.duplicateRows.length + 1}`;
  const decisionFormula = `COUNTA(${identityRange})+COUNTA(${groupRange})+COUNTA(${servantRange})+COUNTA(${aliasRange})+COUNTA(${duplicateRange})`;
  const total = data.identityRows.length + data.groupRows.length + data.servantRows.length + data.aliasRows.length + data.duplicateRows.length;
  const rows = [
    ['Total unresolved identities', data.identityRows.length, 'One row per normalized manual identity decision'],
    ['Ambiguous identities', data.duplicateRows.length, 'Reviewed first as possible duplicate database records'],
    ['Potential homonyms', data.identityRows.filter((row) => row.currentStatus === 'POTENTIAL_HOMONYM').length, 'Require deterministic split or review'],
    ['Invalid names', data.identityRows.filter((row) => row.currentStatus === 'INVALID_NAME').length, 'Invalid source values'],
    ['Multiple-group conflicts', data.groupRows.length, 'One person/meeting conflict per row'],
    ['Inconsistent servant-list conflicts', data.servantRows.length, 'One source group per row'],
    ['Unique group-alias decisions', data.aliasRows.length, 'Reviewed before person-level group conflicts'],
    ['Duplicate-user reviews', data.duplicateRows.length, 'One per ambiguous source identity'],
    ['Completed manual decisions', { formula: decisionFormula, result: 0 }, 'Calculated for reviewer convenience; validation reads decision rows directly'],
    ['Remaining manual decisions', { formula: `${total}-(${decisionFormula})`, result: total }, 'Blank manualDecision cells'],
    ['Validation errors', { formula: `COUNTIF('Validation Results'!C:C,"ERROR")`, result: 0 }, 'Populated by validation command'],
    ['Validation warnings', { formula: `COUNTIF('Validation Results'!C:C,"WARNING")`, result: 0 }, 'Populated by validation command'],
    ['Resolution workbook complete', { formula: `IF(B11=0,"YES","NO")`, result: 'NO' }, 'YES only when no decisions remain blank'],
    ['New dry run can be generated', { formula: `IF(B12=0,"YES","NO")`, result: 'YES' }, 'Structural validity permits a blocked dry run even with blanks'],
  ];
  rows.forEach((values) => sheet.addRow(values));
  styleHeader(sheet.getRow(1));
  sheet.eachRow((row, index) => { if (index > 1) { row.height = 28; row.eachCell((cell) => { cell.alignment = { vertical: 'middle', wrapText: true }; }); } });
  return sheet;
}

function sheetNameColumn(number) {
  let result = ''; let value = number;
  while (value > 0) { value -= 1; result = String.fromCharCode(65 + (value % 26)) + result; value = Math.floor(value / 26); }
  return result;
}

async function generateResolutionWorkbook({ data, metadata, outputPath }) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'micheal-church read-only importer';
  workbook.created = new Date(metadata.generatedAt);
  workbook.calcProperties.fullCalcOnLoad = true;
  const fullMetadata = { ...metadata, workbookVersion: WORKBOOK_VERSION, generatedFieldsHash: generatedFieldsHash(data) };
  addInstructions(workbook, fullMetadata);
  addSummary(workbook, data);
  addDataSheet(workbook, 'Group Alias Review', ALIAS_COLUMNS, data.aliasRows, ALIAS_DECISIONS);
  addDataSheet(workbook, 'Duplicate User Review', DUPLICATE_USER_COLUMNS, data.duplicateRows, DUPLICATE_USER_DECISIONS);
  const identitySheet = addDataSheet(workbook, 'Identity Review', IDENTITY_COLUMNS, data.identityRows, IDENTITY_DECISIONS);
  addDataSheet(workbook, 'Identity Candidates', CANDIDATE_COLUMNS, data.candidateRows);
  const groupSheet = addDataSheet(workbook, 'Group Conflicts', GROUP_COLUMNS, data.groupRows, GROUP_DECISIONS);
  const servantSheet = addDataSheet(workbook, 'Servant Conflicts', SERVANT_COLUMNS, data.servantRows, SERVANT_DECISIONS);
  addDataSheet(workbook, 'Validation Results', ['resultType', 'recordKey', 'status', 'message'], []);
  data.groupRows.forEach((row, index) => {
    const options = String(row.sourceGroups || '').split(' | ').filter(Boolean);
    if (options.length && options.join(',').length < 250) groupSheet.getCell(index + 2, GROUP_COLUMNS.indexOf('approvedGroupName') + 1).dataValidation = { type: 'list', allowBlank: true, formulae: [`"${options.join(',')}"`] };
  });
  data.servantRows.forEach((row, index) => {
    const labels = [...String(row.candidateServantSets || '').matchAll(/^(SET_\d+):/gm)].map((match) => match[1]);
    if (labels.length) servantSheet.getCell(index + 2, SERVANT_COLUMNS.indexOf('approvedSourceSet') + 1).dataValidation = { type: 'list', allowBlank: true, formulae: [`"${labels.join(',')}"`] };
  });
  for (const sheet of workbook.worksheets.filter((entry) => !['Validation Results'].includes(entry.name))) {
    await sheet.protect('', { selectLockedCells: true, selectUnlockedCells: true, formatCells: false, insertRows: false, deleteRows: false });
  }
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  await workbook.xlsx.writeFile(outputPath);
  return { outputPath, metadata: fullMetadata, sheets: SHEETS };
}

module.exports = { reportDirectoryName, generateResolutionWorkbook, addDataSheet, sheetNameColumn };
