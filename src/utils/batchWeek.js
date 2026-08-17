/**
 * Batch-week boundaries for the RTO payment queue.
 *
 * The client's finance workbook groups RTO payables into "BATCH WEEK ENDING:
 * dd/mm/yyyy" blocks — every one of those dates is the weekday the pay run goes
 * out (Friday in their sheet, but configurable via BatchConfig.weekEndingDay).
 *
 * A batch week is the 7 Sydney civil days that END on that weekday. With a
 * Friday week-ending day, an invoice uploaded any time Sat 11/04 → Fri 17/04
 * lands in batch week ending 17/04/2026.
 *
 * Everything here works in *Sydney civil dates* ("YYYY-MM-DD") and only crosses
 * into instants at the edges via aestTime — bucketing in UTC would push a
 * Saturday-morning AEST upload into the previous week's batch.
 */

const { aestDateKey, aestDayStartUtc, aestDayEndUtc, todayAestKey } = require('./aestTime');

/** Default week-ending weekday: 5 = Friday (0 = Sunday … 6 = Saturday). */
const DEFAULT_WEEK_ENDING_DAY = 5;

/** Days before the eligibility date at which a row is flagged "due soon". */
const DEFAULT_DUE_SOON_DAYS = 5;

/** The 21-day RTO assessment KPI window (completion → eligibility). */
const ELIGIBILITY_DAYS = 21;

const pad = (n) => String(n).padStart(2, '0');

/** Civil-date arithmetic on a "YYYY-MM-DD" key. DST-free (pure UTC maths). */
function shiftKey(key, days) {
  const [y, m, d] = String(key).split('-').map(Number);
  if (!y || !m || !d) return null;
  const shifted = new Date(Date.UTC(y, m - 1, d + days));
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())}`;
}

/** Weekday (0 = Sunday) of a civil-date key. */
function dayOfWeek(key) {
  const [y, m, d] = String(key).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** Whole civil days between two date keys (to − from). Negative = in the past. */
function diffKeyDays(fromKey, toKey) {
  if (!fromKey || !toKey) return null;
  const [fy, fm, fd] = String(fromKey).split('-').map(Number);
  const [ty, tm, td] = String(toKey).split('-').map(Number);
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86400000);
}

/**
 * The batch-week key (the week-ending civil date) an instant falls into.
 * Returns "YYYY-MM-DD" — this is PaymentBatch.weekKey.
 */
function weekKeyFor(value, weekEndingDay = DEFAULT_WEEK_ENDING_DAY) {
  const key = aestDateKey(value);
  if (!key) return null;
  // Days forward to the next week-ending weekday; 0 when the date IS that day,
  // so an invoice uploaded on pay-run Friday belongs to that Friday's batch.
  const delta = (Number(weekEndingDay) - dayOfWeek(key) + 7) % 7;
  return shiftKey(key, delta);
}

/**
 * Same bucketing, but from a civil-date key the client already sent
 * ("2026-04-24"). Kept separate from weekKeyFor so a plain date string never
 * goes through `new Date()` — that would re-interpret it in the server's zone
 * and shift the week by a day across the AEST/AEDT boundary.
 */
function weekKeyFromDateKey(dateKey, weekEndingDay = DEFAULT_WEEK_ENDING_DAY) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateKey || ''))) return null;
  const delta = (Number(weekEndingDay) - dayOfWeek(dateKey) + 7) % 7;
  return shiftKey(dateKey, delta);
}

/** The current batch week's key. */
function currentWeekKey(weekEndingDay = DEFAULT_WEEK_ENDING_DAY) {
  return weekKeyFor(new Date(), weekEndingDay);
}

/**
 * Boundary instants + civil keys for a batch week, given its week-ending key.
 * `weekStartDate` is Sydney 00:00:00.000 six days earlier; `weekEndingDate` is
 * Sydney 23:59:59.999 on the week-ending day itself.
 */
function weekBounds(weekKey) {
  const startKey = shiftKey(weekKey, -6);
  return {
    weekKey,
    weekStartKey: startKey,
    weekStartDate: aestDayStartUtc(startKey),
    weekEndingDate: aestDayEndUtc(weekKey),
  };
}

/** Eligibility date = completion + 21 days (the sheet's "Comp +21 days"). */
function eligibilityDateFor(completionDate) {
  if (!completionDate) return null;
  const key = aestDateKey(completionDate);
  if (!key) return null;
  return aestDayEndUtc(shiftKey(key, ELIGIBILITY_DAYS));
}

/**
 * Days remaining until an eligibility date, in Sydney civil days.
 * Negative = overdue, matching the workbook's "Days Remaining (– = Overdue)".
 */
function daysRemaining(eligibilityDate, fromKey = null) {
  if (!eligibilityDate) return null;
  return diffKeyDays(fromKey || todayAestKey(), aestDateKey(eligibilityDate));
}

/**
 * Row urgency, mirroring the workbook's colour key. `paid` wins over everything;
 * a row with no eligibility date yet is still "in assessment".
 */
function urgencyFor({ paymentStatus, eligibilityDate, dueSoonDays = DEFAULT_DUE_SOON_DAYS }) {
  if (paymentStatus === 'paid') return 'paid';
  const days = daysRemaining(eligibilityDate);
  if (days === null) return 'inAssessment';
  if (days < 0) return 'overdue';
  if (days <= dueSoonDays) return 'dueSoon';
  return 'eligible';
}

/** Human label for a week key, e.g. "24/04/2026". */
function formatWeekKey(weekKey) {
  const [y, m, d] = String(weekKey || '').split('-');
  return y && m && d ? `${d}/${m}/${y}` : String(weekKey || '');
}

module.exports = {
  DEFAULT_WEEK_ENDING_DAY,
  DEFAULT_DUE_SOON_DAYS,
  ELIGIBILITY_DAYS,
  shiftKey,
  dayOfWeek,
  diffKeyDays,
  weekKeyFor,
  weekKeyFromDateKey,
  currentWeekKey,
  weekBounds,
  eligibilityDateFor,
  daysRemaining,
  urgencyFor,
  formatWeekKey,
};
