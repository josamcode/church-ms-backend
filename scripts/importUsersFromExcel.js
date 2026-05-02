const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { EDUCATION_STAGE_VALUES } = require('../src/constants/education');
const { ACCOUNT_STATUSES } = require('../src/constants/accountStatuses');
const { ROLES } = require('../src/constants/roles');
const User = require('../src/modules/users/user.model');
const { DEFAULT_LABELS: RELATION_ROLE_LABELS } = require('../src/modules/users/relationRole.model');

const DEFAULT_SHEET = 'Form responses 1';
const REPORT_DIR = path.join(__dirname, '..', 'tmp', 'import-reports');
const POWERSHELL_SCRIPT = path.join(__dirname, 'readWorkbookSheet.ps1');

const ACTION_REQUIRED_TAG = 'يجب اتخاذ إجراء تعديل';
const ALL_ZERO_NATIONAL_ID = '00000000000000';
const IMPORT_CONFIRMATION = 'IMPORT_USERS_FROM_REVIEW';
const OPTIONAL_UNIQUE_FIELDS = Object.freeze(['email', 'phonePrimary', 'nationalId']);
const DEFAULT_IMPORT_BATCH_SIZE = 100;

const CONFESSION_FATHER_ACCOUNTS = Object.freeze({
  beeshoy: {
    accountId: '69c0aa00001aa7c36395046a',
    canonicalName: 'القس بيشوي نجيب',
  },
  bola: {
    accountId: '69c0a60993612f701936a5e6',
    canonicalName: 'القس بولا عبد الملاك',
  },
});

const RELATION_LABEL_BY_KEY = RELATION_ROLE_LABELS.reduce((acc, entry) => {
  acc[entry.label] = entry;
  return acc;
}, {});

const EDUCATION_DISPLAY_LABELS = Object.freeze({
  kindergarten_unspecified_year: 'رياض الاطفال - سنة غير محددة',
  kindergarten_kg1: 'KG1',
  kindergarten_kg2: 'KG2',
  primary_unspecified_year: 'المرحلة الابتدائية - سنة غير محددة',
  primary_grade_1: 'الصف الأول الابتدائي',
  primary_grade_2: 'الصف الثاني الابتدائي',
  primary_grade_3: 'الصف الثالث الابتدائي',
  primary_grade_4: 'الصف الرابع الابتدائي',
  primary_grade_5: 'الصف الخامس الابتدائي',
  primary_grade_6: 'الصف السادس الابتدائي',
  preparatory_unspecified_year: 'المرحلة الاعدادية - سنة غير محددة',
  preparatory_grade_1: 'الصف الأول الاعدادي',
  preparatory_grade_2: 'الصف الثاني الاعدادي',
  preparatory_grade_3: 'الصف الثالث الاعدادي',
  secondary_unspecified_year: 'المرحلة الثانوية - سنة غير محددة',
  secondary_general_year_1: 'الثانوي العام - السنة الأولى',
  secondary_general_year_2: 'الثانوي العام - السنة الثانية',
  secondary_general_year_3: 'الثانوي العام - السنة الثالثة',
  university_unspecified_year: 'المرحلة الجامعية - سنة غير محددة',
  university_year_1: 'الجامعة - السنة الأولى',
  university_year_2: 'الجامعة - السنة الثانية',
  university_year_3: 'الجامعة - السنة الثالثة',
  university_year_4: 'الجامعة - السنة الرابعة',
  university_year_5: 'الجامعة - السنة الخامسة',
  university_graduate: 'خريج',
  finished_education: 'منتهي التعليم',
  uneducated: 'غير متعلم',
  literacy: 'محو امية',
  student: 'طالب',
});

