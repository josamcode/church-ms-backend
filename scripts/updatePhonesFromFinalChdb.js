const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const mongoose = require('mongoose');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const User = require('../src/modules/users/user.model');

const UPDATE_CONFIRMATION = 'UPDATE_PHONES_FROM_FINALCHDB';
const DEFAULT_MAX_EXCEL_ROW = 1871;
const DEFAULT_BATCH_SIZE = 100;
const REPORT_DIR = path.join(__dirname, '..', 'tmp', 'import-reports');
const POWERSHELL_SCRIPT = path.join(__dirname, 'readWorkbookSheet.ps1');
const PHONE_FIELD = 'phonePrimary';

const REVIEW_COLUMNS = Object.freeze([
  'excelRowNumber',
  'personNameFromExcel',
  'nationalIdFromExcel',
  'normalizedNationalId',
  'phoneFromExcel',
  'normalizedPhone',
  'matchMethod',
  'matchedPersonId',
  'matchedUserId',
  'currentPhone',
  'matchStatus',
  'action',
  'reason',
]);

function parseArgs(argv) {
  const args = {
    apply: false,
    batchSize: DEFAULT_BATCH_SIZE,
    confirmUpdate: '',
    file: '',
    maxExcelRow: DEFAULT_MAX_EXCEL_ROW,
    reviewFile: '',
    sheet: '',
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (token === '--apply') {
      args.apply = true;
      continue;
    }

    if (token === '--confirm-update') {
      args.confirmUpdate = argv[index + 1] || '';
      index += 1;
      continue;
    }

    if (token === '--file') {
      args.file = argv[index + 1] || '';
      index += 1;
      continue;
    }

    if (token === '--sheet') {
      args.sheet = argv[index + 1] || '';
      index += 1;
      continue;
    }

    if (token === '--review-file') {
      args.reviewFile = argv[index + 1] || '';
      index += 1;
      continue;
    }

    if (token === '--max-excel-row') {
      const parsed = Number.parseInt(argv[index + 1] || '', 10);
      if (!Number.isFinite(parsed) || parsed < 2) {
        throw new Error('--max-excel-row must be an integer greater than or equal to 2.');
      }
      args.maxExcelRow = parsed;
      index += 1;
      continue;
    }

    if (token === '--batch-size') {
      const parsed = Number.parseInt(argv[index + 1] || '', 10);
      if (!Number.isFinite(parsed) || parsed < 1) {
        throw new Error('--batch-size must be a positive integer.');
      }
      args.batchSize = parsed;
      index += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${token}`);
  }

  if (args.apply && args.confirmUpdate !== UPDATE_CONFIRMATION) {
    throw new Error(
      `Apply mode requires --confirm-update ${UPDATE_CONFIRMATION}. No database writes were executed.`
    );
  }

  if (!args.file) {
    throw new Error('Missing required argument: --file <xlsx file>');
  }

  if (!args.sheet) {
    throw new Error('Missing required argument: --sheet <sheet name>');
  }

  return args;
}

function normalizeWhitespace(value) {
  return String(value || '')
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function convertLocalizedDigits(value) {
  return String(value || '')
    .replace(/[\u0660-\u0669]/g, (digit) => String(digit.charCodeAt(0) - 0x0660))
    .replace(/[\u06F0-\u06F9]/g, (digit) => String(digit.charCodeAt(0) - 0x06F0));
}

function normalizeNationalId(value) {
  return convertLocalizedDigits(value).replace(/\D/g, '');
}

function evaluateNationalId(value) {
  const normalizedNationalId = normalizeNationalId(value);

  if (!normalizedNationalId) {
    return { normalizedNationalId, valid: false, reason: 'empty national ID' };
  }

  if (normalizedNationalId.length !== 14) {
    return {
      normalizedNationalId,
      valid: false,
      reason: `national ID must be exactly 14 digits; got ${normalizedNationalId.length}`,
    };
  }

  if (/^(\d)\1{13}$/.test(normalizedNationalId)) {
    return {
      normalizedNationalId,
      valid: false,
      reason: 'national ID is a repeated placeholder value',
    };
  }

  return { normalizedNationalId, valid: true, reason: '' };
}

function normalizeArabicForComparison(value) {
  return normalizeWhitespace(value)
    .replace(/[\u064B-\u065F\u0670\u0640]/g, '')
    .replace(/[\u0623\u0625\u0622\u0671]/g, '\u0627')
    .replace(/\u0629/g, '\u0647')
    .replace(/\u0649/g, '\u064A')
    .replace(/\u0624/g, '\u0648')
    .replace(/\u0626/g, '\u064A')
    .replace(/[^\u0600-\u06FFa-zA-Z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeNameForMatch(value) {
  return normalizeArabicForComparison(value).toLowerCase();
}

function normalizeHeader(value) {
  return normalizeArabicForComparison(value)
    .toLowerCase()
    .replace(/\s+/g, '');
}

function expandScientificNotation(value) {
  const text = String(value || '').trim();
  const match = text.match(/^([+-]?)(\d+)(?:\.(\d+))?[eE]([+-]?\d+)$/);
  if (!match) return text;

  const sign = match[1] === '-' ? '-' : '';
  const integerPart = match[2];
  const fractionPart = match[3] || '';
  const exponent = Number.parseInt(match[4], 10);
  if (!Number.isFinite(exponent)) return text;

  const digits = `${integerPart}${fractionPart}`;
  const decimalIndex = integerPart.length + exponent;

  if (decimalIndex <= 0) {
    return `${sign}0.${'0'.repeat(Math.abs(decimalIndex))}${digits}`;
  }

  if (decimalIndex >= digits.length) {
    return `${sign}${digits}${'0'.repeat(decimalIndex - digits.length)}`;
  }

  return `${sign}${digits.slice(0, decimalIndex)}.${digits.slice(decimalIndex)}`;
}

function normalizePhone(value) {
  const original = normalizeWhitespace(convertLocalizedDigits(expandScientificNotation(value)));
  if (!original) {
    return { normalizedPhone: '', valid: false, reason: 'NO_PHONE' };
  }

  let cleaned = original
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, '')
    .replace(/[\s\-\u2010-\u2015()[\]{}]/g, '')
    .trim();

  if (!cleaned) {
    return { normalizedPhone: '', valid: false, reason: 'NO_PHONE' };
  }

  const plusCount = (cleaned.match(/\+/g) || []).length;
  if (plusCount > 1 || (plusCount === 1 && !cleaned.startsWith('+'))) {
    return { normalizedPhone: cleaned, valid: false, reason: 'plus sign is only allowed at the beginning' };
  }

  const digits = cleaned.startsWith('+') ? cleaned.slice(1) : cleaned;
  if (!/^\d+$/.test(digits)) {
    return { normalizedPhone: cleaned, valid: false, reason: 'phone contains non-digit characters after cleanup' };
  }

  if (digits.length < 7) {
    return { normalizedPhone: cleaned, valid: false, reason: `phone is too short after cleanup; got ${digits.length} digits` };
  }

  if (digits.length > 18) {
    return { normalizedPhone: cleaned, valid: false, reason: `phone is too long after cleanup; got ${digits.length} digits` };
  }

  if (/^0+$/.test(digits) || /^(\d)\1+$/.test(digits)) {
    return { normalizedPhone: cleaned, valid: false, reason: 'phone is a repeated placeholder value' };
  }

  return { normalizedPhone: cleaned, valid: true, reason: '' };
}

function loadWorkbookRows(workbookPath, sheetName) {
  const commandResult = spawnSync(
    'powershell',
    [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      POWERSHELL_SCRIPT,
      '-WorkbookPath',
      workbookPath,
      '-SheetName',
      sheetName,
    ],
    {
      encoding: 'utf8',
      maxBuffer: 100 * 1024 * 1024,
      windowsHide: true,
    }
  );

  if (commandResult.error) {
    throw commandResult.error;
  }

  if (commandResult.status !== 0) {
    throw new Error(commandResult.stderr || 'Failed to read workbook via PowerShell.');
  }

  return JSON.parse(commandResult.stdout);
}

function hasAnyHeader(header, values) {
  return values.some((value) => header.includes(value));
}

function detectColumns(headerRow) {
  const cells = headerRow?.cells || {};
  const entries = Object.entries(cells).map(([column, value]) => ({
    column,
    original: normalizeWhitespace(value),
    normalized: normalizeHeader(value),
  }));

  const nameColumn = entries.find((entry) => hasAnyHeader(entry.normalized, [
    'name',
    '\u0627\u0644\u0627\u0633\u0645',
    '\u0627\u0633\u0645',
  ]))?.column;

  const phoneColumn = entries.find((entry) => hasAnyHeader(entry.normalized, [
    'phone',
    'mobile',
    'telephone',
    'tel',
    '\u062a\u0644\u064a\u0641\u0648\u0646',
    '\u062a\u0644\u0641\u0648\u0646',
    '\u0647\u0627\u062a\u0641',
    '\u0645\u0648\u0628\u0627\u064a\u0644',
    '\u062c\u0648\u0627\u0644',
  ]))?.column;

  const nationalIdColumn = entries.find((entry) => hasAnyHeader(entry.normalized, [
    'nationalid',
    'national',
    '\u0642\u0648\u0645\u064a',
    '\u0642\u0648\u0645\u0649',
  ]))?.column;

  const missing = [];
  if (!nameColumn) missing.push('name');
  if (!phoneColumn) missing.push('phone/mobile');
  if (!nationalIdColumn) missing.push('national ID');

  if (missing.length) {
    const headers = entries.map((entry) => `${entry.column}="${entry.original}"`).join(', ');
    throw new Error(`Could not detect required column(s): ${missing.join(', ')}. Header row: ${headers}`);
  }

  return { nameColumn, nationalIdColumn, phoneColumn };
}

function ensureReviewPath(customReviewFile) {
  if (customReviewFile) {
    const resolved = path.resolve(customReviewFile);
    return path.extname(resolved).toLowerCase() === '.xlsx' ? resolved : `${resolved}.xlsx`;
  }

  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join(REPORT_DIR, `finalchdb-phone-update-review-${timestamp}.xlsx`);
}

function stringifyId(value) {
  return value ? String(value) : '';
}

function addToMapArray(map, key, value) {
  if (!key) return;
  const values = map.get(key) || [];
  values.push(value);
  map.set(key, values);
}

function buildUserLookupMaps(users) {
  const byNationalId = new Map();
  const byName = new Map();
  const byNormalizedPhone = new Map();

  for (const user of users) {
    addToMapArray(byNationalId, normalizeNationalId(user.nationalId), user);
    addToMapArray(byName, normalizeNameForMatch(user.fullName), user);

    const phone = normalizePhone(user.phonePrimary);
    if (phone.valid) {
      addToMapArray(byNormalizedPhone, phone.normalizedPhone, user);
    }
  }

  return { byName, byNationalId, byNormalizedPhone };
}

function findMatchForRow({ name, nationalIdResult, lookups, reasons }) {
  if (nationalIdResult.valid) {
    const matches = lookups.byNationalId.get(nationalIdResult.normalizedNationalId) || [];
    if (matches.length === 1) {
      return {
        matchMethod: 'nationalId',
        matchStatus: 'MATCHED_BY_NATIONAL_ID',
        matchedUser: matches[0],
      };
    }

    if (matches.length > 1) {
      reasons.push(`normalized national ID matched ${matches.length} existing people`);
      return {
        matchMethod: 'nationalId',
        matchStatus: 'DUPLICATE_NATIONAL_ID_MATCH',
        matchedUser: null,
      };
    }

    reasons.push('valid national ID was not found in existing people');
    return {
      matchMethod: 'nationalId',
      matchStatus: 'NOT_FOUND_BY_NATIONAL_ID',
      matchedUser: null,
    };
  }

  reasons.push(`invalid national ID: ${nationalIdResult.reason}`);

  const normalizedName = normalizeNameForMatch(name);
  if (!normalizedName) {
    reasons.push('person name is empty, so fallback name matching could not run');
    return {
      matchMethod: 'name',
      matchStatus: 'NOT_FOUND_BY_NAME',
      matchedUser: null,
    };
  }

  const matches = lookups.byName.get(normalizedName) || [];
  if (matches.length === 1) {
    reasons.push('INVALID_NATIONAL_ID_USED_NAME');
    return {
      matchMethod: 'name',
      matchStatus: 'MATCHED_BY_NAME',
      matchedUser: matches[0],
    };
  }

  if (matches.length > 1) {
    reasons.push(`normalized name matched ${matches.length} existing people`);
    return {
      matchMethod: 'name',
      matchStatus: 'DUPLICATE_NAME_MATCH',
      matchedUser: null,
    };
  }

  reasons.push('normalized name was not found in existing people');
  return {
    matchMethod: 'name',
    matchStatus: 'NOT_FOUND_BY_NAME',
    matchedUser: null,
  };
}

function getInitialAction({ currentPhone, matchedUser, phoneResult, reasons }) {
  if (!phoneResult.normalizedPhone) {
    reasons.push('phone is empty');
    return 'NO_PHONE';
  }

  if (!phoneResult.valid) {
    reasons.push(`invalid phone: ${phoneResult.reason}`);
    return 'INVALID_PHONE';
  }

  if (!matchedUser) {
    return 'SKIPPED';
  }

  const currentPhoneResult = normalizePhone(currentPhone);
  if (currentPhoneResult.valid && currentPhoneResult.normalizedPhone === phoneResult.normalizedPhone) {
    return 'UNCHANGED';
  }

  return 'WILL_UPDATE';
}

function buildReviewRecords({ dataRows, lookups, columns }) {
  return dataRows.map((row) => {
    const cells = row.cells || {};
    const name = normalizeWhitespace(cells[columns.nameColumn]);
    const rawNationalId = normalizeWhitespace(cells[columns.nationalIdColumn]);
    const rawPhone = normalizeWhitespace(cells[columns.phoneColumn]);
    const nationalIdResult = evaluateNationalId(rawNationalId);
    const phoneResult = normalizePhone(rawPhone);
    const reasons = [];
    const match = findMatchForRow({
      name,
      nationalIdResult,
      lookups,
      reasons,
    });
    const matchedUser = match.matchedUser;
    const matchedUserId = stringifyId(matchedUser?._id);
    const currentPhone = matchedUser?.[PHONE_FIELD] || '';
    const action = getInitialAction({
      currentPhone,
      matchedUser,
      phoneResult,
      reasons,
    });

    return {
      excelRowNumber: row.rowNumber,
      personNameFromExcel: name,
      nationalIdFromExcel: rawNationalId,
      normalizedNationalId: nationalIdResult.normalizedNationalId,
      phoneFromExcel: rawPhone,
      normalizedPhone: phoneResult.normalizedPhone,
      matchMethod: match.matchMethod,
      matchedPersonId: matchedUserId,
      matchedUserId,
      currentPhone,
      matchStatus: match.matchStatus,
      action,
      reason: reasons.join('; '),
      _matchedUser: matchedUser,
      _nationalIdValid: nationalIdResult.valid,
      _phoneHasRawValue: Boolean(rawPhone),
      _phoneValid: phoneResult.valid,
      _updateFilterCurrentPhone: currentPhone,
    };
  });
}

function appendReason(record, reason) {
  record.reason = record.reason ? `${record.reason}; ${reason}` : reason;
}

function skipWillUpdate(record, reason) {
  if (record.action !== 'WILL_UPDATE') return;
  record.action = 'SKIPPED';
  appendReason(record, reason);
}

function applyPostMatchSafety(records, lookups) {
  const recordsByMatchedUserId = new Map();
  for (const record of records.filter((entry) => entry.matchedUserId)) {
    addToMapArray(recordsByMatchedUserId, record.matchedUserId, record);
  }

  for (const matchedRecords of recordsByMatchedUserId.values()) {
    if (matchedRecords.length <= 1) continue;
    for (const record of matchedRecords) {
      skipWillUpdate(record, 'skipped because multiple Excel rows matched the same existing person');
    }
  }

  const updateCandidatesByPhone = new Map();
  for (const record of records.filter((entry) => entry.action === 'WILL_UPDATE')) {
    addToMapArray(updateCandidatesByPhone, record.normalizedPhone, record);
  }

  for (const candidates of updateCandidatesByPhone.values()) {
    const matchedIds = new Set(candidates.map((record) => record.matchedUserId));
    if (matchedIds.size <= 1) continue;
    for (const record of candidates) {
      skipWillUpdate(record, 'skipped because the same normalized phone is planned for multiple existing people');
    }
  }

  for (const record of records.filter((entry) => entry.action === 'WILL_UPDATE')) {
    const existingPhoneUsers = lookups.byNormalizedPhone.get(record.normalizedPhone) || [];
    const conflictingUsers = existingPhoneUsers.filter((user) => stringifyId(user._id) !== record.matchedUserId);
    if (!conflictingUsers.length) continue;

    const conflictingIds = conflictingUsers.map((user) => stringifyId(user._id)).join(', ');
    skipWillUpdate(record, `skipped because normalized phone already belongs to another existing person: ${conflictingIds}`);
  }
}

function chunkArray(items, size) {
  const chunks = [];
  const effectiveSize = Math.max(1, Number(size) || DEFAULT_BATCH_SIZE);
  for (let index = 0; index < items.length; index += effectiveSize) {
    chunks.push(items.slice(index, index + effectiveSize));
  }
  return chunks;
}

function buildUpdateFilter(record) {
  const id = record.matchedUserId;
  const currentPhone = record._updateFilterCurrentPhone;

  if (currentPhone === undefined || currentPhone === null || currentPhone === '') {
    return {
      _id: id,
      $or: [
        { [PHONE_FIELD]: { $exists: false } },
        { [PHONE_FIELD]: null },
        { [PHONE_FIELD]: '' },
      ],
    };
  }

  return { _id: id, [PHONE_FIELD]: currentPhone };
}

async function executeUpdates(records, batchSize) {
  const candidates = records.filter((record) => record.action === 'WILL_UPDATE');
  const chunks = chunkArray(candidates, batchSize);
  let matchedCount = 0;
  let modifiedCount = 0;

  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index];
    const operations = chunk.map((record) => ({
      updateOne: {
        filter: buildUpdateFilter(record),
        update: {
          $set: {
            [PHONE_FIELD]: record.normalizedPhone,
          },
        },
      },
    }));

    console.log(`[apply] bulkWrite batch ${index + 1}/${chunks.length}: ${operations.length} update(s)`);
    const result = await User.bulkWrite(operations, { ordered: false });
    matchedCount += Number(result.matchedCount || 0);
    modifiedCount += Number(result.modifiedCount || 0);
  }

  if (candidates.length) {
    const refreshed = await User.find({ _id: { $in: candidates.map((record) => record.matchedUserId) } })
      .select(`_id ${PHONE_FIELD}`)
      .lean();
    const phoneById = new Map(refreshed.map((user) => [stringifyId(user._id), user[PHONE_FIELD] || '']));

    for (const record of candidates) {
      if (phoneById.get(record.matchedUserId) === record.normalizedPhone) {
        record.action = 'UPDATED';
        appendReason(record, 'phonePrimary updated');
      } else {
        record.action = 'SKIPPED';
        appendReason(record, 'update did not apply; current phone changed before write or update matched no document');
      }
    }
  }

  return { matchedCount, modifiedCount, updatedRows: records.filter((record) => record.action === 'UPDATED').length };
}

function summarize({ maxExcelRow, records, totalWorksheetRows, plannedUpdateCount, updateResult }) {
  const count = (predicate) => records.filter(predicate).length;

  return {
    totalWorksheetRows,
    maxExcelRowProcessed: maxExcelRow,
    rowsActuallyProcessed: records.length,
    rowsWithPhone: count((record) => record._phoneHasRawValue),
    rowsWithoutPhone: count((record) => !record._phoneHasRawValue),
    validPhones: count((record) => record._phoneHasRawValue && record._phoneValid),
    invalidPhones: count((record) => record._phoneHasRawValue && !record._phoneValid),
    validNationalIds: count((record) => record._nationalIdValid),
    invalidNationalIds: count((record) => !record._nationalIdValid),
    matchedByNationalId: count((record) => record.matchStatus === 'MATCHED_BY_NATIONAL_ID'),
    matchedByName: count((record) => record.matchStatus === 'MATCHED_BY_NAME'),
    duplicateNationalIdMatches: count((record) => record.matchStatus === 'DUPLICATE_NATIONAL_ID_MATCH'),
    duplicateNameMatches: count((record) => record.matchStatus === 'DUPLICATE_NAME_MATCH'),
    notFound: count((record) => (
      record.matchStatus === 'NOT_FOUND_BY_NATIONAL_ID'
      || record.matchStatus === 'NOT_FOUND_BY_NAME'
    )),
    unchanged: count((record) => record.action === 'UNCHANGED'),
    willUpdate: plannedUpdateCount,
    updated: updateResult?.updatedRows || 0,
    skipped: count((record) => !['UNCHANGED', 'WILL_UPDATE', 'UPDATED'].includes(record.action)),
  };
}

function printSummary(summary) {
  console.log('Summary:');
  console.log(`- total worksheet rows: ${summary.totalWorksheetRows}`);
  console.log(`- max Excel row processed: ${summary.maxExcelRowProcessed}`);
  console.log(`- rows actually processed: ${summary.rowsActuallyProcessed}`);
  console.log(`- rows with phone: ${summary.rowsWithPhone}`);
  console.log(`- rows without phone: ${summary.rowsWithoutPhone}`);
  console.log(`- valid phones: ${summary.validPhones}`);
  console.log(`- invalid phones: ${summary.invalidPhones}`);
  console.log(`- valid national IDs: ${summary.validNationalIds}`);
  console.log(`- invalid national IDs: ${summary.invalidNationalIds}`);
  console.log(`- matched by national ID: ${summary.matchedByNationalId}`);
  console.log(`- matched by name: ${summary.matchedByName}`);
  console.log(`- duplicate national ID matches: ${summary.duplicateNationalIdMatches}`);
  console.log(`- duplicate name matches: ${summary.duplicateNameMatches}`);
  console.log(`- not found: ${summary.notFound}`);
  console.log(`- unchanged: ${summary.unchanged}`);
  console.log(`- will update: ${summary.willUpdate}`);
  console.log(`- updated: ${summary.updated}`);
  console.log(`- skipped: ${summary.skipped}`);
}

function buildReviewRows(records) {
  return [
    REVIEW_COLUMNS,
    ...records.map((record) => REVIEW_COLUMNS.map((column) => record[column] ?? '')),
  ];
}

function xmlEscape(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function columnName(index) {
  let value = index;
  let name = '';
  while (value > 0) {
    const remainder = (value - 1) % 26;
    name = String.fromCharCode(65 + remainder) + name;
    value = Math.floor((value - 1) / 26);
  }
  return name;
}

function buildSheetXml(rows) {
  const maxColumns = rows.reduce((max, row) => Math.max(max, row.length), 0);
  const columnDefinitions = Array.from({ length: maxColumns }, (_, index) => {
    const column = index + 1;
    const width = column <= 2 ? 22 : 32;
    return `<col min="${column}" max="${column}" width="${width}" customWidth="1"/>`;
  }).join('');

  const sheetRows = rows.map((row, rowIndex) => {
    const rowNumber = rowIndex + 1;
    const cells = row.map((value, columnIndex) => {
      const ref = `${columnName(columnIndex + 1)}${rowNumber}`;
      const style = rowIndex === 0 ? ' s="1"' : '';
      return `<c r="${ref}" t="inlineStr"${style}><is><t>${xmlEscape(value)}</t></is></c>`;
    }).join('');
    return `<row r="${rowNumber}">${cells}</row>`;
  }).join('');

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
  <cols>${columnDefinitions}</cols>
  <sheetData>${sheetRows}</sheetData>
</worksheet>`;
}

function buildWorkbookXml(sheets) {
  const sheetEntries = sheets.map((sheet, index) => (
    `<sheet name="${xmlEscape(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`
  )).join('');

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>${sheetEntries}</sheets>
</workbook>`;
}

function buildWorkbookRelsXml(sheets) {
  const sheetRels = sheets.map((sheet, index) => (
    `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`
  )).join('');
  const styleRelId = `rId${sheets.length + 1}`;

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  ${sheetRels}
  <Relationship Id="${styleRelId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;
}

function buildContentTypesXml(sheets) {
  const sheetOverrides = sheets.map((sheet, index) => (
    `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`
  )).join('');

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
  ${sheetOverrides}
</Types>`;
}

function buildStylesXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts count="2">
    <font><sz val="11"/><name val="Calibri"/></font>
    <font><b/><sz val="11"/><name val="Calibri"/></font>
  </fonts>
  <fills count="2">
    <fill><patternFill patternType="none"/></fill>
    <fill><patternFill patternType="gray125"/></fill>
  </fills>
  <borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="2">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
    <xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>
  </cellXfs>
  <cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;
}

function buildSharedStringsXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="1" uniqueCount="1">
  <si><t>_unused</t></si>
</sst>`;
}

function buildRootRelsXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`;
}

function buildAppXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties">
  <Application>Node.js</Application>
</Properties>`;
}

function buildCoreXml() {
  const now = new Date().toISOString();
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:title>Final CHDB phone update review</dc:title>
  <dc:creator>updatePhonesFromFinalChdb.js</dc:creator>
  <cp:lastModifiedBy>updatePhonesFromFinalChdb.js</cp:lastModifiedBy>
  <dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created>
  <dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified>
</cp:coreProperties>`;
}

const CRC32_TABLE = (() => {
  const table = new Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xEDB88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xFFFFFFFF;
  for (let index = 0; index < buffer.length; index += 1) {
    crc = CRC32_TABLE[(crc ^ buffer[index]) & 0xFF] ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function getDosDateTime(date) {
  const year = Math.max(date.getFullYear(), 1980);
  const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const dosDate = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { dosDate, dosTime };
}

function createZip(files) {
  const localChunks = [];
  const centralChunks = [];
  let offset = 0;
  const now = new Date();
  const { dosDate, dosTime } = getDosDateTime(now);

  for (const file of files) {
    const nameBuffer = Buffer.from(file.name, 'utf8');
    const dataBuffer = Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data, 'utf8');
    const checksum = crc32(dataBuffer);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0x0800, 6);
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt16LE(dosTime, 10);
    localHeader.writeUInt16LE(dosDate, 12);
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(dataBuffer.length, 18);
    localHeader.writeUInt32LE(dataBuffer.length, 22);
    localHeader.writeUInt16LE(nameBuffer.length, 26);
    localHeader.writeUInt16LE(0, 28);

    localChunks.push(localHeader, nameBuffer, dataBuffer);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0x0800, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt16LE(dosTime, 12);
    centralHeader.writeUInt16LE(dosDate, 14);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(dataBuffer.length, 20);
    centralHeader.writeUInt32LE(dataBuffer.length, 24);
    centralHeader.writeUInt16LE(nameBuffer.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);

    centralChunks.push(centralHeader, nameBuffer);
    offset += localHeader.length + nameBuffer.length + dataBuffer.length;
  }

  const centralDirectory = Buffer.concat(centralChunks);
  const centralDirectoryOffset = offset;
  const endOfCentralDirectory = Buffer.alloc(22);
  endOfCentralDirectory.writeUInt32LE(0x06054b50, 0);
  endOfCentralDirectory.writeUInt16LE(0, 4);
  endOfCentralDirectory.writeUInt16LE(0, 6);
  endOfCentralDirectory.writeUInt16LE(files.length, 8);
  endOfCentralDirectory.writeUInt16LE(files.length, 10);
  endOfCentralDirectory.writeUInt32LE(centralDirectory.length, 12);
  endOfCentralDirectory.writeUInt32LE(centralDirectoryOffset, 16);
  endOfCentralDirectory.writeUInt16LE(0, 20);

  return Buffer.concat([...localChunks, centralDirectory, endOfCentralDirectory]);
}

function writeXlsxFile(outputPath, sheets) {
  const files = [
    { name: '[Content_Types].xml', data: buildContentTypesXml(sheets) },
    { name: '_rels/.rels', data: buildRootRelsXml() },
    { name: 'docProps/app.xml', data: buildAppXml() },
    { name: 'docProps/core.xml', data: buildCoreXml() },
    { name: 'xl/workbook.xml', data: buildWorkbookXml(sheets) },
    { name: 'xl/_rels/workbook.xml.rels', data: buildWorkbookRelsXml(sheets) },
    { name: 'xl/sharedStrings.xml', data: buildSharedStringsXml() },
    { name: 'xl/styles.xml', data: buildStylesXml() },
    ...sheets.map((sheet, index) => ({
      name: `xl/worksheets/sheet${index + 1}.xml`,
      data: buildSheetXml(sheet.rows),
    })),
  ];

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, createZip(files));
}

