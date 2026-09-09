/**
 * QUALIFICATION PRICE THRESHOLDS — the executive minimum an application may be
 * closed for (the FLOOR), and the price management is happy to close it at
 * (the SWEET SPOT).
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
 * THE SWEET SPOT ENFORCES NOTHING. It is a target: a sale at or above it is
 * badged "Sweet Spot" on the student detail page, and that is its entire effect.
 * What it does carry is an invariant — `priceFloor <= sweetSpot <= caPrice`
 * (`assertThresholdsCoherent`) — because a sweet spot under the floor would
 * badge every legal sale and one above the list price could never be reached.
 * That invariant is why the two are written together through one endpoint, and
 * why a caPrice change is checked against BOTH.
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

/** The sweet-spot target on a qualification, or null when none is set. */
const sweetSpotOf = (qualification) => {
  const n = toNumber(qualification?.sweetSpot);
  return n === null || n < 0 ? null : n;
};

/** True when this application's sale price has reached the qualification's target. */
const isAtSweetSpot = (qualification, application) => {
  const target = sweetSpotOf(qualification);
  if (target === null) return false;
  return effectivePrice(qualification, application) >= target;
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

/** Normalise a sweet-spot payload: a non-negative number, or null to clear it. */
function sanitizeSweetSpot(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = toNumber(value);
  if (n === null || n < 0) throw new AppError('Sweet spot must be a positive amount', 400);
  return n;
}

/**
 * Enforce `floor <= sweetSpot <= caPrice` on a proposed set of numbers.
 * Any of the three may be null/undefined — an absent threshold constrains
 * nothing. Returns nothing; throws 400 with the reason that failed.
 */
function assertThresholdsCoherent({ caPrice, priceFloor, sweetSpot }) {
  const price = toNumber(caPrice);
  const floor = toNumber(priceFloor);
  const target = toNumber(sweetSpot);

  if (floor !== null && price !== null && floor > price) {
    throw new AppError(
      `The floor cannot be above this qualification's price of ${money(price)}. Raise the price first, or set a lower floor.`,
      400,
    );
  }
  if (target !== null && price !== null && target > price) {
    throw new AppError(
      `The sweet spot cannot be above this qualification's price of ${money(price)} — no sale could ever reach it.`,
      400,
    );
  }
  // Strictly greater: a sweet spot ON the floor would badge every sale the
  // floor already allows, which tells an exec nothing.
  if (target !== null && floor !== null && target <= floor) {
    throw new AppError(
      `The sweet spot must be above the ${money(floor)} minimum price. It marks a good sale, so it has to sit higher than the least you will accept.`,
      400,
    );
  }
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
 * Why a qualification's list price may NOT move to `incomingCaPrice`, or null
 * when it may. Non-throwing so a BULK adjust can skip the offending rows and
 * report them instead of failing the whole run; `assertCaPriceAllowed` is the
 * throwing wrapper the single-qualification PATCH uses.
 *
 * Only checked when caPrice is actually changing, so a threshold raised above
 * an existing price doesn't block unrelated edits to the qualification.
 */
function caPriceChangeBlockedBecause(existing, incomingCaPrice) {
  const next = toNumber(incomingCaPrice);
  if (next === null) return null;
  if (Number(existing?.caPrice) === next) return null;

  const floor = floorOf(existing);
  if (floor !== null && next < floor) {
    return `${money(next)} is below the ${money(floor)} minimum price set for this qualification.`;
  }
  // The sweet spot is only a target, but a target above the list price can
  // never be reached — so a price drop under it is a config error either way.
  const target = sweetSpotOf(existing);
  if (target !== null && next < target) {
    return `${money(next)} is below the ${money(target)} sweet spot set for this qualification.`;
  }
  return null;
}

/** Throw 400 if a qualification's list price would break either threshold. */
function assertCaPriceAllowed(existing, incomingCaPrice) {
  const reason = caPriceChangeBlockedBecause(existing, incomingCaPrice);
  if (!reason) return;
  throw new AppError(
    `${reason} Ask an executive to adjust the pricing thresholds first.`,
    400,
  );
}

module.exports = {
  sanitizeFloor,
  sanitizeSweetSpot,
  assertThresholdsCoherent,
  assertDiscountAllowed,
  assertCaPriceAllowed,
  caPriceChangeBlockedBecause,
  remainingDiscountAllowance,
  effectivePrice,
  discountTotal,
  floorOf,
  sweetSpotOf,
  isAtSweetSpot,
};
