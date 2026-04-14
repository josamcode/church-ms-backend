const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const mongoose = require('mongoose');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const User = require('../src/modules/users/user.model');
const { ROLES } = require('../src/constants/roles');
const { ACCOUNT_STATUSES } = require('../src/constants/accountStatuses');
const { PRESENCE_STATUSES } = require('../src/constants/householdProfiles');

const DEFAULT_SHEET = 'Form responses 1';
const REPORT_DIR = path.join(__dirname, '..', 'tmp', 'import-reports');
const POWERSHELL_SCRIPT = path.join(__dirname, 'readWorkbookSheet.ps1');
const VALID_TRAVEL_VALUES = new Set(['', 'نعم', 'لا', 'مسافر']);
const VALID_CHRONIC_VALUES = new Set(['', 'نعم', 'لا']);

function parseArgs(argv) {
  const args = {
    apply: false,
    file: '',
    limit: null,
    report: '',
    sheet: DEFAULT_SHEET,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (token === '--apply') {
      args.apply = true;
      continue;
    }

    if (token === '--file') {
      args.file = argv[index + 1] || '';
      index += 1;
      continue;
    }

    if (token === '--sheet') {
      args.sheet = argv[index + 1] || DEFAULT_SHEET;
      index += 1;
      continue;
    }

    if (token === '--report') {
      args.report = argv[index + 1] || '';
      index += 1;
      continue;
    }

    if (token === '--limit') {
      const parsedLimit = Number.parseInt(argv[index + 1] || '', 10);
      args.limit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : null;
      index += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${token}`);
  }

  if (!args.file) {
    throw new Error('Missing required argument: --file <path-to-workbook>');
  }

  return args;
}

function normalizeWhitespace(value) {
  return String(value || '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeNationalId(value) {
  return String(value || '').replace(/\D/g, '');
}

function isPlaceholderNationalId(nationalId) {
  if (!nationalId) return true;
  return /^0+$/.test(nationalId);
}

function excelSerialToIsoDate(value) {
  const serial = Number.parseFloat(String(value || '').trim());
  if (!Number.isFinite(serial)) return '';
  if (serial <= 0) return '';

  const excelEpochUtcMs = Date.UTC(1899, 11, 30);
  const wholeDays = Math.floor(serial);
  const date = new Date(excelEpochUtcMs + wholeDays * 24 * 60 * 60 * 1000);
  if (Number.isNaN(date.getTime())) return '';

  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + 1;
  const day = date.getUTCDate();
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function parseLooseDate(value) {
  const trimmed = normalizeWhitespace(value);
  if (!trimmed) return '';

  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    return excelSerialToIsoDate(trimmed);
  }

  const slashMatch = trimmed.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})$/);
  if (slashMatch) {
    let [, day, month, year] = slashMatch;
    if (year.length === 2) {
      year = Number.parseInt(year, 10) > 30 ? `19${year}` : `20${year}`;
    }
    return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }

  const date = new Date(trimmed);
  if (Number.isNaN(date.getTime())) return '';

  return date.toISOString().slice(0, 10);
}

function getDaysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function extractBirthDateFromNationalId(nationalId) {
  const digits = normalizeNationalId(nationalId);
  if (digits.length < 7) return '';

  const centuryDigit = digits[0];
  const yearPart = Number.parseInt(digits.slice(1, 3), 10);
  const month = Number.parseInt(digits.slice(3, 5), 10);
  const day = Number.parseInt(digits.slice(5, 7), 10);

  const centuryBase =
    centuryDigit === '1' ? 1800
      : centuryDigit === '2' ? 1900
        : centuryDigit === '3' ? 2000
          : null;

  if (!centuryBase) return '';

  const year = centuryBase + yearPart;
  const maxDay = getDaysInMonth(year, month);
  if (!month || month > 12 || !day || day > maxDay) return '';

  const candidate = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  return isPlausibleBirthDate(candidate) ? candidate : '';
}

function isPlausibleBirthDate(value) {
  if (!value) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return false;

  const now = new Date();
  if (date.getTime() > now.getTime()) return false;

  const oldestAllowed = new Date();
  oldestAllowed.setUTCFullYear(oldestAllowed.getUTCFullYear() - 120);
  return date.getTime() >= oldestAllowed.getTime();
}

function mapGender(value) {
  const normalized = normalizeWhitespace(value);
  if (!normalized) return { value: undefined };
  if (['ذكر', 'ذكر ', 'male', 'Male'].includes(normalized)) {
    return { value: 'male' };
  }
  if (['انثي', 'أنثى', 'انثى', 'female', 'Female'].includes(normalized)) {
    return { value: 'female' };
  }
  return {
    value: undefined,
    warning: `Unexpected gender value "${normalized}"`,
  };
}

function mapPresence(value) {
  const normalized = normalizeWhitespace(value);
  if (!normalized || normalized === 'لا') {
    return { value: { status: PRESENCE_STATUSES.PRESENT } };
  }
  if (normalized === 'نعم' || normalized === 'مسافر') {
    return { value: { status: PRESENCE_STATUSES.TRAVELING } };
  }
  return {
    value: undefined,
    warning: `Unexpected travel value "${normalized}"`,
  };
}

function mapHealth(value) {
  const normalized = normalizeWhitespace(value);
  if (!normalized || normalized === 'لا') {
    return { value: undefined };
  }
  if (normalized === 'نعم') {
    return {
      value: {
        conditions: [
          {
            name: 'Imported chronic condition',
            chronic: true,
            notes: 'Workbook marked this user as having a chronic condition.',
          },
        ],
      },
    };
  }
  return {
    value: undefined,
    warning: `Unexpected chronic-condition value "${normalized}"`,
  };
}

function getRowMapper(sheetName) {
  const normalizedSheetName = normalizeWhitespace(sheetName);

  if (normalizedSheetName === 'Sheet1') {
    return (row) => {
      const cells = row.cells || {};
      return {
        area: '',
        birthDateCell: '',
        chronicRaw: '',
        confessionFather: '',
        educationLevel: '',
        educationYear: '',
        fullName: cells.A,
        gender: cells.B,
        maritalStatus: cells.C,
        nationalId: cells.E || cells.D,
        reportedAge: '',
        timestamp: '',
        travelRaw: '',
      };
    };
  }

  return (row) => {
    const cells = row.cells || {};
    return {
      area: cells.C,
      birthDateCell: cells.H,
      chronicRaw: cells.M,
      confessionFather: cells.N,
      educationLevel: cells.J,
      educationYear: cells.K,
      fullName: cells.D,
      gender: cells.E,
      maritalStatus: cells.F,
      nationalId: cells.G,
      reportedAge: cells.I,
      timestamp: cells.A,
      travelRaw: cells.L,
    };
  };
}

function createIssue(code, message, fatal = false) {
  return { code, fatal, message };
}

function buildRejectedFilePaths(reportPath) {
  const extension = path.extname(reportPath) || '.json';
  const baseName = path.basename(reportPath, extension);
  const directory = path.dirname(reportPath);
  const rejectedBaseName = baseName.includes('report')
    ? baseName.replace('report', 'rejected')
    : `${baseName}-rejected`;

  return {
    csvPath: path.join(directory, `${rejectedBaseName}.csv`),
    jsonPath: path.join(directory, `${rejectedBaseName}.json`),
  };
}

function toCsvValue(value) {
  const normalized = value == null ? '' : String(value);
  return `"${normalized.replace(/"/g, '""')}"`;
}

