/**
 * Relative date fixtures for tests.
 *
 * Hardcoding a calendar date in a fixture is a time bomb: any code path that
 * validates a date against "now" (booking horizons, expiry windows, reminder
 * scheduling) starts failing the moment the literal drifts into the past, and
 * the failure looks like a logic regression rather than a stale fixture.
 *
 * Use these helpers instead of literal date strings anywhere the value must be
 * in the future relative to the test run.
 */

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** ISO `YYYY-MM-DD` for a date offset from now. Negative values go backwards. */
function daysFromNow(days) {
  return new Date(Date.now() + days * MS_PER_DAY).toISOString().slice(0, 10);
}

/** ISO `YYYY-MM-DD` for a date in the past. */
function daysAgo(days) {
  return daysFromNow(-days);
}

/**
 * A date that is always inside the default booking horizon.
 * The booking type fixtures use `bookingHorizonDays: 45`, so +7 days is safely
 * within [today, today + horizon] regardless of when the suite runs.
 */
const FUTURE_DATE = daysFromNow(7);

module.exports = { daysFromNow, daysAgo, FUTURE_DATE, MS_PER_DAY };
