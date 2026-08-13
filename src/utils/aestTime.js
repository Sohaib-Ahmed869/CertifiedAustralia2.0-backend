/**
 * AEST/AEDT (Australia/Sydney) civil-date helpers.
 *
 * The portal is an Australian product: every user-visible date belongs to the
 * Sydney calendar, regardless of where the server or the browser sits. Instants
 * are stored as UTC in Mongo; a "date" the user sees (a calendar cell, a day
 * range, a scorecard row) is a *civil date* — "YYYY-MM-DD" with no offset.
 *
 * Mixing the two is the classic bug: `new Date('2026-08-20').setHours(0,0,0,0)`
 * gives Sydney midnight only if the process happens to run in Sydney. These
 * helpers make the conversion explicit and DST-aware via Intl.
 *
 * Mirrors `certified-australia-v2-fe/src/utils/aestTime.js` on the frontend and
 * the `aestPartsFromDate` convention in `callScorecardService`.
 */

const AEST_TZ = 'Australia/Sydney';

/**
 * Offset (Sydney − UTC) in milliseconds at the given instant. DST-aware.
 * Compared against a second-truncated instant because Intl only reports down to
 * seconds — otherwise the instant's own milliseconds leak into the offset.
 */
function tzOffsetMs(date) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: AEST_TZ,
    hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = dtf.formatToParts(date).reduce((a, x) => { a[x.type] = x.value; return a; }, {});
  const hour = p.hour === '24' ? '00' : p.hour;
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +hour, +p.minute, +p.second);
  return asUTC - Math.floor(date.getTime() / 1000) * 1000;
}

/** The Sydney civil date ("YYYY-MM-DD") an instant falls on. */
function aestDateKey(value) {
  const d = value instanceof Date ? value : new Date(value);
  if (isNaN(d.getTime())) return null;
  const dtf = new Intl.DateTimeFormat('en-CA', {
    timeZone: AEST_TZ,
    year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const p = dtf.formatToParts(d).reduce((a, x) => { a[x.type] = x.value; return a; }, {});
  return `${p.year}-${p.month}-${p.day}`;
}

/** Sydney wall-clock time label for an instant, e.g. "9:00 am". */
function aestTimeLabel(value) {
  const d = value instanceof Date ? value : new Date(value);
  if (isNaN(d.getTime())) return null;
  return d.toLocaleTimeString('en-AU', {
    timeZone: AEST_TZ,
    hour: 'numeric', minute: '2-digit', hour12: true,
  });
}

/**
 * Converts a Sydney wall-clock to the matching UTC instant. Two-pass offset
 * correction so it stays correct on DST-transition days.
 */
function aestWallToUtc(y, m, d, hh = 0, mm = 0, ss = 0, ms = 0) {
  const wall = Date.UTC(y, m - 1, d, hh, mm, ss, ms);
  const offset = tzOffsetMs(new Date(wall));
  let utcMs = wall - offset;
  const offset2 = tzOffsetMs(new Date(utcMs));
  if (offset2 !== offset) utcMs = wall - offset2;
  return new Date(utcMs);
}

function parseKey(key) {
  const [y, m, d] = String(key).split('-').map(Number);
  if (!y || !m || !d) return null;
  return { y, m, d };
}

/** UTC instant at the *start* of a Sydney civil date (00:00:00.000 Sydney). */
function aestDayStartUtc(key) {
  const p = parseKey(key);
  if (!p) return null;
  return aestWallToUtc(p.y, p.m, p.d, 0, 0, 0, 0);
}

/** UTC instant at the *end* of a Sydney civil date (23:59:59.999 Sydney). */
function aestDayEndUtc(key) {
  const p = parseKey(key);
  if (!p) return null;
  return aestWallToUtc(p.y, p.m, p.d, 23, 59, 59, 999);
}

/** Today's Sydney civil date. */
function todayAestKey() {
  return aestDateKey(new Date());
}

module.exports = {
  AEST_TZ,
  tzOffsetMs,
  aestDateKey,
  aestTimeLabel,
  aestWallToUtc,
  aestDayStartUtc,
  aestDayEndUtc,
  todayAestKey,
};