function buildRejectedRowExport(row) {
  const fatalIssues = row.issues.filter((issue) => issue.fatal);
  const warningIssues = row.issues.filter((issue) => !issue.fatal);

  return {
    allIssues: row.issues,
    fullName: row.fullName,
    nationalId: row.nationalId,
    payloadPreview: {
      birthDate: row.payload.birthDate
        ? row.payload.birthDate.toISOString().slice(0, 10)
        : undefined,
      fullName: row.payload.fullName,
      gender: row.payload.gender,
      nationalId: row.payload.nationalId,
    },
    rawCells: row.rawCells,
    rejectionCodes: fatalIssues.map((issue) => issue.code),
    rejectionReasons: fatalIssues.map((issue) => issue.message),
    rowNumber: row.rowNumber,
    source: row.source,
    status: 'rejected',
    warningCodes: warningIssues.map((issue) => issue.code),
    warningMessages: warningIssues.map((issue) => issue.message),
  };
}

function writeRejectedRowsFiles({ reportPath, rejectedRows, sheetName, workbookPath }) {
  if (!rejectedRows.length) {
    return { csvPath: null, jsonPath: null };
  }

  const rejectedExports = rejectedRows.map((row) => buildRejectedRowExport(row));
  const rejectedPaths = buildRejectedFilePaths(reportPath);

  fs.writeFileSync(
    rejectedPaths.jsonPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        rejectedCount: rejectedExports.length,
        rows: rejectedExports,
        sheetName,
        workbookPath,
      },
      null,
      2
    ),
    'utf8'
  );

  const csvHeaders = [
    'rowNumber',
    'fullName',
    'nationalId',
    'rejectionCodes',
    'rejectionReasons',
    'warningCodes',
    'warningMessages',
    'area',
    'gender',
    'maritalStatus',
    'birthDateCell',
    'reportedAge',
    'educationLevel',
    'educationYear',
    'travelRaw',
    'chronicRaw',
    'confessionFather',
    'timestamp',
    'rawCellsJson',
  ];

  const csvLines = [csvHeaders.map((header) => toCsvValue(header)).join(',')];
  for (const row of rejectedExports) {
    csvLines.push(
      [
        row.rowNumber,
        row.fullName,
        row.nationalId,
        row.rejectionCodes.join(' | '),
        row.rejectionReasons.join(' | '),
        row.warningCodes.join(' | '),
        row.warningMessages.join(' | '),
        row.source.area,
        row.source.gender,
        row.source.maritalStatus,
        row.source.birthDateCell,
        row.source.reportedAge,
        row.source.educationLevel,
        row.source.educationYear,
        row.source.travelRaw,
        row.source.chronicRaw,
        row.source.confessionFather,
        row.source.timestamp,
        JSON.stringify(row.rawCells),
      ]
        .map((value) => toCsvValue(value))
        .join(',')
    );
  }

  fs.writeFileSync(rejectedPaths.csvPath, `\uFEFF${csvLines.join('\n')}`, 'utf8');
  return rejectedPaths;
}

