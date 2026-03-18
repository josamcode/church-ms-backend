const DEFAULT_AID_OCCURRENCES = Object.freeze(['one time', 'weekly', 'monthly', 'yearly']);

const OCCURRENCE_ALIASES = new Map([
  ['one time', 'one time'],
  ['one-time', 'one time'],
  ['onetime', 'one time'],
  ['once', 'one time'],
  ['single', 'one time'],
  ['single time', 'one time'],
  ['weekly', 'weekly'],
  ['week', 'weekly'],
  ['every week', 'weekly'],
  ['monthly', 'monthly'],
  ['month', 'monthly'],
  ['every month', 'monthly'],
  ['yearly', 'yearly'],
  ['annual', 'yearly'],
  ['annually', 'yearly'],
  ['every year', 'yearly'],
  ['سنة', 'yearly'],
  ['سنوي', 'yearly'],
  ['سنويًا', 'yearly'],
  ['سنويا', 'yearly'],
  ['شهري', 'monthly'],
  ['شهريًا', 'monthly'],
  ['شهريا', 'monthly'],
  ['أسبوعي', 'weekly'],
  ['اسبوعي', 'weekly'],
  ['أسبوعيًا', 'weekly'],
  ['اسبوعيا', 'weekly'],
  ['مرة واحدة', 'one time'],
]);

function normalizeAidOccurrence(value) {
  const trimmed = String(value || '').trim();
  if (!trimmed) return '';

  const normalizedKey = trimmed.toLowerCase().replace(/\s+/g, ' ');
  return OCCURRENCE_ALIASES.get(normalizedKey) || trimmed;
}

function getAidOccurrenceFrequency(value) {
  const normalized = normalizeAidOccurrence(value);
  if (normalized === 'weekly' || normalized === 'monthly' || normalized === 'yearly') {
    return normalized;
  }

  return null;
}

function normalizeAidOccurrenceOptions(values = []) {
  const merged = [...DEFAULT_AID_OCCURRENCES, ...(Array.isArray(values) ? values : [])]
    .map(normalizeAidOccurrence)
    .filter(Boolean);

  return [...new Set(merged)];
}

function toUtcDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;

  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function addDaysUtc(date, days) {
  const next = new Date(date.getTime());
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function daysInUtcMonth(year, monthIndex) {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

function addMonthsUtc(date, months) {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();
  const day = date.getUTCDate();
  const targetMonthIndex = month + months;
  const targetYear = year + Math.floor(targetMonthIndex / 12);
  const normalizedTargetMonth = ((targetMonthIndex % 12) + 12) % 12;
  const maxDay = daysInUtcMonth(targetYear, normalizedTargetMonth);

  return new Date(Date.UTC(targetYear, normalizedTargetMonth, Math.min(day, maxDay)));
}

function addYearsUtc(date, years) {
  const targetYear = date.getUTCFullYear() + years;
  const month = date.getUTCMonth();
  const day = date.getUTCDate();
  const maxDay = daysInUtcMonth(targetYear, month);

  return new Date(Date.UTC(targetYear, month, Math.min(day, maxDay)));
}

function isSameUtcDay(left, right) {
  return !!left &&
    !!right &&
    left.getUTCFullYear() === right.getUTCFullYear() &&
    left.getUTCMonth() === right.getUTCMonth() &&
    left.getUTCDate() === right.getUTCDate();
}

function getNextOccurrenceOnOrAfter(baseDateValue, occurrenceValue, targetDateValue) {
  const frequency = getAidOccurrenceFrequency(occurrenceValue);
  if (!frequency) return null;

  const baseDate = toUtcDate(baseDateValue);
  const targetDate = toUtcDate(targetDateValue);
  if (!baseDate || !targetDate) return null;

  if (baseDate >= targetDate) return baseDate;

  let cursor = baseDate;
  let safety = 0;

  while (cursor < targetDate && safety < 5000) {
    if (frequency === 'weekly') {
      cursor = addDaysUtc(cursor, 7);
    } else if (frequency === 'monthly') {
      cursor = addMonthsUtc(cursor, 1);
    } else {
      cursor = addYearsUtc(cursor, 1);
    }
    safety += 1;
  }

  return cursor;
}

function getNextOccurrenceAfter(dateValue, occurrenceValue) {
  const frequency = getAidOccurrenceFrequency(occurrenceValue);
  const date = toUtcDate(dateValue);
  if (!frequency || !date) return null;

  if (frequency === 'weekly') {
    return addDaysUtc(date, 7);
  }

  if (frequency === 'monthly') {
    return addMonthsUtc(date, 1);
  }

  return addYearsUtc(date, 1);
}

module.exports = {
  DEFAULT_AID_OCCURRENCES,
  getAidOccurrenceFrequency,
  getNextOccurrenceAfter,
  getNextOccurrenceOnOrAfter,
  isSameUtcDay,
  normalizeAidOccurrence,
  normalizeAidOccurrenceOptions,
  toUtcDate,
};
