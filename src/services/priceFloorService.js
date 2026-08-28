/**
 * QUALIFICATION PRICE FLOORS — the executive minimum an application may be
 * closed for.
 *
 * The client's rule: an exec sets a floor on a qualification, and nobody can
 * discount an application for it below that number. So the floor is a CAP ON
 * DISCOUNTING expressed as a price, and this module owns both halves of it:
 *
 *  · `sanitizeFloor` — what may be stored, written ONLY through the dedicated
 *    Admin/CEO endpoint. Every other write path strips the field, or the floor
 *    would be editable by the same payload it is supposed to constrain.
 *  · `assertDiscountAllowed` / `assertCaPriceAllowed` — the two gates. One stops
 *    an application being discounted under the floor, the other stops the
 *    qualification's own list price being dropped under it (otherwise the floor
 *    would be trivially bypassed by re-pricing the catalog instead).
 *
 * PRICE MODEL: `Application` has no price field. The sale price is
 * `qualification.caPrice − Σ application.discounts[].amount`, and that total
 * includes the automatic $500 signup discount written at registration. So the
 * floor is compared against the discounted figure, not the list price.
 *
 * REGISTRATION IS NEVER BLOCKED. The signup discount is applied automatically
 * when a student signs up; refusing it would break public sign-up for anyone
 * whose floor sits above `caPrice − 500`. Such an application simply starts
 * already at or under its floor, and every FURTHER discount is refused — the
 * same grandfathering the rest of this rule uses.
 */
const AppError = require('../utils/AppError');

const money = (n) => `$${Number(n || 0).toLocaleString('en-AU')}`;

const toNumber = (v) => {
  if (v === '' || v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** Total already discounted off an application. */
const discountTotal = (application) =>
  (application?.discounts || []).reduce((sum, d) => sum + (Number(d.amount) || 0), 0);

/** What the student is actually being charged right now. */
const effectivePrice = (qualification, application) =>
  Math.max(0, Number(qualification?.caPrice || 0) - discountTotal(application));

/** The floor on a qualification, or null when unrestricted. */
const floorOf = (qualification) => {
  const n = toNumber(qualification?.priceFloor);
  return n === null || n < 0 ? null : n;
};

/**
 * How much more may still be discounted before hitting the floor.
 * `null` when there is no floor (i.e. no cap beyond the price itself).
 */
function remainingDiscountAllowance(qualification, application) {
  const floor = floorOf(qualification);
  if (floor === null) return null;
  return Math.max(0, effectivePrice(qualification, application) - floor);
}

/** Normalise a floor payload: a non-negative number, or null to clear it. */
function sanitizeFloor(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = toNumber(value);
  if (n === null || n < 0) throw new AppError('Price floor must be a positive amount', 400);
  return n;
}

/**
 * Throw 400 if adding `amount` would take this application under its floor.
 * A discount that leaves the price exactly ON the floor is allowed.
 */
function assertDiscountAllowed(qualification, application, amount) {
  const floor = floorOf(qualification);
  if (floor === null) return;
  const current = effectivePrice(qualification, application);
  const next = current - (Number(amount) || 0);
  if (next >= floor) return;

  const allowance = Math.max(0, current - floor);
  throw new AppError(
    allowance > 0
      ? `That discount would take this application to ${money(next)}, below the ${money(floor)} minimum set by management for this qualification. The most you can still discount is ${money(allowance)}.`
      : `This application is already at the ${money(floor)} minimum set by management for this qualification, so no further discount can be applied.`,
    400,
  );
}

/**
 * Throw 400 if a qualification's list price would be saved under its own floor.
 * Only checked when caPrice is actually changing, so a floor raised above an
 * existing price doesn't block unrelated edits to the qualification.
 */
function assertCaPriceAllowed(existing, incomingCaPrice) {
  const floor = floorOf(existing);
  if (floor === null) return;
  const next = toNumber(incomingCaPrice);
  if (next === null) return;
  if (Number(existing?.caPrice) === next) return;
  if (next >= floor) return;
  throw new AppError(
    `Price ${money(next)} is below the ${money(floor)} minimum set by management for this qualification. Ask an executive to lower the floor first.`,
    400,
  );
}

module.exports = {
  sanitizeFloor,
  assertDiscountAllowed,
  assertCaPriceAllowed,
  remainingDiscountAllowance,
  effectivePrice,
  discountTotal,
  floorOf,
};