function analyzeRow(row, sheetName) {
  const mapRow = getRowMapper(sheetName);
  const source = mapRow(row);
  const issues = [];
  const warnings = [];

  const fullName = normalizeWhitespace(source.fullName);
  if (!fullName) {
    issues.push(createIssue('missing_full_name', 'Full name is empty.', true));
  } else if (fullName.length < 2) {
    issues.push(createIssue('invalid_full_name', 'Full name is too short.', true));
  }

  const nationalId = normalizeNationalId(source.nationalId);
  if (!nationalId) {
    issues.push(createIssue('missing_national_id', 'National ID is missing.', true));
  } else if (nationalId.length !== 14 || isPlaceholderNationalId(nationalId)) {
    issues.push(
      createIssue(
        'invalid_national_id',
        `National ID "${nationalId}" is missing digits or looks like placeholder data.`,
        true
      )
    );
  }

  const derivedBirthDate = extractBirthDateFromNationalId(nationalId);
  const parsedBirthDate = parseLooseDate(source.birthDateCell);
  let chosenBirthDate = parsedBirthDate || derivedBirthDate;

  if (parsedBirthDate && !isPlausibleBirthDate(parsedBirthDate)) {
    issues.push(
      createIssue(
        'invalid_birth_date',
        `Birth date "${source.birthDateCell}" is not plausible.`,
        true
      )
    );
  }

  if (!parsedBirthDate && source.birthDateCell && !/^\d+(\.\d+)?$/.test(String(source.birthDateCell).trim())) {
    warnings.push(
      createIssue(
        'unexpected_birth_date_format',
        `Birth date cell "${normalizeWhitespace(source.birthDateCell)}" could not be parsed.`,
        false
      )
    );
  }

  if (!chosenBirthDate && nationalId) {
    issues.push(
      createIssue(
        'unresolved_birth_date',
        'Birth date could not be derived from either the sheet cell or the national ID.',
        true
      )
    );
  }

  if (parsedBirthDate && derivedBirthDate && parsedBirthDate !== derivedBirthDate) {
    issues.push(
      createIssue(
        'birth_date_national_id_mismatch',
        `Birth date "${parsedBirthDate}" does not match national ID-derived date "${derivedBirthDate}".`,
        true
      )
    );
  }

  if (chosenBirthDate && !isPlausibleBirthDate(chosenBirthDate)) {
    issues.push(
      createIssue(
        'implausible_birth_date',
        `Birth date "${chosenBirthDate}" is outside the supported range.`,
        true
      )
    );
  }

  const gender = mapGender(source.gender);
  if (gender.warning) {
    warnings.push(createIssue('unexpected_gender', gender.warning, false));
  }

  const presence = mapPresence(source.travelRaw);
  if (presence.warning) {
    warnings.push(createIssue('unexpected_travel_value', presence.warning, false));
  }

  const health = mapHealth(source.chronicRaw);
  if (health.warning) {
    warnings.push(createIssue('unexpected_chronic_value', health.warning, false));
  }

  const normalizedTravel = normalizeWhitespace(source.travelRaw);
  if (!VALID_TRAVEL_VALUES.has(normalizedTravel)) {
    warnings.push(
      createIssue(
        'travel_value_outside_expected_set',
        `Travel column contains unexpected value "${normalizedTravel}".`,
        false
      )
    );
  }

  const normalizedChronic = normalizeWhitespace(source.chronicRaw);
  if (!VALID_CHRONIC_VALUES.has(normalizedChronic)) {
    warnings.push(
      createIssue(
        'chronic_value_outside_expected_set',
        `Chronic-condition column contains unexpected value "${normalizedChronic}".`,
        false
      )
    );
  }

  const confessionFatherName = normalizeWhitespace(source.confessionFather);
  const spiritualFather =
    confessionFatherName && !['لا يوجد', 'لا يوجد.', 'لا يوجد..'].includes(confessionFatherName)
      ? confessionFatherName
      : undefined;

  const customDetails = {};
  const importArea = normalizeWhitespace(source.area);
  const maritalStatus = normalizeWhitespace(source.maritalStatus);
  const reportedAge = normalizeWhitespace(source.reportedAge);
  const educationLevel = normalizeWhitespace(source.educationLevel);
  const educationYear = normalizeWhitespace(source.educationYear);
  const timestamp = normalizeWhitespace(source.timestamp);

  if (importArea) customDetails.importArea = importArea;
  if (maritalStatus) customDetails.importMaritalStatus = maritalStatus;
  if (reportedAge) customDetails.importReportedAge = reportedAge;
  if (educationLevel) customDetails.importEducationLevel = educationLevel;
  if (educationYear) customDetails.importEducationYear = educationYear;
  if (timestamp) customDetails.importTimestamp = timestamp;
  customDetails.importSheet = sheetName;
  customDetails.importRowNumber = String(row.rowNumber);

  const userPayload = {
    accountStatus: ACCOUNT_STATUSES.APPROVED,
    birthDate: chosenBirthDate ? new Date(`${chosenBirthDate}T00:00:00.000Z`) : undefined,
    confessionFatherName: spiritualFather,
    customDetails,
    fullName,
    gender: gender.value,
    hasLogin: false,
    health: health.value,
    nationalId,
    presence: presence.value,
    role: ROLES.USER,
  };

  Object.keys(userPayload).forEach((key) => {
    if (userPayload[key] === undefined) {
      delete userPayload[key];
    }
  });

  return {
    fullName,
    issues: [...issues, ...warnings],
    nationalId,
    payload: userPayload,
    rawCells: { ...(row.cells || {}) },
    rowNumber: row.rowNumber,
    source,
  };
}