function assertSchemaFields() {
  const missingFields = ['fullName', 'nationalId', PHONE_FIELD].filter((field) => !User.schema.path(field));
  if (missingFields.length) {
    throw new Error(
      `User schema is missing required field(s): ${missingFields.join(', ')}. No database writes were executed.`
    );
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const workbookPath = path.resolve(options.file);
  const reviewPath = ensureReviewPath(options.reviewFile);

  if (!fs.existsSync(workbookPath)) {
    throw new Error(`Workbook file was not found: ${workbookPath}`);
  }

  assertSchemaFields();

  console.log(`[workbook] reading ${workbookPath} sheet "${options.sheet}"`);
  const workbook = loadWorkbookRows(workbookPath, options.sheet);
  const allRows = Array.isArray(workbook.rows) ? workbook.rows : [];
  if (!allRows.length) {
    throw new Error(`No worksheet rows were found in sheet "${options.sheet}".`);
  }

  const sortedRows = [...allRows].sort((left, right) => Number(left.rowNumber) - Number(right.rowNumber));
  const headerRow = sortedRows[0];
  const columns = detectColumns(headerRow);
  const dataRows = sortedRows.filter((row) => (
    Number(row.rowNumber) > Number(headerRow.rowNumber)
    && Number(row.rowNumber) <= options.maxExcelRow
  ));

  console.log(
    `[workbook] detected columns: name=${columns.nameColumn}, phone=${columns.phoneColumn}, nationalId=${columns.nationalIdColumn}`
  );
  console.log(`[workbook] worksheet rows=${allRows.length}; rows to process=${dataRows.length}; maxExcelRow=${options.maxExcelRow}`);

  console.log('[database] connecting');
  await mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/church');
  console.log('[database] loading existing people');
  const users = await User.find({})
    .select(`_id fullName nationalId ${PHONE_FIELD}`)
    .lean();
  const lookups = buildUserLookupMaps(users);

  console.log(`[plan] loaded ${users.length} existing non-deleted people`);
  const records = buildReviewRecords({ columns, dataRows, lookups });
  applyPostMatchSafety(records, lookups);
  const plannedUpdateCount = records.filter((record) => record.action === 'WILL_UPDATE').length;

  let updateResult = null;
  if (options.apply) {
    console.log(`[apply] applying ${plannedUpdateCount} phone update(s) with batch size ${options.batchSize}`);
    updateResult = await executeUpdates(records, options.batchSize);
    console.log(`[apply] matched=${updateResult.matchedCount}; modified=${updateResult.modifiedCount}; updatedRows=${updateResult.updatedRows}`);
  } else {
    console.log(`[dry-run] ${plannedUpdateCount} phone update(s) would be written. No database writes were executed.`);
  }

  const summary = summarize({
    maxExcelRow: options.maxExcelRow,
    plannedUpdateCount,
    records,
    totalWorksheetRows: allRows.length,
    updateResult,
  });
  writeXlsxFile(reviewPath, [{ name: 'Review', rows: buildReviewRows(records) }]);
  printSummary(summary);
  console.log(`Review Excel: ${reviewPath}`);
  console.log(`Database writes executed: ${options.apply ? summary.updated : 0}`);
}

main()
  .catch((error) => {
    console.error(`Phone update workflow failed: ${error.message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect().catch(() => {});
  });
