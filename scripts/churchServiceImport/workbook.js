const ExcelJS = require('exceljs');
const { cleanExactName } = require('../../src/utils/arabicNormalization');

const EXPECTED_ROW_COUNT = 3729;
const EXPECTED_SECTOR_ROWS = Object.freeze({
  'التربية الكنسية': 1439,
  'قطاعات الكبار': 2290,
});
const EXPECTED_MEETING_ROWS = Object.freeze({
  'المرضي': 33,
  'جامعيين': 132,
  'الام رفقة': 162,
  'شابات': 61,
  'بيتي علي الصخر': 697,
  'شباب': 626,
  'الحكماء': 425,
  'الرجال': 154,
  'ثانوي بنات': 89,
  'التلمذه': 221,
  'اعدادي بنين': 110,
  'حضانة': 275,
  'ابتدائي 2': 249,
  'ثانوي بنين': 95,
  'ابتدائي 1': 271,
  'اعدادي بنات': 129,
});
const EXPECTED_MEETING_GROUPS = Object.freeze({
  'المرضي': 1,
  'جامعيين': 2,
  'الام رفقة': 4,
  'شابات': 2,
  'بيتي علي الصخر': 9,
  'شباب': 7,
  'الحكماء': 6,
  'الرجال': 4,
  'ثانوي بنات': 6,
  'التلمذه': 6,
  'اعدادي بنين': 5,
  'حضانة': 9,
  'ابتدائي 2': 10,
  'ثانوي بنين': 5,
  'ابتدائي 1': 9,
  'اعدادي بنات': 6,
});

function scalarCellValue(value, cellAddress = '') {
  let candidate = value;
  if (candidate && typeof candidate === 'object' && Object.prototype.hasOwnProperty.call(candidate, 'formula')) {
    candidate = candidate.result;
  }
  if (candidate && typeof candidate === 'object' && Object.prototype.hasOwnProperty.call(candidate, 'error')) {
    throw new Error(`Excel error ${candidate.error} in ${cellAddress}`);
  }
  if (candidate && typeof candidate === 'object' && Array.isArray(candidate.richText)) {
    candidate = candidate.richText.map((part) => part.text || '').join('');
  }
  if (candidate == null) return '';
  const result = candidate instanceof Date ? candidate.toISOString() : String(candidate);
  if (/^#(?:NAME\?|REF!|VALUE!|N\/A|DIV\/0!|NUM!|NULL!)$/i.test(result.trim())) {
    throw new Error(`Unusable cached formula result ${result.trim()} in ${cellAddress}`);
  }
  return result;
}

function increment(map, key) {
  map.set(key, (map.get(key) || 0) + 1);
}

function sourceName(value) {
  return String(value ?? '').normalize('NFKC').trim();
}

function assertMapEquals(actual, expected, label) {
  const actualObject = Object.fromEntries([...actual.entries()].sort(([a], [b]) => a.localeCompare(b, 'ar')));
  const expectedObject = Object.fromEntries(Object.entries(expected).sort(([a], [b]) => a.localeCompare(b, 'ar')));
  if (JSON.stringify(actualObject) !== JSON.stringify(expectedObject)) {
    throw new Error(`${label} baseline mismatch. Expected ${JSON.stringify(expectedObject)}, got ${JSON.stringify(actualObject)}`);
  }
}

async function parseWorkbook(inputPath) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(inputPath);
  if (workbook.worksheets.length !== 1 || workbook.worksheets[0].name !== 'Sheet2') {
    throw new Error(`Expected exactly one worksheet named Sheet2; found ${workbook.worksheets.map((s) => s.name).join(', ')}`);
  }
  const sheet = workbook.getWorksheet('Sheet2');
  const rows = [];
  for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber += 1) {
    const row = sheet.getRow(rowNumber);
    const get = (column) => scalarCellValue(row.getCell(column).value, `${column}${rowNumber}`);
    const parsed = {
      rowNumber,
      sector: cleanExactName(get('A')),
      meeting: cleanExactName(get('B')),
      grade: cleanExactName(get('C')),
      group: cleanExactName(get('D')),
      declaredServants: cleanExactName(get('E')),
      servants: ['F', 'G', 'H', 'I', 'J'].map(get).map(sourceName).filter(Boolean),
      declaredMembers: cleanExactName(get('K')),
      member: sourceName(get('L')),
    };
    const populated = [parsed.sector, parsed.meeting, parsed.grade, parsed.group, parsed.member, ...parsed.servants].some(Boolean);
    if (populated) rows.push(parsed);
  }
  if (rows.length !== EXPECTED_ROW_COUNT) {
    throw new Error(`Parsing error: expected ${EXPECTED_ROW_COUNT} populated data rows, got ${rows.length}`);
  }
  if (sheet.rowCount !== 3730 || sheet.columnCount < 13) {
    throw new Error(`Parsing error: expected used range A1:M3730, got ${sheet.rowCount} rows and ${sheet.columnCount} columns`);
  }
  const sectorCounts = new Map();
  const meetingCounts = new Map();
  const groupKeysByMeeting = new Map();
  for (const row of rows) {
    if (!row.sector || !row.meeting || !row.group || !row.member) {
      throw new Error(`Parsing error: required cached value missing in row ${row.rowNumber}`);
    }
    increment(sectorCounts, row.sector);
    increment(meetingCounts, row.meeting);
    if (!groupKeysByMeeting.has(row.meeting)) groupKeysByMeeting.set(row.meeting, new Set());
    groupKeysByMeeting.get(row.meeting).add([row.sector, row.meeting, row.grade, row.group].join('\u001f'));
  }
  assertMapEquals(sectorCounts, EXPECTED_SECTOR_ROWS, 'Sector row counts');
  assertMapEquals(meetingCounts, EXPECTED_MEETING_ROWS, 'Meeting row counts');
  const groupCounts = new Map([...groupKeysByMeeting].map(([meeting, keys]) => [meeting, keys.size]));
  assertMapEquals(groupCounts, EXPECTED_MEETING_GROUPS, 'Meeting group counts');
  const uniqueGroupCount = [...groupKeysByMeeting.values()].reduce((sum, keys) => sum + keys.size, 0);
  if (uniqueGroupCount !== 91) throw new Error(`Parsing error: expected 91 groups, got ${uniqueGroupCount}`);
  const servantSpellings = new Set(rows.flatMap((row) => row.servants));
  const memberSpellings = new Set(rows.map((row) => row.member));
  const combinedSpellings = new Set([...servantSpellings, ...memberSpellings]);
  if (servantSpellings.size !== 213 || memberSpellings.size !== 3562 || combinedSpellings.size !== 3711) {
    throw new Error(`Parsing error: source-name baseline mismatch (servants ${servantSpellings.size}/213, members ${memberSpellings.size}/3562, combined ${combinedSpellings.size}/3711)`);
  }
  return { rows, sectorCounts, meetingCounts, groupCounts, uniqueGroupCount, sheetName: sheet.name };
}

module.exports = {
  EXPECTED_ROW_COUNT,
  scalarCellValue,
  parseWorkbook,
};