function countIssues(rows) {
  const counts = {};
  for (const row of rows) {
    for (const issue of row.issues) {
      counts[issue.code] = (counts[issue.code] || 0) + 1;
    }
  }
  return counts;
}

function getFatalIssues(row) {
  return row.issues.filter((issue) => issue.fatal);
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

function ensureReportPath(customReportPath) {
  if (customReportPath) {
    return path.resolve(customReportPath);
  }

  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join(REPORT_DIR, `users-import-report-${timestamp}.json`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const reportPath = ensureReportPath(options.report);
  const workbookPath = path.resolve(options.file);

  if (!fs.existsSync(workbookPath)) {
    throw new Error(`Workbook file was not found: ${workbookPath}`);
  }

  const workbook = loadWorkbookRows(workbookPath, options.sheet);
  const allRows = Array.isArray(workbook.rows) ? workbook.rows : [];
  const dataRows =
    options.sheet === DEFAULT_SHEET
      ? allRows.filter((row) => Number(row.rowNumber) > 1)
      : allRows;
  const limitedRows =
    options.limit && options.limit > 0 ? dataRows.slice(0, options.limit) : dataRows;

  const analyzedRows = limitedRows.map((row) => analyzeRow(row, options.sheet));

  const firstSeenByNationalId = new Map();
  for (const row of analyzedRows) {
    if (!row.nationalId || getFatalIssues(row).length > 0) {
      continue;
    }

    const firstRowNumber = firstSeenByNationalId.get(row.nationalId);
    if (firstRowNumber) {
      row.issues.push(
        createIssue(
          'duplicate_national_id_in_file',
          `National ID already appeared in row ${firstRowNumber}.`,
          true
        )
      );
      continue;
    }

    firstSeenByNationalId.set(row.nationalId, row.rowNumber);
  }

  const candidates = analyzedRows.filter((row) => getFatalIssues(row).length === 0);
  const candidateNationalIds = [...new Set(candidates.map((row) => row.nationalId).filter(Boolean))];

  await mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/church');

  const existingUsers = await User.find({
    nationalId: { $in: candidateNationalIds },
  })
    .select('_id nationalId fullName')
    .lean();

  const existingByNationalId = new Map(
    existingUsers.map((user) => [normalizeNationalId(user.nationalId), user])
  );

  for (const row of candidates) {
    const existing = existingByNationalId.get(row.nationalId);
    if (!existing) {
      continue;
    }

    row.issues.push(
      createIssue(
        'already_exists_in_database',
        `A user with national ID ${row.nationalId} already exists (${existing.fullName}).`,
        true
      )
    );
  }

  const rejectedRows = analyzedRows.filter((row) => getFatalIssues(row).length > 0);
  const importableRows = analyzedRows.filter((row) => getFatalIssues(row).length === 0);

  const report = {
    applyRequested: options.apply,
    generatedAt: new Date().toISOString(),
    reportPath,
    sheetName: options.sheet,
    summary: {
      existingInDatabase: analyzedRows.filter((row) =>
        row.issues.some((issue) => issue.code === 'already_exists_in_database')
      ).length,
      importableRows: importableRows.length,
      rejectedRows: rejectedRows.length,
      totalRowsRead: limitedRows.length,
    },
    workbookPath,
    issueCounts: countIssues(analyzedRows),
    rows: analyzedRows.map((row) => ({
      fullName: row.fullName,
      issues: row.issues,
      nationalId: row.nationalId,
      payloadPreview: {
        birthDate: row.payload.birthDate
          ? row.payload.birthDate.toISOString().slice(0, 10)
          : undefined,
        fullName: row.payload.fullName,
        gender: row.payload.gender,
        nationalId: row.payload.nationalId,
      },
      rowNumber: row.rowNumber,
      source: row.source,
      status: getFatalIssues(row).length === 0 ? 'ready' : 'rejected',
    })),
  };

  let createdCount = 0;
  if (options.apply && importableRows.length > 0) {
    for (const row of importableRows) {
      const user = new User(row.payload);
      await user.save();
      createdCount += 1;
    }
  }

  report.summary.createdRows = createdCount;
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  const rejectedFilePaths = writeRejectedRowsFiles({
    reportPath,
    rejectedRows,
    sheetName: options.sheet,
    workbookPath,
  });
  report.rejectedDataFiles = rejectedFilePaths;
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');

  console.log(`Workbook: ${workbookPath}`);
  console.log(`Sheet: ${options.sheet}`);
  console.log(`Rows read: ${limitedRows.length}`);
  console.log(`Ready to import: ${importableRows.length}`);
  console.log(`Rejected: ${rejectedRows.length}`);
  console.log(`Existing in database: ${report.summary.existingInDatabase}`);
  console.log(`Created: ${createdCount}`);
  console.log(`Report: ${reportPath}`);
  if (rejectedFilePaths.jsonPath) {
    console.log(`Rejected JSON: ${rejectedFilePaths.jsonPath}`);
    console.log(`Rejected CSV: ${rejectedFilePaths.csvPath}`);
  }
  console.log(
    options.apply
      ? 'Import completed.'
      : 'Dry run only. Re-run with --apply after reviewing the report.'
  );
}

main()
  .catch((error) => {
    if (String(error.message || '').includes('phonePrimary_1 dup key: { phonePrimary: null }')) {
      console.error(
        'Import failed because the local users collection still has an old phonePrimary index. Run "npm run users:repair-phone-index" once, then retry the import.'
      );
    }
    console.error(`Import failed: ${error.message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect().catch(() => {});
  });