function parseArgs(argv) {
  const args = {
    allowNonTransactional: false,
    confirmImport: '',
    file: '',
    limit: null,
    limitRelations: null,
    limitUsers: null,
    mode: 'review',
    output: '',
    relationBatchSize: DEFAULT_IMPORT_BATCH_SIZE,
    resultReport: '',
    reviewFile: '',
    sheet: DEFAULT_SHEET,
    userBatchSize: DEFAULT_IMPORT_BATCH_SIZE,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (token === '--apply') {
      throw new Error('--apply is disabled. Use --preflight first, then guarded --import with --confirm-import if you intend to write.');
    }

    if (token === '--preflight') {
      if (args.mode !== 'review') throw new Error('Use only one mode: review, --preflight, or --import.');
      args.mode = 'preflight';
      continue;
    }

    if (token === '--import') {
      if (args.mode !== 'review') throw new Error('Use only one mode: review, --preflight, or --import.');
      args.mode = 'import';
      continue;
    }

    if (token === '--allow-non-transactional') {
      args.allowNonTransactional = true;
      continue;
    }

    if (token === '--confirm-import') {
      args.confirmImport = argv[index + 1] || '';
      index += 1;
      continue;
    }

    if (token === '--review-file') {
      args.reviewFile = argv[index + 1] || '';
      index += 1;
      continue;
    }

    if (token === '--result-report') {
      args.resultReport = argv[index + 1] || '';
      index += 1;
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

    if (token === '--report' || token === '--output') {
      args.output = argv[index + 1] || '';
      index += 1;
      continue;
    }

    if (token === '--limit') {
      const parsedLimit = Number.parseInt(argv[index + 1] || '', 10);
      args.limit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : null;
      index += 1;
      continue;
    }

    if (token === '--limit-users') {
      const parsedLimit = Number.parseInt(argv[index + 1] || '', 10);
      args.limitUsers = Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : null;
      index += 1;
      continue;
    }

    if (token === '--limit-relations') {
      const parsedLimit = Number.parseInt(argv[index + 1] || '', 10);
      args.limitRelations = Number.isFinite(parsedLimit) && parsedLimit > 0 ? parsedLimit : null;
      index += 1;
      continue;
    }

    if (token === '--user-batch-size') {
      const parsedSize = Number.parseInt(argv[index + 1] || '', 10);
      args.userBatchSize = Number.isFinite(parsedSize) && parsedSize > 0 ? parsedSize : DEFAULT_IMPORT_BATCH_SIZE;
      index += 1;
      continue;
    }

    if (token === '--relation-batch-size') {
      const parsedSize = Number.parseInt(argv[index + 1] || '', 10);
      args.relationBatchSize = Number.isFinite(parsedSize) && parsedSize > 0 ? parsedSize : DEFAULT_IMPORT_BATCH_SIZE;
      index += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${token}`);
  }

  if (!args.file) {
    throw new Error('Missing required argument: --file <path-to-workbook>');
  }

  if ((args.mode === 'preflight' || args.mode === 'import') && !args.reviewFile) {
    throw new Error(`${args.mode} mode requires --review-file <review-workbook-path>.`);
  }

  if (args.mode === 'import' && args.confirmImport !== IMPORT_CONFIRMATION) {
    throw new Error(
      `Real import requires --confirm-import ${IMPORT_CONFIRMATION}. No database writes were executed.`
    );
  }

  return args;
}

function normalizeWhitespace(value) {
  return String(value || '')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function formatElapsed(startedAt) {
  return `${Math.round((Date.now() - startedAt) / 1000)}s`;
}

function formatRowRange(records = []) {
  const rows = records
    .map((record) => record?.person?.rowNumber || record?.rowNumber)
    .filter((rowNumber) => Number.isFinite(Number(rowNumber)))
    .map(Number);
  if (!rows.length) return 'n/a';
  return `${Math.min(...rows)}-${Math.max(...rows)}`;
}

function logProgress(stage, message, startedAt) {
  console.log(`[${stage}] ${message} - elapsed ${formatElapsed(startedAt)}`);
}

function chunkArray(items, size) {
  const chunks = [];
  const effectiveSize = Math.max(1, Number(size) || DEFAULT_IMPORT_BATCH_SIZE);
  for (let index = 0; index < items.length; index += effectiveSize) {
    chunks.push(items.slice(index, index + effectiveSize));
  }
  return chunks;
}

function normalizeNationalId(value) {
  return String(value || '').replace(/\D/g, '');
}

function getDaysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
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

function normalizeArabicForComparison(value) {
  const normalized = normalizeWhitespace(value)
    .replace(/[\u064B-\u065F\u0670\u0640]/g, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي')
    .replace(/[^\u0600-\u06FFa-zA-Z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return normalized;
}

const TITLE_WORDS = new Set([
  'ابونا',
  'القس',
  'القمص',
  'الانبا',
  'الشماس',
  'اب',
  'الاب',
  'السيد',
  'استاذ',
  'الاستاذ',
  'مدام',
  'د',
  'م',
]);

function getComparableParts(value) {
  const parts = normalizeArabicForComparison(value).split(/\s+/).filter(Boolean);
  while (parts.length > 0 && TITLE_WORDS.has(parts[0])) {
    parts.shift();
  }
  return parts;
}

function getOriginalParts(value) {
  return normalizeWhitespace(value).split(/\s+/).filter(Boolean);
}

function getHouseNameFromParts(parts) {
  if (parts.length >= 2) return `${parts[0]} ${parts[1]}`;
  return parts[0] || '';
}

function getFamilyNameFromParts(parts) {
  if (parts.length >= 3) return `${parts[1]} ${parts[2]}`;
  if (parts.length >= 2) return parts[1];
  return '';
}

function getFamilyKeyFromParts(parts) {
  if (parts.length < 3) return '';
  return `${parts[1]} ${parts[2]}`;
}

function mapGender(value) {
  const normalized = normalizeArabicForComparison(value).toLowerCase();
  if (!normalized) return { value: '', label: '' };
  if (normalized === 'ذكر' || normalized === 'male') return { value: 'male', label: 'ذكر' };
  if (['انثي', 'انثى', 'female'].includes(normalized)) return { value: 'female', label: 'أنثى' };
  return { value: '', label: normalizeWhitespace(value), warning: `Unexpected gender value "${normalizeWhitespace(value)}"` };
}

function normalizeMaritalStatus(value) {
  const original = normalizeWhitespace(value);
  const normalized = normalizeArabicForComparison(original);
  return {
    isMarried: normalized === 'متزوج' || normalized === 'متزوجه',
    isSingle: normalized === 'اعزب' || normalized === 'عازب' || normalized === 'عزباء',
    isWidowed: normalized === 'ارمل' || normalized === 'ارمله',
    normalized,
    original,
  };
}

function evaluateNationalId(rawNationalId) {
  const nationalId = normalizeNationalId(rawNationalId);
  const result = {
    birthDateFromNationalId: '',
    defaultPassword: '',
    duplicate: false,
    loginReason: '',
    loginShouldBeEnabled: false,
    loginUsername: '',
    nationalId,
    status: '',
    suggestedTags: [],
    warnings: [],
  };

  if (!nationalId) {
    result.status = 'missing / needs review';
    result.loginReason = 'No login: missing national ID and the existing import workflow does not create login access automatically.';
    result.warnings.push('National ID is missing; person is still kept for review.');
    return result;
  }

  if (nationalId === ALL_ZERO_NATIONAL_ID) {
    result.status = 'invalid / all zeros / needs correction';
    result.suggestedTags.push(ACTION_REQUIRED_TAG);
    result.loginReason = 'No login: national ID is exactly all zeros.';
    result.warnings.push('National ID is exactly 00000000000000; kept for family review and tagged for correction.');
    return result;
  }

  if (/^0+$/.test(nationalId)) {
    result.status = 'invalid / all zeros / needs correction';
    result.suggestedTags.push(ACTION_REQUIRED_TAG);
    result.loginReason = 'No login: national ID contains only zeros.';
    result.warnings.push('National ID contains only zeros; kept for family review and tagged for correction.');
    return result;
  }

  if (nationalId.length !== 14) {
    result.status = `invalid / expected 14 digits / got ${nationalId.length}`;
    result.loginReason = 'No login: invalid national ID length.';
    result.warnings.push(`National ID "${nationalId}" is ${nationalId.length} digits, expected 14.`);
    return result;
  }

  const birthDate = extractBirthDateFromNationalId(nationalId);
  if (!birthDate) {
    result.status = 'invalid / birth date could not be derived';
    result.loginReason = 'No login: existing national ID logic could not derive a plausible birth date.';
    result.warnings.push('Birth date could not be derived from the national ID using the existing rules.');
    return result;
  }

  result.birthDateFromNationalId = birthDate;
  result.status = 'valid';
  result.loginShouldBeEnabled = true;
  result.loginUsername = nationalId;
  result.defaultPassword = nationalId;
  result.loginReason = 'Login enabled: username is the national ID and default password is the national ID.';
  return result;
}

function mapConfessionFather(rawValue) {
  const original = normalizeWhitespace(rawValue);
  const normalizedParts = getComparableParts(original);
  const normalized = normalizedParts.join(' ');
  const compact = normalizeArabicForComparison(original).replace(/\s+/g, '');

  const noFatherValues = new Set([
    '',
    'لا',
    'لايوجد',
    'لايوجداباعتراف',
    'لايوجداباعتراف',
    'لايوجدابإعتراف',
    'لايوجداباعتراف',
    'غيرمعلوم',
    'لانعرف',
    'لابوجد',
    'لاسوجد',
  ]);

  if (!original || noFatherValues.has(compact)) {
    return {
      accountId: '',
      matchedResult: '',
      storage: 'null',
      warning: '',
    };
  }

  if (normalized === 'بيشوي' || normalized === 'بيشوي نجيب') {
    return {
      accountId: CONFESSION_FATHER_ACCOUNTS.beeshoy.accountId,
      matchedResult: CONFESSION_FATHER_ACCOUNTS.beeshoy.canonicalName,
      storage: 'linked_account',
      warning: '',
    };
  }

  if (normalized === 'بولا' || normalized === 'بولا عبد الملاك') {
    return {
      accountId: CONFESSION_FATHER_ACCOUNTS.bola.accountId,
      matchedResult: CONFESSION_FATHER_ACCOUNTS.bola.canonicalName,
      storage: 'linked_account',
      warning: '',
    };
  }

  return {
    accountId: '',
    matchedResult: original,
    storage: 'plain_text',
    warning: `Confession father "${original}" is not one of the two account-linked priests; it will remain plain text.`,
  };
}

function getEducationStage(value) {
  return EDUCATION_STAGE_VALUES.includes(value) ? value : '';
}

function normalizeSchoolYear(value) {
  const normalized = normalizeArabicForComparison(value).toLowerCase();
  if (!normalized) return { number: null, normalized };
  if (/kg\s*1|كي\s*جي\s*1|اولى\s*حضان|اولي\s*حضان/.test(normalized)) return { number: 1, normalized: 'kg1' };
  if (/kg\s*2|كي\s*جي\s*2|ثانيه\s*حضان|ثاني\s*حضان/.test(normalized)) return { number: 2, normalized: 'kg2' };
  if (/^(1|الاول|اول|الاولي|اولي|اولى)$/.test(normalized)) return { number: 1, normalized };
  if (/^(2|الثاني|ثاني|الثانيه|تاني|تانيه)$/.test(normalized)) return { number: 2, normalized };
  if (/^(3|الثالث|ثالث|الثالثه)$/.test(normalized)) return { number: 3, normalized };
  if (/^(4|الرابع|رابع|الرابعه)$/.test(normalized)) return { number: 4, normalized };
  if (/^(5|الخامس|خامس|الخامسه)$/.test(normalized)) return { number: 5, normalized };
  if (/^(6|السادس|سادس|السادسه)$/.test(normalized)) return { number: 6, normalized };
  return { number: null, normalized };
}

function mapEducation(rawEducation, rawSchoolYear) {
  const originalEducation = normalizeWhitespace(rawEducation);
  const originalSchoolYear = normalizeWhitespace(rawSchoolYear);
  const normalizedEducation = normalizeArabicForComparison(originalEducation);
  const compactEducation = normalizedEducation.replace(/\s+/g, '');
  const schoolYear = normalizeSchoolYear(originalSchoolYear);
  const warnings = [];
  let stage = '';
  let matchedYear = '';

  function setStage(value, yearLabel = '') {
    stage = getEducationStage(value);
    matchedYear = yearLabel;
    if (!stage) {
      warnings.push(`Internal education mapping "${value}" is not present in system options.`);
    }
  }

  if (!originalEducation) {
    return {
      matchedDisplay: '',
      matchedStage: '',
      matchedYear: '',
      warnings,
    };
  }

  if (/^\d+(\.\d+)?$/.test(originalEducation) || originalEducation.includes('@')) {
    warnings.push(`Education value "${originalEducation}" does not look like a supported education option.`);
    return {
      matchedDisplay: '',
      matchedStage: '',
      matchedYear: '',
      warnings,
    };
  }

  if (compactEducation === 'حضانه' || compactEducation.includes('رياضالاطفال')) {
    if (schoolYear.normalized === 'kg1') {
      setStage('kindergarten_kg1', 'KG1');
    } else if (schoolYear.normalized === 'kg2') {
      setStage('kindergarten_kg2', 'KG2');
    } else {
      setStage('kindergarten_unspecified_year', 'سنة غير محددة');
      if (originalSchoolYear && normalizeArabicForComparison(originalSchoolYear) !== 'تمهيدي') {
        warnings.push(`No exact kindergarten year match for "${originalSchoolYear}".`);
      } else if (normalizeArabicForComparison(originalSchoolYear) === 'تمهيدي') {
        warnings.push('School year "تمهيدي" has no exact system option; stage-level kindergarten was used.');
      }
    }
  } else if (compactEducation.includes('ابتدايي') || compactEducation.includes('ابتدائي')) {
    if (schoolYear.number && schoolYear.number >= 1 && schoolYear.number <= 6) {
      setStage(`primary_grade_${schoolYear.number}`, `الصف ${schoolYear.number}`);
    } else {
      setStage('primary_unspecified_year', 'سنة غير محددة');
      if (originalSchoolYear) warnings.push(`No exact primary grade match for "${originalSchoolYear}".`);
    }
  } else if (compactEducation.includes('اعدادي')) {
    if (schoolYear.number && schoolYear.number >= 1 && schoolYear.number <= 3) {
      setStage(`preparatory_grade_${schoolYear.number}`, `الصف ${schoolYear.number}`);
    } else {
      setStage('preparatory_unspecified_year', 'سنة غير محددة');
      if (originalSchoolYear) warnings.push(`No exact preparatory grade match for "${originalSchoolYear}".`);
    }
  } else if (compactEducation.includes('ثانوي')) {
    if (schoolYear.number && schoolYear.number >= 1 && schoolYear.number <= 3) {
      setStage(`secondary_general_year_${schoolYear.number}`, `السنة ${schoolYear.number}`);
    } else {
      setStage('secondary_unspecified_year', 'سنة غير محددة');
      if (originalSchoolYear) warnings.push(`No exact secondary year match for "${originalSchoolYear}".`);
    }
  } else if (compactEducation.includes('جامعه') || compactEducation.includes('جامعة')) {
    if (schoolYear.number && schoolYear.number >= 1 && schoolYear.number <= 5) {
      setStage(`university_year_${schoolYear.number}`, `السنة ${schoolYear.number}`);
    } else {
      setStage('university_unspecified_year', 'سنة غير محددة');
      if (originalSchoolYear) warnings.push(`No exact university year match for "${originalSchoolYear}".`);
    }
  } else if (compactEducation === 'غيرمتعلم') {
    setStage('uneducated');
  } else if (compactEducation === 'محواميه') {
    setStage('literacy');
  } else if (compactEducation === 'طالب') {
    setStage('student');
    if (originalSchoolYear) {
      warnings.push(`Education "طالب" is supported only as a generic option; school year "${originalSchoolYear}" was not applied.`);
    }
  } else if (compactEducation === 'خريج') {
    setStage('university_graduate');
  } else {
    warnings.push(`Education value "${originalEducation}" did not match an existing system education option.`);
  }

  return {
    matchedDisplay: EDUCATION_DISPLAY_LABELS[stage] || stage,
    matchedStage: stage,
    matchedYear,
    warnings,
  };
}

function getRowMapper(sheetName) {
  const normalizedSheetName = normalizeWhitespace(sheetName);

  if (normalizedSheetName === 'Sheet1') {
    return (row) => {
      const cells = row.cells || {};
      return {
        area: '',
        confessionFather: '',
        educationLevel: '',
        educationYear: '',
        fullName: cells.A,
        gender: cells.B,
        maritalStatus: cells.C,
        nationalId: cells.E || cells.D,
      };
    };
  }

  return (row) => {
    const cells = row.cells || {};
    return {
      area: cells.C,
      confessionFather: cells.N,
      educationLevel: cells.J,
      educationYear: cells.K,
      fullName: cells.D,
      gender: cells.E,
      maritalStatus: cells.F,
      nationalId: cells.G,
    };
  };
}

function analyzeReviewRow(row, sheetName, sequenceIndex) {
  const mapRow = getRowMapper(sheetName);
  const source = mapRow(row);
  const fullName = normalizeWhitespace(source.fullName);
  const originalParts = getOriginalParts(fullName);
  const nameParts = getComparableParts(fullName);
  const gender = mapGender(source.gender);
  const marital = normalizeMaritalStatus(source.maritalStatus);
  const nationalId = evaluateNationalId(source.nationalId);
  const confessionFather = mapConfessionFather(source.confessionFather);
  const education = mapEducation(source.educationLevel, source.educationYear);
  const warnings = [];

  if (!fullName) {
    warnings.push('Skipped: no person name was found in this row.');
  } else if (nameParts.length < 2) {
    warnings.push('Name has fewer than two comparable parts; relationship inference will be weak.');
  }

  if (gender.warning) warnings.push(gender.warning);
  warnings.push(...nationalId.warnings);
  if (confessionFather.warning) warnings.push(confessionFather.warning);
  warnings.push(...education.warnings);

  return {
    area: normalizeWhitespace(source.area),
    birthDateFromNationalId: nationalId.birthDateFromNationalId,
    children: [],
    comparableFamilyKey: getFamilyKeyFromParts(nameParts),
    confidenceLevels: [],
    confessionFather,
    education,
    familyName: '',
    father: null,
    fullName,
    gender: gender.value,
    genderLabel: gender.label || normalizeWhitespace(source.gender),
    headOfHouse: null,
    houseName: '',
    id: `row-${row.rowNumber}`,
    isPerson: Boolean(fullName),
    marital,
    mother: null,
    nameParts,
    nationalId,
    originalParts,
    rawCells: { ...(row.cells || {}) },
    relationReasons: [],
    reverseRelationNotes: [],
    rowNumber: row.rowNumber,
    sequenceIndex,
    siblings: [],
    source,
    spouse: null,
    suggestedTags: [...nationalId.suggestedTags],
    warnings,
  };
}

function personLabel(person) {
  return person ? `${person.fullName} (row ${person.rowNumber})` : '';
}

function isMale(person) {
  return person?.gender === 'male';
}

function isFemale(person) {
  return person?.gender === 'female';
}

function isLikelyHead(person) {
  return isMale(person) && (person.marital.isMarried || person.marital.isWidowed);
}

function matchesChildOf(child, father) {
  if (!child || !father) return false;
  if (child.nameParts.length < 3 || father.nameParts.length < 2) return false;
  return child.nameParts[1] === father.nameParts[0] && child.nameParts[2] === father.nameParts[1];
}

function addUniquePerson(list, person) {
  if (!person || list.some((entry) => entry.rowNumber === person.rowNumber)) return;
  list.push(person);
}

function addReason(person, confidence, reason) {
  if (!person || !reason) return;
  person.confidenceLevels.push(confidence);
  person.relationReasons.push(reason);
}

function setSingleRelation(person, field, target, confidence, reason) {
  if (!person || !target) return false;
  if (person[field] && person[field].rowNumber !== target.rowNumber) {
    person.warnings.push(
      `Ambiguous ${field}: already inferred ${personLabel(person[field])}, also found ${personLabel(target)}.`
    );
    person.confidenceLevels.push('ambiguous');
    return false;
  }

  person[field] = target;
  addReason(person, confidence, reason);
  return true;
}

function getRelationRole(label) {
  return RELATION_LABEL_BY_KEY[label] ? label : label;
}

function childRoleFor(person) {
  return isFemale(person) ? getRelationRole('البنت') : getRelationRole('الابن');
}

function siblingRoleFor(person) {
  return isFemale(person) ? getRelationRole('الأخت') : getRelationRole('الأخ');
}

function spouseRoleFor(person) {
  return isFemale(person) ? getRelationRole('الزوجة') : getRelationRole('الزوج');
}

function assignHousehold(person, household, confidence, reason, { asHead = false } = {}) {
  if (!person || !household) return;

  if (!person.houseName || asHead) person.houseName = household.houseName;
  if (!person.familyName || asHead) person.familyName = household.familyName;
  if (!person.headOfHouse || asHead) person.headOfHouse = household.head;
  addReason(person, confidence, reason);
}

function buildRelationEdge({
  confidence,
  reason,
  reverseField,
  reverseRelationRole,
  source,
  sourceField,
  sourceRelationRole,
  target,
}) {
  return {
    confidence,
    reason,
    reverseField,
    reverseRelationRole,
    source,
    sourceField,
    sourceRelationRole,
    target,
  };
}

function connectSpouses(husband, wife, relationEdges, confidence, reason) {
  if (!husband || !wife) return;
  const husbandReason = `${personLabel(wife)} inferred as spouse: ${reason}`;
  const wifeReason = `${personLabel(husband)} inferred as spouse: ${reason}`;
  setSingleRelation(husband, 'spouse', wife, confidence, husbandReason);
  setSingleRelation(wife, 'spouse', husband, confidence, wifeReason);
  husband.reverseRelationNotes.push(`Prepared reverse spouse relation from ${personLabel(wife)}.`);
  wife.reverseRelationNotes.push(`Prepared reverse spouse relation from ${personLabel(husband)}.`);
  relationEdges.push(buildRelationEdge({
    confidence,
    reason,
    reverseField: 'spouse',
    reverseRelationRole: getRelationRole('الزوج'),
    source: husband,
    sourceField: 'spouse',
    sourceRelationRole: getRelationRole('الزوجة'),
    target: wife,
  }));
}

function connectParentChild(parent, child, parentKind, relationEdges, confidence, reason) {
  if (!parent || !child) return;

  const childField = parentKind === 'mother' ? 'mother' : 'father';
  const parentRole = parentKind === 'mother' ? getRelationRole('الأم') : getRelationRole('الأب');
  const childReason = `${personLabel(parent)} inferred as ${childField}: ${reason}`;
  if (setSingleRelation(child, childField, parent, confidence, childReason)) {
    addUniquePerson(parent.children, child);
    addReason(parent, confidence, `${personLabel(child)} inferred as child: ${reason}`);
    child.reverseRelationNotes.push(`Prepared reverse child relation on ${personLabel(parent)}.`);
    parent.reverseRelationNotes.push(`Prepared reverse ${childField} relation on ${personLabel(child)}.`);
    relationEdges.push(buildRelationEdge({
      confidence,
      reason,
      reverseField: 'children',
      reverseRelationRole: childRoleFor(child),
      source: child,
      sourceField: childField,
      sourceRelationRole: parentRole,
      target: parent,
    }));
  }
}

function connectSiblings(first, second, relationEdges, confidence, reason) {
  if (!first || !second || first.rowNumber === second.rowNumber) return;
  addUniquePerson(first.siblings, second);
  addUniquePerson(second.siblings, first);
  addReason(first, confidence, `${personLabel(second)} inferred as sibling: ${reason}`);
  addReason(second, confidence, `${personLabel(first)} inferred as sibling: ${reason}`);
  first.reverseRelationNotes.push(`Prepared reverse sibling relation from ${personLabel(second)}.`);
  second.reverseRelationNotes.push(`Prepared reverse sibling relation from ${personLabel(first)}.`);
  relationEdges.push(buildRelationEdge({
    confidence,
    reason,
    reverseField: 'siblings',
    reverseRelationRole: siblingRoleFor(first),
    source: first,
    sourceField: 'siblings',
    sourceRelationRole: siblingRoleFor(second),
    target: second,
  }));
}

function inferFamilyRelationships(people) {
  const relationEdges = [];
  const householdByHeadRow = new Map();
  const familyNameByKey = new Map();
  let householdCounter = 0;
  let activeHouseholds = [];
  let previousPerson = null;

  function createHousehold(head, parentHousehold, confidence, reason) {
    if (householdByHeadRow.has(head.rowNumber)) {
      return householdByHeadRow.get(head.rowNumber);
    }

    const originalHouseName = getHouseNameFromParts(head.originalParts);
    const comparableFamilyKey = getFamilyKeyFromParts(head.nameParts);
    const ownFamilyName = getFamilyNameFromParts(head.originalParts);
    const inheritedFamilyName = parentHousehold?.familyName || '';
    const familyName = inheritedFamilyName || familyNameByKey.get(comparableFamilyKey) || ownFamilyName;

    if (comparableFamilyKey && familyName) {
      familyNameByKey.set(comparableFamilyKey, familyName);
    }

    const household = {
      children: [],
      familyKey: comparableFamilyKey,
      familyName,
      head,
      houseName: originalHouseName,
      id: `house-${householdCounter += 1}`,
      parentHousehold: parentHousehold || null,
      spouse: null,
    };

    householdByHeadRow.set(head.rowNumber, household);
    if (parentHousehold) {
      const parentIndex = activeHouseholds.findIndex((entry) => entry.id === parentHousehold.id);
      activeHouseholds = parentIndex >= 0
        ? [...activeHouseholds.slice(0, parentIndex + 1), household]
        : [...activeHouseholds, household];
    } else {
      activeHouseholds = [household];
    }

    assignHousehold(head, household, confidence, reason, { asHead: true });
    return household;
  }

  function findMatchingHouseholdForChild(person) {
    for (let index = activeHouseholds.length - 1; index >= 0; index -= 1) {
      const household = activeHouseholds[index];
      if (matchesChildOf(person, household.head)) {
        activeHouseholds = activeHouseholds.slice(0, index + 1);
        return household;
      }
    }
    return null;
  }

  for (const person of people) {
    if (!person.isPerson) continue;

    let matchedHousehold = findMatchingHouseholdForChild(person);
    let spouseLinked = false;
    const previousHousehold = previousPerson ? householdByHeadRow.get(previousPerson.rowNumber) : null;

    if (
      previousPerson
      && isFemale(person)
      && person.marital.isMarried
      && isMale(previousPerson)
      && previousPerson.marital.isMarried
      && !previousPerson.spouse
      && !matchesChildOf(person, previousPerson)
    ) {
      const husbandHousehold = previousHousehold
        || createHousehold(
          previousPerson,
          null,
          'medium',
          'Male married person was directly followed by a married female; created household for spouse inference.'
        );

      householdByHeadRow.set(previousPerson.rowNumber, husbandHousehold);
      husbandHousehold.spouse = person;
      connectSpouses(
        previousPerson,
        person,
        relationEdges,
        'medium',
        'married female appears directly below a married male in the ordered workbook'
      );
      assignHousehold(
        person,
        husbandHousehold,
        'medium',
        `Assigned to ${personLabel(previousPerson)} household because she was inferred as his wife.`
      );
      spouseLinked = true;
      matchedHousehold = null;
    }

    if (!spouseLinked && matchedHousehold) {
      connectParentChild(
        matchedHousehold.head,
        person,
        'father',
        relationEdges,
        'high',
        `child name parts match father pattern: ${person.nameParts[1]} ${person.nameParts[2]} = ${matchedHousehold.head.nameParts[0]} ${matchedHousehold.head.nameParts[1]}`
      );
      if (matchedHousehold.spouse) {
        connectParentChild(
          matchedHousehold.spouse,
          person,
          'mother',
          relationEdges,
          'medium',
          'mother inferred because she is the inferred spouse in the same ordered household block'
        );
      }
      for (const sibling of matchedHousehold.children) {
        connectSiblings(
          sibling,
          person,
          relationEdges,
          'high',
          `both children matched ${personLabel(matchedHousehold.head)} by father-name pattern`
        );
      }
      addUniquePerson(matchedHousehold.children, person);
      assignHousehold(
        person,
        matchedHousehold,
        'high',
        `Assigned to ${personLabel(matchedHousehold.head)} household by father-name pattern.`
      );
    }

    if (isLikelyHead(person)) {
      const parentHousehold = !spouseLinked && matchedHousehold ? matchedHousehold : null;
      const confidence = parentHousehold ? 'medium' : 'medium';
      const reason = parentHousehold
        ? `Nested household: ${personLabel(person)} is also a child in ${personLabel(parentHousehold.head)} household and is married/widowed.`
        : `Head of house inferred because ${personLabel(person)} is male and ${person.marital.original || 'married/widowed'} in the ordered list.`;
      createHousehold(person, parentHousehold, confidence, reason);
    }

    if (!person.houseName) {
      person.houseName = getHouseNameFromParts(person.originalParts);
      person.familyName = getFamilyNameFromParts(person.originalParts);
      person.headOfHouse = person;
      person.confidenceLevels.push('low');
      person.relationReasons.push('No ordered household relation was found; fallback house/family names were derived from this person name parts.');
      person.warnings.push('No confident household block relation was found; review fallback house/family inference.');
    }

    previousPerson = person;
  }

  return relationEdges;
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

function ensureOutputPath(customOutputPath) {
  if (customOutputPath) {
    const resolved = path.resolve(customOutputPath);
    return path.extname(resolved).toLowerCase() === '.xlsx'
      ? resolved
      : `${resolved}.xlsx`;
  }

  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join(REPORT_DIR, `users-import-review-${timestamp}.xlsx`);
}

function ensureJsonReportPath(customReportPath, prefix) {
  if (customReportPath) {
    const resolved = path.resolve(customReportPath);
    return path.extname(resolved).toLowerCase() === '.json'
      ? resolved
      : `${resolved}.json`;
  }

  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join(REPORT_DIR, `${prefix}-${timestamp}.json`);
}

function getConfidenceSummary(person) {
  const order = ['ambiguous', 'low', 'medium', 'high'];
  const values = [...new Set(person.confidenceLevels.filter(Boolean))];
  if (!values.length) return '';
  return order.filter((value) => values.includes(value)).join(' / ');
}

function joinPeople(people) {
  return (people || []).map(personLabel).join(' | ');
}

function buildReviewRows(people) {
  const headers = [
    'original_row_number',
    'original_name',
    'normalized_name_for_matching',
    'gender',
    'marital_status',
    'area',
    'original_confession_father',
    'matched_confession_father_result',
    'confession_father_storage',
    'confession_father_account_id',
    'national_id',
    'national_id_status',
    'birth_date_from_national_id',
    'login_should_be_enabled',
    'login_username',
    'default_password',
    'login_decision_reason',
    'suggested_tags',
    'original_education_value',
    'matched_education_value',
    'matched_education_display',
    'original_school_year_value',
    'matched_school_year_or_grade',
    'inferred_house_name',
    'inferred_family_name',
    'inferred_head_of_house',
    'inferred_spouse',
    'inferred_father',
    'inferred_mother',
    'inferred_children',
    'inferred_siblings',
    'relation_confidence',
    'relation_reasons',
    'reverse_relations_prepared',
    'warnings_needs_review',
  ];

  const rows = people
    .filter((person) => person.isPerson)
    .map((person) => [
      person.rowNumber,
      person.fullName,
      person.nameParts.join(' '),
      person.genderLabel,
      person.marital.original,
      person.area,
      normalizeWhitespace(person.source.confessionFather),
      person.confessionFather.matchedResult,
      person.confessionFather.storage,
      person.confessionFather.accountId,
      person.nationalId.nationalId,
      person.nationalId.status,
      person.birthDateFromNationalId,
      person.nationalId.loginShouldBeEnabled ? 'yes' : 'no',
      person.nationalId.loginUsername,
      person.nationalId.defaultPassword,
      person.nationalId.loginReason,
      person.suggestedTags.join(' | '),
      normalizeWhitespace(person.source.educationLevel),
      person.education.matchedStage,
      person.education.matchedDisplay,
      normalizeWhitespace(person.source.educationYear),
      person.education.matchedYear,
      person.houseName,
      person.familyName,
      personLabel(person.headOfHouse),
      personLabel(person.spouse),
      personLabel(person.father),
      personLabel(person.mother),
      joinPeople(person.children),
      joinPeople(person.siblings),
      getConfidenceSummary(person),
      person.relationReasons.join(' | '),
      person.reverseRelationNotes.join(' | '),
      person.warnings.join(' | '),
    ]);

  return [headers, ...rows];
}

function buildRelationsRows(relationEdges) {
  const headers = [
    'source_row',
    'source_name',
    'source_relation_field',
    'source_relation_role',
    'target_row',
    'target_name',
    'reverse_relation_field_prepared',
    'reverse_relation_role_prepared',
    'confidence',
    'reason',
  ];

  const rows = relationEdges.map((edge) => [
    edge.source.rowNumber,
    edge.source.fullName,
    edge.sourceField,
    edge.sourceRelationRole,
    edge.target.rowNumber,
    edge.target.fullName,
    edge.reverseField,
    edge.reverseRelationRole,
    edge.confidence,
    edge.reason,
  ]);

  return [headers, ...rows];
}

function buildWarningsRows(people) {
  const headers = ['row_number', 'name', 'warnings_needs_review'];
  const rows = people
    .filter((person) => person.isPerson && person.warnings.length > 0)
    .map((person) => [person.rowNumber, person.fullName, person.warnings.join(' | ')]);
  return [headers, ...rows];
}

function buildSummaryRows({ limitedRows, outputPath, people, relationEdges, sheetName, workbookPath }) {
  const exact14ZeroNationalIdCount = people.filter((person) => person.nationalId.nationalId === ALL_ZERO_NATIONAL_ID).length;
  const allZeroLikeNationalIdCount = people.filter((person) => {
    const nationalId = person.nationalId.nationalId;
    return Boolean(nationalId) && /^0+$/.test(nationalId);
  }).length;
  const missingNationalIdCount = people.filter((person) => !person.nationalId.nationalId).length;
  const peopleNeedingActionTagCount = people.filter((person) => person.suggestedTags.includes(ACTION_REQUIRED_TAG)).length;
  const loginEnabledCount = people.filter((person) => person.nationalId.loginShouldBeEnabled).length;
  const duplicateNationalIdCount = people.filter((person) => person.nationalId.duplicate).length;
  const invalidNationalIdCount = people.filter((person) => (
    person.nationalId.status.startsWith('invalid')
    && person.nationalId.nationalId !== ALL_ZERO_NATIONAL_ID
    && !person.nationalId.duplicate
  )).length;
  const plainTextConfessionFathers = people.filter((person) => person.confessionFather.storage === 'plain_text').length;
  const educationMismatches = people.filter((person) => person.education.warnings.length > 0).length;
  const ambiguousRelations = people.filter((person) => (
    person.confidenceLevels.includes('ambiguous')
    || person.confidenceLevels.includes('low')
    || person.warnings.some((warning) => warning.toLowerCase().includes('ambiguous'))
  )).length;
  const spouseRelations = relationEdges.filter((edge) => edge.sourceField === 'spouse').length;
  const parentChildRelations = relationEdges.filter((edge) => edge.sourceField === 'father' || edge.sourceField === 'mother').length;

  return [
    ['metric', 'value'],
    ['generated_at', new Date().toISOString()],
    ['source_workbook', workbookPath],
    ['source_sheet', sheetName],
    ['review_workbook', outputPath],
    ['database_writes_executed', 0],
    ['rows_read_for_review', limitedRows.length],
    ['total_people', people.length],
    ['people_with_login_enabled', loginEnabledCount],
    ['people_without_login', people.length - loginEnabledCount],
    ['valid_national_id', people.filter((person) => person.nationalId.status === 'valid').length],
    ['exact_14_zero_national_id', exact14ZeroNationalIdCount],
    ['all_zero_like_national_id', allZeroLikeNationalIdCount],
    ['missing_national_id', missingNationalIdCount],
    ['invalid_national_id_excluding_all_zero_and_duplicates', invalidNationalIdCount],
    ['duplicate_national_id_people', duplicateNationalIdCount],
    ['people_needing_action_tag', peopleNeedingActionTagCount],
    ['inferred_spouse_relations', spouseRelations],
    ['inferred_parent_child_relations', parentChildRelations],
    ['ambiguous_relations', ambiguousRelations],
    ['unknown_confession_fathers_plain_text', plainTextConfessionFathers],
    ['education_mismatches_or_grade_warnings', educationMismatches],
  ];
}

function xmlEscape(value) {
  return String(value ?? '')
    .slice(0, 32000)
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
  <sheetViews><sheetView workbookViewId="0" rightToLeft="1"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
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
  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
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

function buildCoreXml() {
  const now = new Date().toISOString();
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:title>Church users import review</dc:title>
  <dc:creator>importUsersFromExcel.js</dc:creator>
  <cp:lastModifiedBy>importUsersFromExcel.js</cp:lastModifiedBy>
  <dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created>
  <dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified>
</cp:coreProperties>`;
}

function buildAppXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">
  <Application>Node.js</Application>
</Properties>`;
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

function markDuplicateNationalIds(people) {
  const firstSeenByNationalId = new Map();
  const duplicatedPeople = new Map();

  for (const person of people) {
    const nationalId = person.nationalId.nationalId;
    if (!nationalId || /^0+$/.test(nationalId)) continue;
    const firstSeen = firstSeenByNationalId.get(nationalId);
    if (firstSeen) {
      if (!duplicatedPeople.has(nationalId)) {
        duplicatedPeople.set(nationalId, [firstSeen]);
      }
      duplicatedPeople.get(nationalId).push(person);
      person.warnings.push(`Duplicate national ID in workbook; first seen at row ${firstSeen.rowNumber}.`);
      firstSeen.warnings.push(`Duplicate national ID in workbook; also seen at row ${person.rowNumber}.`);
      continue;
    }
    firstSeenByNationalId.set(nationalId, person);
  }

  for (const [nationalId, duplicates] of duplicatedPeople.entries()) {
    const rowNumbers = duplicates.map((person) => person.rowNumber).join(', ');
    for (const person of duplicates) {
      person.nationalId.duplicate = true;
      person.nationalId.loginShouldBeEnabled = false;
      person.nationalId.loginUsername = '';
      person.nationalId.defaultPassword = '';
      person.nationalId.status =
        person.nationalId.status === 'valid'
          ? 'valid / duplicate / needs review'
          : `${person.nationalId.status} / duplicate / needs review`;
      person.nationalId.loginReason =
        `No login: national ID ${nationalId} is duplicated in workbook rows ${rowNumbers}, so it cannot safely be used as a username.`;
      person.warnings.push(
        `Login disabled because national ID ${nationalId} is duplicated in workbook rows ${rowNumbers}.`
      );
    }
  }
}

function buildAnalyzedImportData({ limitedRows, sheetName }) {
  const analyzedRows = limitedRows.map((row, index) => analyzeReviewRow(row, sheetName, index));
  const people = analyzedRows.filter((row) => row.isPerson);
  markDuplicateNationalIds(people);
  const relationEdges = inferFamilyRelationships(people);
  return { analyzedRows, people, relationEdges };
}

function getImportSourceKey(workbookPath, sheetName, rowNumber) {
  return `${path.basename(workbookPath)}::${sheetName}::row-${rowNumber}`;
}

function buildImportWarnings(person) {
  return [...new Set([
    ...person.warnings,
    ...person.education.warnings,
  ].map((warning) => normalizeWhitespace(warning)).filter(Boolean))];
}

function buildUserPayloadForImport({ person, workbookPath, sheetName, reviewFile }) {
  const warnings = buildImportWarnings(person);
  const nationalId = person.nationalId.nationalId;
  const sourceKey = getImportSourceKey(workbookPath, sheetName, person.rowNumber);
  let defaultPasswordInput = null;
  const customDetails = {
    importArea: person.area || '',
    importEducationLevel: normalizeWhitespace(person.source.educationLevel),
    importEducationYear: normalizeWhitespace(person.source.educationYear),
    importLoginDecision: person.nationalId.loginReason || '',
    importMaritalStatus: person.marital.original || '',
    importNationalIdStatus: person.nationalId.status || '',
    importOriginalNationalId: nationalId || '',
    importRelationConfidence: getConfidenceSummary(person),
    importReviewWorkbook: reviewFile ? path.basename(reviewFile) : '',
    importSheet: sheetName,
    importSourceKey: sourceKey,
    importSourceWorkbook: path.basename(workbookPath),
    importRowNumber: String(person.rowNumber),
    importWarnings: warnings.join(' | '),
  };

  const payload = {
    accountStatus: ACCOUNT_STATUSES.APPROVED,
    customDetails,
    familyName: person.familyName || undefined,
    fullName: person.fullName,
    gender: person.gender || undefined,
    hasLogin: false,
    houseName: person.houseName || undefined,
    role: ROLES.USER,
    tags: person.suggestedTags.length ? person.suggestedTags : undefined,
  };

  if (person.birthDateFromNationalId) {
    payload.birthDate = new Date(`${person.birthDateFromNationalId}T00:00:00.000Z`);
  }

  if (person.education.matchedStage) {
    payload.education = { stage: person.education.matchedStage };
  }

  if (person.confessionFather.storage === 'linked_account') {
    payload.confessionFatherName = person.confessionFather.matchedResult;
    payload.confessionFatherUserId = person.confessionFather.accountId;
  } else if (person.confessionFather.storage === 'plain_text') {
    payload.confessionFatherName = person.confessionFather.matchedResult;
  }

  if (person.nationalId.loginShouldBeEnabled) {
    payload.hasLogin = true;
    payload.loginIdentifierType = 'nationalId';
    payload.nationalId = nationalId;
    defaultPasswordInput = nationalId;
  }

  cleanupOptionalUniqueFields(payload);

  Object.keys(payload).forEach((key) => {
    if (payload[key] === undefined) delete payload[key];
  });

  return { defaultPasswordInput, payload, sourceKey, warnings };
}

function cleanupOptionalUniqueFields(payload) {
  for (const field of OPTIONAL_UNIQUE_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(payload, field)) continue;
    const value = payload[field];
    if (value == null) {
      delete payload[field];
      continue;
    }
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (!trimmed) {
        delete payload[field];
      } else {
        payload[field] = trimmed;
      }
    }
  }
  return payload;
}

function compactUserForReport(user) {
  if (!user) return null;
  return {
    id: String(user._id || user.id || ''),
    fullName: user.fullName || '',
    nationalId: user.nationalId || '',
    phonePrimary: user.phonePrimary || '',
    importSourceKey: user.customDetails?.importSourceKey || '',
  };
}

function serializeValidationErrors(error) {
  if (!error?.errors || typeof error.errors !== 'object') return [];
  return Object.entries(error.errors).map(([pathName, detail]) => ({
    kind: detail?.kind || '',
    message: detail?.message || '',
    path: pathName,
    value: detail?.value,
  }));
}

function buildErrorDiagnostics(error, context = {}) {
  const record = context.record || null;
  const person = record?.person || context.person || null;
  return {
    code: error?.code ?? null,
    errorMessage: error?.message || String(error),
    errorName: error?.name || 'Error',
    keyPattern: error?.keyPattern || null,
    keyValue: error?.keyValue || null,
    loginEnabled: record?.payload ? Boolean(record.payload.hasLogin) : null,
    nationalId: record?.payload?.nationalId || person?.nationalId?.nationalId || '',
    nationalIdStatus: person?.nationalId?.status || '',
    operation: context.operation || 'unknown',
    personName: person?.fullName || context.personName || '',
    relation: context.relation || null,
    rowNumber: person?.rowNumber || context.rowNumber || null,
    validationErrors: serializeValidationErrors(error),
  };
}

function formatErrorDiagnostics(diagnostics) {
  if (!diagnostics) return '';
  return [
    diagnostics.stage ? `stage=${diagnostics.stage}` : '',
    diagnostics.batchNumber ? `batch=${diagnostics.batchNumber}` : '',
    diagnostics.rowRange ? `rowRange=${diagnostics.rowRange}` : '',
    diagnostics.lastSuccessfulRow ? `lastSuccessfulRow=${diagnostics.lastSuccessfulRow}` : '',
    diagnostics.lastSuccessfulPerson ? `lastSuccessfulPerson=${diagnostics.lastSuccessfulPerson}` : '',
    `operation=${diagnostics.operation}`,
    diagnostics.rowNumber ? `row=${diagnostics.rowNumber}` : '',
    diagnostics.personName ? `person=${diagnostics.personName}` : '',
    diagnostics.nationalIdStatus ? `nationalIdStatus=${diagnostics.nationalIdStatus}` : '',
    diagnostics.loginEnabled !== null ? `loginEnabled=${diagnostics.loginEnabled}` : '',
    `errorName=${diagnostics.errorName}`,
    diagnostics.code !== null ? `code=${diagnostics.code}` : '',
    `message=${diagnostics.errorMessage}`,
    diagnostics.keyPattern ? `keyPattern=${JSON.stringify(diagnostics.keyPattern)}` : '',
    diagnostics.keyValue ? `keyValue=${JSON.stringify(diagnostics.keyValue)}` : '',
    diagnostics.validationErrors?.length
      ? `validationErrors=${JSON.stringify(diagnostics.validationErrors)}`
      : '',
    diagnostics.relation ? `relation=${JSON.stringify(diagnostics.relation)}` : '',
  ].filter(Boolean).join(' | ');
}

function wrapImportError(error, context) {
  if (error?.importDiagnostics) return error;
  const diagnostics = buildErrorDiagnostics(error, context);
  const wrapped = new Error(formatErrorDiagnostics(diagnostics));
  wrapped.cause = error;
  wrapped.importDiagnostics = diagnostics;
  return wrapped;
}

async function validateReviewedWorkbook(reviewFile) {
  const reviewPath = path.resolve(reviewFile);
  if (!fs.existsSync(reviewPath)) {
    throw new Error(`Review workbook was not found: ${reviewPath}`);
  }

  const summary = loadWorkbookRows(reviewPath, 'Summary');
  const rows = Array.isArray(summary.rows) ? summary.rows : [];
  const metrics = new Map(
    rows.map((row) => [normalizeWhitespace(row.cells?.A), normalizeWhitespace(row.cells?.B)])
  );

  if (metrics.get('database_writes_executed') !== '0') {
    throw new Error('Review workbook Summary must contain database_writes_executed = 0.');
  }

  return {
    path: reviewPath,
    metrics: Object.fromEntries(metrics.entries()),
  };
}

function buildExistingUserQuery({ sourceKeys, loginNationalIds }) {
  const orConditions = [];
  if (sourceKeys.length) {
    orConditions.push({ 'customDetails.importSourceKey': { $in: sourceKeys } });
  }
  if (loginNationalIds.length) {
    orConditions.push({ nationalId: { $in: loginNationalIds } });
    orConditions.push({ phonePrimary: { $in: loginNationalIds } });
  }
  return orConditions.length ? { $or: orConditions, includeDeleted: true } : null;
}

async function buildImportPlan({ people, relationEdges, reviewFile, sheetName, workbookPath }) {
  const preparedRecords = people.map((person) => ({
    person,
    ...buildUserPayloadForImport({ person, workbookPath, sheetName, reviewFile }),
  }));

  const sourceKeys = [...new Set(preparedRecords.map((record) => record.sourceKey))];
  const loginNationalIds = [...new Set(
    preparedRecords
      .filter((record) => record.person.nationalId.loginShouldBeEnabled)
      .map((record) => record.person.nationalId.nationalId)
      .filter(Boolean)
  )];

  const existingQuery = buildExistingUserQuery({ sourceKeys, loginNationalIds });
  const existingUsers = existingQuery
    ? await User.find(existingQuery)
      .select('_id fullName nationalId phonePrimary customDetails father mother spouse siblings children')
      .lean()
    : [];

  const existingBySourceKey = new Map();
  const existingByNationalId = new Map();
  const existingByPhonePrimary = new Map();
  for (const user of existingUsers) {
    const sourceKey = normalizeWhitespace(user.customDetails?.importSourceKey);
    if (sourceKey) existingBySourceKey.set(sourceKey, user);
    if (user.nationalId) existingByNationalId.set(normalizeNationalId(user.nationalId), user);
    if (user.phonePrimary) existingByPhonePrimary.set(normalizeNationalId(user.phonePrimary), user);
  }

  const records = preparedRecords.map((record) => {
    const existingSourceUser = existingBySourceKey.get(record.sourceKey);
    if (existingSourceUser) {
      return {
        ...record,
        existingUser: existingSourceUser,
        status: 'existing_source',
        statusReason: `Already imported from source row ${record.person.rowNumber}.`,
      };
    }

    const loginNationalId = record.person.nationalId.loginShouldBeEnabled
      ? record.person.nationalId.nationalId
      : '';
    const existingLoginUser =
      (loginNationalId && existingByNationalId.get(loginNationalId))
      || (loginNationalId && existingByPhonePrimary.get(loginNationalId))
      || null;

    if (existingLoginUser) {
      return {
        ...record,
        existingUser: existingLoginUser,
        status: 'skip_existing_conflict',
        statusReason: `Existing user already uses national ID/login identifier ${loginNationalId}.`,
      };
    }

    return {
      ...record,
      existingUser: null,
      status: 'create',
      statusReason: 'Ready to create.',
    };
  });

  const recordByRowNumber = new Map(records.map((record) => [record.person.rowNumber, record]));
  const plannedRelationEdges = relationEdges.filter((edge) => {
    const sourceRecord = recordByRowNumber.get(edge.source.rowNumber);
    const targetRecord = recordByRowNumber.get(edge.target.rowNumber);
    return sourceRecord
      && targetRecord
      && sourceRecord.status !== 'skip_existing_conflict'
      && targetRecord.status !== 'skip_existing_conflict';
  });
  const skippedRelationEdges = relationEdges.filter((edge) => !plannedRelationEdges.includes(edge));

  return {
    existingUsers,
    plannedRelationEdges,
    records,
    skippedRelationEdges,
  };
}

function relationMember(targetPerson, relationRole, idByRowNumber) {
  const targetId = idByRowNumber.get(targetPerson?.rowNumber);
  if (!targetPerson || !targetId) return null;
  return {
    userId: targetId,
    name: targetPerson.fullName,
    relationRole,
  };
}

function buildRelationPayload(person, idByRowNumber) {
  const payload = {};
  const father = relationMember(person.father, getRelationRole('الأب'), idByRowNumber);
  const mother = relationMember(person.mother, getRelationRole('الأم'), idByRowNumber);
  const spouse = relationMember(
    person.spouse,
    person.spouse ? spouseRoleFor(person.spouse) : '',
    idByRowNumber
  );
  const siblings = person.siblings
    .map((sibling) => relationMember(sibling, siblingRoleFor(sibling), idByRowNumber))
    .filter(Boolean);
  const children = person.children
    .map((child) => relationMember(child, childRoleFor(child), idByRowNumber))
    .filter(Boolean);

  if (father) payload.father = father;
  if (mother) payload.mother = mother;
  if (spouse) payload.spouse = spouse;
  if (siblings.length) payload.siblings = siblings;
  if (children.length) payload.children = children;

  return payload;
}

function countRelationPayloadEntries(payload) {
  return [
    payload.father ? 1 : 0,
    payload.mother ? 1 : 0,
    payload.spouse ? 1 : 0,
    Array.isArray(payload.siblings) ? payload.siblings.length : 0,
    Array.isArray(payload.children) ? payload.children.length : 0,
  ].reduce((sum, count) => sum + count, 0);
}

function isUnsupportedTransactionError(error) {
  const message = String(error?.message || '');
  return /Transaction numbers are only allowed|replica set member or mongos|transactions are not supported/i.test(message);
}

async function preparePasswordHashesForPlan(plan, { limitUsers = null, progressEvery = DEFAULT_IMPORT_BATCH_SIZE, startedAt = Date.now() } = {}) {
  const records = plan.records.filter((record) => (
    record.status === 'create'
    && record.payload.hasLogin
    && record.defaultPasswordInput
    && !record.preparedPasswordHash
  )).slice(0, limitUsers || undefined);

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    const salt = await bcrypt.genSalt(12);
    record.preparedPasswordHash = await bcrypt.hash(record.defaultPasswordInput, salt);
    const processed = index + 1;
    if (processed === records.length || processed % progressEvery === 0) {
      logProgress(
        'hashing',
        `${processed}/${records.length} passwords prepared; last row ${record.person.rowNumber}; last person ${record.person.fullName}`,
        startedAt
      );
    }
  }

  return records.length;
}

async function runBatchWithOptionalTransaction(useTransaction, operation) {
  if (!useTransaction) {
    return operation(null);
  }

  const session = await mongoose.startSession();
  try {
    return await session.withTransaction(async () => operation(session));
  } catch (error) {
    if (isUnsupportedTransactionError(error)) {
      throw new Error(
        'MongoDB transactions are not available for this connection. Re-run only after taking a backup, adding --allow-non-transactional, and accepting idempotent/resumable behavior.'
      );
    }
    throw error;
  } finally {
    await session.endSession();
  }
}

async function findExistingRecordDuringImport(record, session) {
  const orConditions = [{ 'customDetails.importSourceKey': record.sourceKey }];
  if (record.payload.nationalId) {
    orConditions.push({ nationalId: record.payload.nationalId });
  }

  return User.findOne({ $or: orConditions, includeDeleted: true })
    .select('_id fullName nationalId phonePrimary customDetails father mother spouse siblings children')
    .session(session || null)
    .lean();
}

function selectRelationRecords(plan, idByRowNumber, { allowExistingSourceRelationFill, limitRelations }) {
  const selected = [];
  let selectedRelationCount = 0;

  for (const record of plan.records.filter((entry) => (
    entry.status === 'create' || (allowExistingSourceRelationFill && entry.status === 'existing_source')
  ))) {
    const userId = idByRowNumber.get(record.person.rowNumber);
    if (!userId) continue;

    const relationPayload = buildRelationPayload(record.person, idByRowNumber);
    const relationCount = countRelationPayloadEntries(relationPayload);
    if (!relationCount) continue;

    if (limitRelations && selectedRelationCount >= limitRelations) break;
    selected.push({ record, relationCount, relationPayload, userId });
    selectedRelationCount += relationCount;
  }

  return { selected, selectedRelationCount };
}

async function executeImportWrites(plan, {
  allowExistingSourceRelationFill = true,
  allowNonTransactional = false,
  limitRelations = null,
  limitUsers = null,
  relationBatchSize = DEFAULT_IMPORT_BATCH_SIZE,
  startedAt = Date.now(),
  userBatchSize = DEFAULT_IMPORT_BATCH_SIZE,
} = {}) {
  const createdPeople = [];
  const skippedExistingPeople = [];
  const batchSummaries = {
    relationBatches: [],
    userBatches: [],
  };
  const errors = [];
  const idByRowNumber = new Map();
  const userRecordsToCreate = plan.records
    .filter((entry) => entry.status === 'create')
    .slice(0, limitUsers || undefined);
  const userBatches = chunkArray(userRecordsToCreate, userBatchSize);

  for (const record of plan.records) {
    if (record.status === 'existing_source') {
      idByRowNumber.set(record.person.rowNumber, record.existingUser._id);
      skippedExistingPeople.push({
        rowNumber: record.person.rowNumber,
        name: record.person.fullName,
        reason: record.statusReason,
        existingUser: compactUserForReport(record.existingUser),
      });
    } else if (record.status === 'skip_existing_conflict') {
      skippedExistingPeople.push({
        rowNumber: record.person.rowNumber,
        name: record.person.fullName,
        reason: record.statusReason,
        existingUser: compactUserForReport(record.existingUser),
      });
    }
  }

  let lastSuccessfulUser = null;
  logProgress(
    'users',
    `starting ${userRecordsToCreate.length}/${plan.records.filter((entry) => entry.status === 'create').length} user creates in ${userBatches.length} batches`,
    startedAt
  );

  for (let batchIndex = 0; batchIndex < userBatches.length; batchIndex += 1) {
    const batch = userBatches[batchIndex];
    const batchNumber = batchIndex + 1;
    const beforeCreated = createdPeople.length;
    const beforeSkipped = skippedExistingPeople.length;
    try {
      await runBatchWithOptionalTransaction(!allowNonTransactional, async (session) => {
        for (const record of batch) {
          const existingUser = await findExistingRecordDuringImport(record, session);
          if (existingUser) {
            idByRowNumber.set(record.person.rowNumber, existingUser._id);
            skippedExistingPeople.push({
              rowNumber: record.person.rowNumber,
              name: record.person.fullName,
              reason: `Already exists during resumable batch import.`,
              existingUser: compactUserForReport(existingUser),
            });
            lastSuccessfulUser = record;
            continue;
          }

          try {
            const user = new User(record.payload);
            const passwordInput = record.preparedPasswordHash || record.defaultPasswordInput;
            if (passwordInput) {
              user.passwordHash = passwordInput;
            }
            await user.save({ session });
            idByRowNumber.set(record.person.rowNumber, user._id);
            createdPeople.push({
              id: String(user._id),
              rowNumber: record.person.rowNumber,
              name: record.person.fullName,
              hasLogin: Boolean(record.payload.hasLogin),
              nationalId: record.payload.nationalId || '',
            });
            lastSuccessfulUser = record;
          } catch (error) {
            const diagnostics = buildErrorDiagnostics(error, {
              operation: 'create_user',
              record,
            });
            errors.push({
              ...diagnostics,
              batchNumber,
              rowRange: formatRowRange(batch),
              stage: 'users',
            });
            const wrapped = wrapImportError(error, {
              operation: 'create_user',
              record,
            });
            wrapped.partialImportResult = {
              batchSummaries,
              createdPeople,
              createdRelations: [],
              errors,
              skippedExistingPeople,
              skippedRelations: [],
            };
            throw wrapped;
          }
        }
      });
    } catch (error) {
      if (!allowNonTransactional) {
        createdPeople.splice(beforeCreated);
        skippedExistingPeople.splice(beforeSkipped);
      }
      if (error.importDiagnostics) {
        error.importDiagnostics = {
          ...error.importDiagnostics,
          batchNumber,
          lastSuccessfulPerson: lastSuccessfulUser?.person?.fullName || '',
          lastSuccessfulRow: lastSuccessfulUser?.person?.rowNumber || null,
          rowRange: formatRowRange(batch),
          stage: 'users',
        };
      }
      error.partialImportResult = {
        batchSummaries,
        createdPeople,
        createdRelations: [],
        errors,
        skippedExistingPeople,
        skippedRelations: [],
      };
      throw error;
    }

    const createdInBatch = createdPeople.length - beforeCreated;
    const skippedInBatch = skippedExistingPeople.length - beforeSkipped;
    batchSummaries.userBatches.push({
      batchNumber,
      created: createdInBatch,
      rowRange: formatRowRange(batch),
      skipped: skippedInBatch,
      totalRows: batch.length,
    });
    logProgress(
      'users',
      `batch ${batchNumber}/${userBatches.length} rows ${formatRowRange(batch)} created=${createdInBatch} skipped=${skippedInBatch}; processed=${createdPeople.length + skippedExistingPeople.length}/${userRecordsToCreate.length}; last=${batch[batch.length - 1]?.person?.fullName || ''}`,
      startedAt
    );
  }

  const createdRelations = [];
  const skippedRelations = [];
  const { selected: relationWork, selectedRelationCount } = selectRelationRecords(plan, idByRowNumber, {
    allowExistingSourceRelationFill,
    limitRelations,
  });
  const relationBatches = chunkArray(relationWork, relationBatchSize);
  let processedRelationEntries = 0;
  let lastSuccessfulRelationRecord = null;

  logProgress(
    'relations',
    `starting ${selectedRelationCount}/${plan.plannedRelationEdges.length} relation entries in ${relationBatches.length} batches`,
    startedAt
  );

  for (let batchIndex = 0; batchIndex < relationBatches.length; batchIndex += 1) {
    const batch = relationBatches[batchIndex];
    const batchNumber = batchIndex + 1;
    const beforeCreatedRelations = createdRelations.length;
    const beforeSkippedRelations = skippedRelations.length;
    try {
      await runBatchWithOptionalTransaction(!allowNonTransactional, async (session) => {
        for (const item of batch) {
          const { record, relationPayload, relationCount, userId } = item;
          const user = await User.findById(userId)
            .select('father mother spouse siblings children')
            .session(session || null);
          if (!user) {
            skippedRelations.push({
              rowNumber: record.person.rowNumber,
              name: record.person.fullName,
              reason: 'Source user was not found while linking relations.',
            });
            processedRelationEntries += relationCount;
            lastSuccessfulRelationRecord = record;
            continue;
          }

          const setPayload = {};
          for (const field of ['father', 'mother', 'spouse']) {
            if (!relationPayload[field]) continue;
            if (record.status === 'existing_source' && user[field]?.relationRole) {
              skippedRelations.push({
                rowNumber: record.person.rowNumber,
                name: record.person.fullName,
                relationField: field,
                reason: `Existing imported user already has ${field}; not overwriting.`,
              });
              continue;
            }
            setPayload[field] = relationPayload[field];
          }

          for (const field of ['siblings', 'children']) {
            if (!relationPayload[field]?.length) continue;
            if (record.status === 'existing_source' && Array.isArray(user[field]) && user[field].length > 0) {
              skippedRelations.push({
                rowNumber: record.person.rowNumber,
                name: record.person.fullName,
                relationField: field,
                reason: `Existing imported user already has ${field}; not overwriting.`,
              });
              continue;
            }
            setPayload[field] = relationPayload[field];
          }

          const setCount = countRelationPayloadEntries(setPayload);
          if (!setCount) {
            processedRelationEntries += relationCount;
            lastSuccessfulRelationRecord = record;
            continue;
          }

          try {
            await User.updateOne({ _id: userId }, { $set: setPayload }, { session });
          } catch (error) {
            const relation = {
              fields: Object.keys(setPayload),
              relationCount: setCount,
            };
            errors.push({
              ...buildErrorDiagnostics(error, {
                operation: 'update_relations',
                record,
                relation,
              }),
              batchNumber,
              rowRange: formatRowRange(batch.map((entry) => entry.record)),
                stage: 'relations',
              });
            const wrapped = wrapImportError(error, {
              operation: 'update_relations',
              record,
              relation,
            });
            wrapped.partialImportResult = {
              batchSummaries,
              createdPeople,
              createdRelations,
              errors,
              skippedExistingPeople,
              skippedRelations,
            };
            throw wrapped;
          }
          createdRelations.push({
            rowNumber: record.person.rowNumber,
            name: record.person.fullName,
            relationsSet: setCount,
            fields: Object.keys(setPayload),
          });
          processedRelationEntries += relationCount;
          lastSuccessfulRelationRecord = record;
        }
      });
    } catch (error) {
      if (!allowNonTransactional) {
        createdRelations.splice(beforeCreatedRelations);
        skippedRelations.splice(beforeSkippedRelations);
      }
      if (error.importDiagnostics) {
        error.importDiagnostics = {
          ...error.importDiagnostics,
          batchNumber,
          lastSuccessfulPerson: lastSuccessfulRelationRecord?.person?.fullName || '',
          lastSuccessfulRow: lastSuccessfulRelationRecord?.person?.rowNumber || null,
          rowRange: formatRowRange(batch.map((entry) => entry.record)),
          stage: 'relations',
        };
      }
      error.partialImportResult = {
        batchSummaries,
        createdPeople,
        createdRelations,
        errors,
        skippedExistingPeople,
        skippedRelations,
      };
      throw error;
    }

    logProgress(
      'relations',
      `batch ${batchNumber}/${relationBatches.length} rows ${formatRowRange(batch.map((entry) => entry.record))} processed=${processedRelationEntries}/${selectedRelationCount} created=${createdRelations.length - beforeCreatedRelations} skipped=${skippedRelations.length - beforeSkippedRelations}; last=${batch[batch.length - 1]?.record?.person?.fullName || ''}`,
      startedAt
    );
    batchSummaries.relationBatches.push({
      batchNumber,
      created: createdRelations.length - beforeCreatedRelations,
      processedRelationEntries,
      rowRange: formatRowRange(batch.map((entry) => entry.record)),
      skipped: skippedRelations.length - beforeSkippedRelations,
      totalRows: batch.length,
    });
  }

  return {
    createdPeople,
    createdRelations,
    batchSummaries,
    errors,
    skippedExistingPeople,
    skippedRelations,
  };
}

function summarizeImportPlan(plan) {
  const recordsToCreate = plan.records.filter((record) => record.status === 'create');
  const loginEnabledToCreate = recordsToCreate.filter((record) => record.payload.hasLogin).length;
  const warningCount = plan.records.reduce((sum, record) => sum + record.warnings.length, 0);
  return {
    alreadyExistingOrSkipped: plan.records.length - recordsToCreate.length,
    loginEnabledUsersToCreate: loginEnabledToCreate,
    peopleToCreate: recordsToCreate.length,
    peopleToCreateWithoutLogin: recordsToCreate.length - loginEnabledToCreate,
    relationsPrepared: plan.plannedRelationEdges.length,
    relationsSkippedByExistingConflicts: plan.skippedRelationEdges.length,
    warnings: warningCount,
  };
}

function indexKeyEquals(index, expectedKey) {
  return JSON.stringify(index?.key || {}) === JSON.stringify(expectedKey);
}

function hasExpectedNonEmptyStringPartial(index, field) {
  const partial = index?.partialFilterExpression?.[field];
  return Boolean(partial && partial.$type === 'string' && partial.$gt === '');
}

function getIndexCompatibility(indexes = []) {
  const findIndexByField = (field) => indexes.find((index) => indexKeyEquals(index, { [field]: 1 }));
  const phonePrimaryIndex = findIndexByField('phonePrimary');
  const emailIndex = findIndexByField('email');
  const nationalIdIndex = findIndexByField('nationalId');

  const phonePrimaryCompatible = Boolean(
    phonePrimaryIndex?.unique === true
    && hasExpectedNonEmptyStringPartial(phonePrimaryIndex, 'phonePrimary')
  );
  const emailCompatible = Boolean(
    emailIndex?.unique === true
    && (emailIndex.sparse === true || hasExpectedNonEmptyStringPartial(emailIndex, 'email'))
  );
  const nationalIdCompatible = Boolean(
    nationalIdIndex?.unique === true
    && (nationalIdIndex.sparse === true || hasExpectedNonEmptyStringPartial(nationalIdIndex, 'nationalId'))
  );

  return {
    compatibleForImportWithoutPhones: phonePrimaryCompatible,
    email: {
      compatible: emailCompatible,
      index: emailIndex || null,
    },
    nationalId: {
      compatible: nationalIdCompatible,
      index: nationalIdIndex || null,
    },
    phonePrimary: {
      compatible: phonePrimaryCompatible,
      expected:
        'unique partial index with partialFilterExpression { phonePrimary: { $type: "string", $gt: "" } }',
      index: phonePrimaryIndex || null,
    },
  };
}

function summarizeIndexes(indexes = []) {
  return indexes
    .filter((index) => ['phonePrimary_1', 'email_1', 'nationalId_1'].includes(index.name))
    .map((index) => ({
      key: index.key,
      name: index.name,
      partialFilterExpression: index.partialFilterExpression || null,
      sparse: Boolean(index.sparse),
      unique: Boolean(index.unique),
    }));
}

async function buildPayloadSafetyChecks(plan, indexes = []) {
  const recordsToCreate = plan.records.filter((record) => record.status === 'create');
  const schemaValidationErrors = [];
  const loginIdentifierErrors = [];
  const relationValidationErrors = [];
  const optionalUniqueNullOrEmptyWrites = [];
  const nationalIdWrittenForNoLogin = [];
  const phonePrimaryEqualsNationalId = [];
  const uniqueIndexDuplicateValues = [];
  const uniqueIndexExistingConflicts = [];
  const nationalIdCounts = new Map();
  let payloadsWithoutPhonePrimary = 0;
  const idByRowNumber = new Map();

  for (const record of plan.records) {
    if (record.status === 'create' || record.status === 'existing_source') {
      idByRowNumber.set(
        record.person.rowNumber,
        record.existingUser?._id || new mongoose.Types.ObjectId()
      );
    }
  }

  for (const record of recordsToCreate) {
    const { payload } = record;
    const user = new User(payload);
    if (record.defaultPasswordInput) {
      user.passwordHash = record.defaultPasswordInput;
    }
    const validationError = user.validateSync();
    if (validationError) {
      schemaValidationErrors.push(buildErrorDiagnostics(validationError, {
        operation: 'validate_user_payload',
        record,
      }));
    }

    if (payload.hasLogin) {
      if (payload.loginIdentifierType !== 'nationalId') {
        loginIdentifierErrors.push({
          actual: payload.loginIdentifierType || '',
          expected: 'nationalId',
          name: record.person.fullName,
          rowNumber: record.person.rowNumber,
        });
      }
      if (!record.defaultPasswordInput) {
        loginIdentifierErrors.push({
          issue: 'missing_default_password_input',
          name: record.person.fullName,
          rowNumber: record.person.rowNumber,
        });
      }
    }

    if (!Object.prototype.hasOwnProperty.call(payload, 'phonePrimary')) {
      payloadsWithoutPhonePrimary += 1;
    }

    for (const field of OPTIONAL_UNIQUE_FIELDS) {
      if (!Object.prototype.hasOwnProperty.call(payload, field)) continue;
      const value = payload[field];
      if (value == null || (typeof value === 'string' && value.trim() === '')) {
        optionalUniqueNullOrEmptyWrites.push({
          field,
          name: record.person.fullName,
          rowNumber: record.person.rowNumber,
          value,
        });
      }
    }

    if (payload.nationalId && !record.person.nationalId.loginShouldBeEnabled) {
      nationalIdWrittenForNoLogin.push({
        name: record.person.fullName,
        nationalId: payload.nationalId,
        nationalIdStatus: record.person.nationalId.status,
        rowNumber: record.person.rowNumber,
      });
    }

    if (payload.phonePrimary && payload.nationalId && payload.phonePrimary === payload.nationalId) {
      phonePrimaryEqualsNationalId.push({
        name: record.person.fullName,
        nationalId: payload.nationalId,
        rowNumber: record.person.rowNumber,
      });
    }

    if (payload.nationalId) {
      const rows = nationalIdCounts.get(payload.nationalId) || [];
      rows.push(record.person.rowNumber);
      nationalIdCounts.set(payload.nationalId, rows);
    }
  }

  for (const record of plan.records.filter((entry) => entry.status === 'create' || entry.status === 'existing_source')) {
    const relationPayload = buildRelationPayload(record.person, idByRowNumber);
    const fields = ['father', 'mother', 'spouse'];
    for (const field of fields) {
      const member = relationPayload[field];
      if (!member) continue;
      if (!member.userId || !member.name || !member.relationRole) {
        relationValidationErrors.push({
          field,
          member,
          name: record.person.fullName,
          rowNumber: record.person.rowNumber,
        });
      }
    }
    for (const field of ['siblings', 'children']) {
      for (const member of relationPayload[field] || []) {
        if (!member.userId || !member.name || !member.relationRole) {
          relationValidationErrors.push({
            field,
            member,
            name: record.person.fullName,
            rowNumber: record.person.rowNumber,
          });
        }
      }
    }
  }

  const duplicatePayloadNationalIds = [...nationalIdCounts.entries()]
    .filter(([, rows]) => rows.length > 1)
    .map(([nationalId, rows]) => ({ nationalId, rows }));

  for (const index of indexes.filter((entry) => entry.unique && Object.keys(entry.key || {}).length === 1)) {
    const field = Object.keys(index.key)[0];
    const valueRows = new Map();
    for (const record of recordsToCreate) {
      const value = record.payload[field];
      if (value == null || value === '') continue;
      const rows = valueRows.get(value) || [];
      rows.push(record.person.rowNumber);
      valueRows.set(value, rows);
    }
    for (const [value, rows] of valueRows.entries()) {
      if (rows.length > 1) {
        uniqueIndexDuplicateValues.push({
          field,
          indexName: index.name,
          rows,
          value,
          withinImportBatch: true,
        });
      }
    }
    const values = [...valueRows.keys()];
    if (values.length && field !== '_id') {
      const existing = await User.find({ [field]: { $in: values }, includeDeleted: true })
        .select(`_id fullName ${field} customDetails.importSourceKey`)
        .lean();
      for (const user of existing) {
        uniqueIndexExistingConflicts.push({
          existingUser: compactUserForReport(user),
          field,
          indexName: index.name,
          value: user[field],
        });
      }
    }
  }

  const indexCompatibility = getIndexCompatibility(indexes);
  const blockingIssues = [];

  if (schemaValidationErrors.length) {
    blockingIssues.push(`${schemaValidationErrors.length} prepared user payloads fail User schema validation.`);
  }
  if (loginIdentifierErrors.length) {
    blockingIssues.push(`${loginIdentifierErrors.length} login payloads have invalid login identifier/default password state.`);
  }
  if (relationValidationErrors.length) {
    blockingIssues.push(`${relationValidationErrors.length} prepared relation payloads are missing required relation fields.`);
  }
  if (uniqueIndexDuplicateValues.length) {
    blockingIssues.push(`${uniqueIndexDuplicateValues.length} unique-index duplicate value groups were found inside the import payloads.`);
  }
  if (uniqueIndexExistingConflicts.length) {
    blockingIssues.push(`${uniqueIndexExistingConflicts.length} unique-index values already exist in the database.`);
  }
  if (optionalUniqueNullOrEmptyWrites.length) {
    blockingIssues.push(
      `${optionalUniqueNullOrEmptyWrites.length} payload values would write null/empty into optional unique fields.`
    );
  }
  if (phonePrimaryEqualsNationalId.length) {
    blockingIssues.push(
      `${phonePrimaryEqualsNationalId.length} payloads would write nationalId into phonePrimary.`
    );
  }
  if (nationalIdWrittenForNoLogin.length) {
    blockingIssues.push(
      `${nationalIdWrittenForNoLogin.length} no-login payloads would write nationalId into the unique nationalId field.`
    );
  }
  if (duplicatePayloadNationalIds.length) {
    blockingIssues.push(
      `${duplicatePayloadNationalIds.length} duplicate nationalId values would be written to created payloads.`
    );
  }
  if (!indexCompatibility.phonePrimary.compatible && payloadsWithoutPhonePrimary > 1) {
    blockingIssues.push(
      'users.phonePrimary_1 is not a partial unique index, so importing multiple users without phonePrimary can fail with duplicate null.'
    );
  }

  return {
    blockingIssues,
    indexCompatibility,
    indexSummary: summarizeIndexes(indexes),
    loginIdentifierErrors,
    nationalIdWrittenForNoLogin,
    optionalUniqueNullOrEmptyWrites,
    payloadsWithoutPhonePrimary,
    transactionRisk: {
      loginPasswordHashesNeeded: recordsToCreate.filter((record) => (
        record.payload.hasLogin && record.defaultPasswordInput
      )).length,
      mitigation:
        'Import prepares bcrypt password hashes before user batches, then writes users/relations in short batches instead of one full-import transaction.',
      usersToCreateInImportPlan: recordsToCreate.length,
    },
    phonePrimaryEqualsNationalId,
    duplicatePayloadNationalIds,
    relationValidationErrors,
    schemaValidationErrors,
    uniqueIndexExistingConflicts,
    uniqueIndexDuplicateValues,
  };
}

function buildImportReport({ databaseWritesExecuted, importResult, mode, plan, preflightChecks, reportPath, reviewValidation, sheetName, workbookPath }) {
  const summary = summarizeImportPlan(plan);
  const createdPeople = importResult?.createdPeople || [];
  const skippedExistingPeople = importResult?.skippedExistingPeople || plan.records
    .filter((record) => record.status !== 'create')
    .map((record) => ({
      rowNumber: record.person.rowNumber,
      name: record.person.fullName,
      reason: record.statusReason,
      existingUser: compactUserForReport(record.existingUser),
    }));
  const createdRelations = importResult?.createdRelations || [];
  const skippedRelations = [
    ...(importResult?.skippedRelations || []),
    ...plan.skippedRelationEdges.map((edge) => ({
      sourceRow: edge.source.rowNumber,
      sourceName: edge.source.fullName,
      targetRow: edge.target.rowNumber,
      targetName: edge.target.fullName,
      reason: 'Skipped because source or target user already exists as a non-import conflict.',
    })),
  ];

  return {
    database_writes_executed: databaseWritesExecuted,
    generatedAt: new Date().toISOString(),
    mode,
    reportPath,
    reviewWorkbook: reviewValidation.path,
    reviewWorkbookMetrics: {
      database_writes_executed: reviewValidation.metrics.database_writes_executed,
      total_people: reviewValidation.metrics.total_people,
      people_with_login_enabled: reviewValidation.metrics.people_with_login_enabled,
      people_without_login: reviewValidation.metrics.people_without_login,
    },
    sheetName,
    summary,
    batchSummaries: importResult?.batchSummaries || { relationBatches: [], userBatches: [] },
    preflightChecks,
    workbookPath,
    createdPeople,
    skippedExistingPeople,
    loginEnabledPeople: (databaseWritesExecuted ? createdPeople : plan.records.filter((record) => record.status === 'create'))
      .filter((entry) => (entry.hasLogin !== undefined ? entry.hasLogin : entry.payload?.hasLogin))
      .map((entry) => ({
        rowNumber: entry.rowNumber || entry.person?.rowNumber,
        name: entry.name || entry.person?.fullName,
        nationalId: entry.nationalId || entry.payload?.nationalId || '',
      })),
    peopleWithoutLogin: (databaseWritesExecuted ? createdPeople : plan.records.filter((record) => record.status === 'create'))
      .filter((entry) => !(entry.hasLogin !== undefined ? entry.hasLogin : entry.payload?.hasLogin))
      .map((entry) => ({
        rowNumber: entry.rowNumber || entry.person?.rowNumber,
        name: entry.name || entry.person?.fullName,
        nationalId: entry.nationalId || entry.person?.nationalId?.nationalId || '',
      })),
    createdRelations,
    skippedRelations,
    warnings: plan.records
      .filter((record) => record.warnings.length > 0 || record.status !== 'create')
      .map((record) => ({
        rowNumber: record.person.rowNumber,
        name: record.person.fullName,
        status: record.status,
        statusReason: record.statusReason,
        warnings: record.warnings,
      })),
    errors: importResult?.errors || [],
  };
}

function writeJsonReport(reportPath, report) {
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');
}

async function runPreflightOrImport({ analyzedData, mode, options, workbookPath }) {
  const startedAt = Date.now();
  const reviewValidation = await validateReviewedWorkbook(options.reviewFile);
  const reportPath = ensureJsonReportPath(
    options.resultReport,
    mode === 'import' ? 'users-import-result' : 'users-import-preflight'
  );

  await mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/church');
  logProgress('plan', 'building import plan from reviewed workbook', startedAt);
  const plan = await buildImportPlan({
    people: analyzedData.people,
    relationEdges: analyzedData.relationEdges,
    reviewFile: reviewValidation.path,
    sheetName: options.sheet,
    workbookPath,
  });

  const planSummary = summarizeImportPlan(plan);
  logProgress(
    'plan',
    `plan ready: create=${planSummary.peopleToCreate} login=${planSummary.loginEnabledUsersToCreate} noLogin=${planSummary.peopleToCreateWithoutLogin} relations=${planSummary.relationsPrepared}`,
    startedAt
  );
  const indexes = await User.collection.indexes();
  logProgress('preflight', 'running payload/schema/relation/index safety checks', startedAt);
  const preflightChecks = await buildPayloadSafetyChecks(plan, indexes);
  logProgress('preflight', `completed safety checks; blockingIssues=${preflightChecks.blockingIssues.length}`, startedAt);
  let importResult = null;
  let importError = null;
  let databaseWritesExecuted = 0;

  if (mode === 'import') {
    if (preflightChecks.blockingIssues.length) {
      throw new Error(
        `Import blocked by preflight safety checks: ${preflightChecks.blockingIssues.join(' ')}`
      );
    }

    const preparedHashCount = await preparePasswordHashesForPlan(plan, {
      limitUsers: options.limitUsers,
      progressEvery: options.userBatchSize,
      startedAt,
    });
    console.log(`Prepared password hashes before user batches: ${preparedHashCount}`);

    try {
      importResult = await executeImportWrites(plan, {
        allowNonTransactional: options.allowNonTransactional,
        limitRelations: options.limitRelations,
        limitUsers: options.limitUsers,
        relationBatchSize: options.relationBatchSize,
        startedAt,
        userBatchSize: options.userBatchSize,
      });
    } catch (error) {
      importError = error;
      importResult = error.partialImportResult || importResult || {
        batchSummaries: { relationBatches: [], userBatches: [] },
        createdPeople: [],
        createdRelations: [],
        errors: error.importDiagnostics ? [error.importDiagnostics] : [{ errorMessage: error.message }],
        skippedExistingPeople: [],
        skippedRelations: [],
      };
    }
    databaseWritesExecuted =
      importResult.createdPeople.length
      + importResult.createdRelations.reduce((sum, entry) => sum + Number(entry.relationsSet || 0), 0);
  }

  const report = buildImportReport({
    databaseWritesExecuted,
    importResult,
    mode,
    plan,
    preflightChecks,
    reportPath,
    reviewValidation,
    sheetName: options.sheet,
    workbookPath,
  });
  logProgress('report', `writing ${mode} report ${reportPath}`, startedAt);
  writeJsonReport(reportPath, report);
  logProgress('report', `wrote ${mode} report`, startedAt);

  console.log(`Mode: ${mode}`);
  console.log(`Workbook: ${workbookPath}`);
  console.log(`Review workbook: ${reviewValidation.path}`);
  console.log(`People to create: ${planSummary.peopleToCreate}`);
  console.log(`Login-enabled users to create: ${planSummary.loginEnabledUsersToCreate}`);
  console.log(`People to create without login: ${planSummary.peopleToCreateWithoutLogin}`);
  console.log(`Relations prepared: ${planSummary.relationsPrepared}`);
  console.log(`Warnings: ${planSummary.warnings}`);
  console.log(`Already existing/skipped: ${planSummary.alreadyExistingOrSkipped}`);
  console.log(`Phone index compatible: ${preflightChecks.indexCompatibility.phonePrimary.compatible ? 'yes' : 'no'}`);
  console.log(`Preflight blocking issues: ${preflightChecks.blockingIssues.length}`);
  console.log(`Database writes executed: ${databaseWritesExecuted}`);
  console.log(`Result report: ${reportPath}`);
  if (mode === 'preflight') {
    console.log(`No database writes were executed. Re-run with --import --confirm-import ${IMPORT_CONFIRMATION} to create records.`);
  }

  if (importError) {
    throw importError;
  }

  return report;
}

async function main() {
  const startedAt = Date.now();
  const options = parseArgs(process.argv.slice(2));
  const workbookPath = path.resolve(options.file);

  if (!fs.existsSync(workbookPath)) {
    throw new Error(`Workbook file was not found: ${workbookPath}`);
  }

  logProgress('workbook', `reading workbook ${workbookPath} sheet "${options.sheet}"`, startedAt);
  const workbook = loadWorkbookRows(workbookPath, options.sheet);
  logProgress('workbook', `read ${Array.isArray(workbook.rows) ? workbook.rows.length : 0} rows`, startedAt);
  const allRows = Array.isArray(workbook.rows) ? workbook.rows : [];
  const dataRows =
    options.sheet === DEFAULT_SHEET
      ? allRows.filter((row) => Number(row.rowNumber) > 1)
      : allRows;
  const limitedRows =
    options.limit && options.limit > 0 ? dataRows.slice(0, options.limit) : dataRows;

  logProgress('plan', `analyzing ${limitedRows.length} worksheet rows`, startedAt);
  const analyzedData = buildAnalyzedImportData({ limitedRows, sheetName: options.sheet });
  logProgress(
    'plan',
    `prepared ${analyzedData.people.length} people and ${analyzedData.relationEdges.length} inferred relation edges`,
    startedAt
  );

  if (options.mode === 'preflight' || options.mode === 'import') {
    await runPreflightOrImport({
      analyzedData,
      mode: options.mode,
      options,
      workbookPath,
    });
    return;
  }

  const outputPath = ensureOutputPath(options.output);
  const sheets = [
    {
      name: 'Summary',
      rows: buildSummaryRows({
        limitedRows,
        outputPath,
        people: analyzedData.people,
        relationEdges: analyzedData.relationEdges,
        sheetName: options.sheet,
        workbookPath,
      }),
    },
    { name: 'Review', rows: buildReviewRows(analyzedData.people) },
    { name: 'Relations', rows: buildRelationsRows(analyzedData.relationEdges) },
    { name: 'Warnings', rows: buildWarningsRows(analyzedData.people) },
  ];

  writeXlsxFile(outputPath, sheets);

  console.log(`Workbook: ${workbookPath}`);
  console.log(`Sheet: ${options.sheet}`);
  console.log(`Rows read: ${limitedRows.length}`);
  console.log(`People reviewed: ${analyzedData.people.length}`);
  console.log(`Review Excel: ${outputPath}`);
  console.log('Database writes executed: 0');
}

main()
  .catch((error) => {
    console.error(`Import workflow failed: ${error.message}`);
    if (error.importDiagnostics) {
      console.error(`Import failure diagnostics: ${formatErrorDiagnostics(error.importDiagnostics)}`);
    }
    if (error.cause && error.cause !== error) {
      console.error(`Original error: ${error.cause.name || 'Error'}: ${error.cause.message}`);
    }
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect().catch(() => {});
  });
