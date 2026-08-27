/**
 * The birthday domain rules (spec task 12.1, design §11, Req 11.3–11.8).
 *
 * PURE. No SQL, no clock reading, no I/O — every function here takes the values it
 * needs, so the leap-year substitution and the window arithmetic are testable
 * without a database and without waiting for a date to arrive.
 *
 * ── WHY THE EUROPE/LONDON DATE IS COMPUTED HERE AND BOUND AS A PARAMETER ────
 * §11.8 requires every date comparison to use `(now() AT TIME ZONE 'Europe/London')`
 * and never the server's UTC date, because between 00:00 and 01:00 BST the UTC date
 * is still yesterday — so a UTC comparison opens the window an hour late in summer
 * and a customer checking just after midnight on their birthday is told they are not
 * eligible.
 *
 * That requirement is about the TIMEZONE, not about which process does the
 * arithmetic. Deriving the London date in application code and BINDING it into every
 * statement is chosen over a `SELECT now() AT TIME ZONE …` for two concrete reasons:
 *
 *   1. A clock query has no customer to scope to, so it could not satisfy
 *      `validateScopedStatement` — the portal's own guard would have to be widened to
 *      admit an unscoped statement, and that guard is not worth weakening for a date.
 *   2. An injected clock makes the boundary cases — 00:30 BST, 31 December, 29
 *      February — ordinary unit tests rather than something only reproducible by
 *      changing the machine's time.
 *
 * The timezone conversion itself uses `Intl` with an explicit `Europe/London` zone,
 * so it honours BST/GMT transitions from the IANA database rather than a hardcoded
 * offset.
 */

/** Days the eligibility window stays open once it opens (§11.6). */
export const BIRTHDAY_WINDOW_DAYS = 14;

/** Days that must pass before a stored birthday may be changed again (§11.4). */
export const BIRTHDAY_CHANGE_LOCK_DAYS = 365;

/** A stored birthday: month and day, never a year (§11.1). */
export interface BirthdayValue {
  readonly month: number;
  readonly day: number;
}

/** One rejected field, as a CODE rather than a sentence (Req 21.7). */
export interface BirthdayFieldError {
  readonly field: "month" | "day";
  readonly code: "required" | "not_an_integer" | "out_of_range" | "invalid_day_for_month";
}

/** Longest day each month can have. February is 29 because 29 February is valid. */
const MAX_DAY_BY_MONTH: readonly number[] = [0, 31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/**
 * Validates a month/day pair, returning field CODES for anything wrong.
 *
 * ── THE SECOND OF THREE INDEPENDENT LAYERS (task 12.1) ──────────────────────
 * `zod` bounds the request shape, this function rejects impossible calendar
 * combinations, and the database `CHECK` constraint refuses them a third time. Three
 * layers rather than one because they fail at different moments: the schema before
 * the handler, this before the statement, and the constraint even if a future writer
 * bypasses both.
 *
 * 29 FEBRUARY IS VALID (§11.5). Rejecting it would tell roughly one person in 1,461
 * that their birthday does not exist. 30 February and 31 April/June/September/
 * November are refused, because those dates exist in no year at all.
 */
export function validateBirthday(month: unknown, day: unknown): readonly BirthdayFieldError[] {
  const errors: BirthdayFieldError[] = [];

  if (month === undefined || month === null) {
    errors.push({ field: "month", code: "required" });
  } else if (typeof month !== "number" || !Number.isInteger(month)) {
    errors.push({ field: "month", code: "not_an_integer" });
  } else if (month < 1 || month > 12) {
    errors.push({ field: "month", code: "out_of_range" });
  }

  if (day === undefined || day === null) {
    errors.push({ field: "day", code: "required" });
  } else if (typeof day !== "number" || !Number.isInteger(day)) {
    errors.push({ field: "day", code: "not_an_integer" });
  } else if (day < 1 || day > 31) {
    errors.push({ field: "day", code: "out_of_range" });
  }

  // The calendar check only runs once both values are individually sound —
  // otherwise "31 for month 99" would report two overlapping problems.
  if (errors.length === 0) {
    const maxDay = MAX_DAY_BY_MONTH[month as number] ?? 0;
    if ((day as number) > maxDay) {
      errors.push({ field: "day", code: "invalid_day_for_month" });
    }
  }
  return errors;
}

/** True for a Gregorian leap year. */
export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/** `YYYY-MM-DD` for a Europe/London calendar date. */
export interface LondonDate {
  readonly iso: string;
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

/**
 * The current Europe/London calendar date (§11.8).
 *
 * `en-CA` yields `YYYY-MM-DD`, which is the format the contract returns and sorts
 * lexicographically — so no reformatting step can introduce a locale bug.
 */
export function londonDateOf(now: Date): LondonDate {
  const iso = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/London",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  const [y, m, d] = iso.split("-");
  return {
    iso,
    year: Number.parseInt(y ?? "0", 10),
    month: Number.parseInt(m ?? "0", 10),
    day: Number.parseInt(d ?? "0", 10),
  };
}

/**
 * The date a birthday's window opens in a given year, applying the 29 February
 * substitution (§11.5).
 *
 * **Decision of record: store `(2, 29)` faithfully; in a non-leap year the window
 * opens on 28 FEBRUARY.** Between 28 February and 1 March the design chooses
 * 28 February so the recognition stays inside the month the customer chose — a
 * February birthday recognised in March reads as a mistake. In a leap year the date
 * is 29 February exactly.
 */
export function windowOpenDateFor(birthday: BirthdayValue, year: number): string {
  let day = birthday.day;
  if (birthday.month === 2 && birthday.day === 29 && !isLeapYear(year)) {
    day = 28;
  }
  return `${year}-${String(birthday.month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** Days between two `YYYY-MM-DD` dates, treating both as UTC midnight. */
function daysBetween(fromIso: string, toIso: string): number {
  const from = Date.parse(`${fromIso}T00:00:00Z`);
  const to = Date.parse(`${toIso}T00:00:00Z`);
  return Math.round((to - from) / 86_400_000);
}

/**
 * The window opening date that is currently RELEVANT, and whether today is inside it.
 *
 * "Relevant" is this year's opening while today is on or inside the window, and next
 * year's once the window has closed — so `windowOpensOn` always names a date the
 * customer can act on rather than one that has passed. §11.10's example shows a
 * future date beside `outside_window`, which is this rule.
 */
export function resolveWindow(
  birthday: BirthdayValue,
  today: LondonDate,
  windowDays: number = BIRTHDAY_WINDOW_DAYS,
): { readonly opensOn: string; readonly inWindow: boolean } {
  const thisYear = windowOpenDateFor(birthday, today.year);
  const elapsed = daysBetween(thisYear, today.iso);
  if (elapsed >= 0 && elapsed < windowDays) {
    return { opensOn: thisYear, inWindow: true };
  }
  if (elapsed < 0) {
    // Not yet reached this year.
    return { opensOn: thisYear, inWindow: false };
  }
  // Closed for this year; name next year's date.
  return { opensOn: windowOpenDateFor(birthday, today.year + 1), inWindow: false };
}

/** Eligibility states, as identifiers (§11.9, Req 21.7). */
export type BirthdayEligibilityState =
  | "not_set"
  | "outside_window"
  | "eligible"
  | "already_granted_this_year";

/**
 * Derives the eligibility state (§11.6).
 *
 * `already_granted_this_year` OUTRANKS `eligible`, because a customer inside their
 * window who has already been granted is not eligible again — and the grant, not the
 * window, is what carries the once-per-year guarantee.
 */
export function deriveEligibilityState(
  birthday: BirthdayValue | null,
  today: LondonDate,
  grantedThisYear: boolean,
  windowDays: number = BIRTHDAY_WINDOW_DAYS,
): BirthdayEligibilityState {
  if (birthday === null) return "not_set";
  if (grantedThisYear) return "already_granted_this_year";
  return resolveWindow(birthday, today, windowDays).inWindow ? "eligible" : "outside_window";
}

/**
 * The date after which a change is permitted, or `null` when one is allowed now.
 *
 * `changed_at + 365 days`, per §11.4. A birthday never changed has `changed_at NULL`
 * and is changeable immediately, so there is no future date to name — hence `null`
 * rather than a sentinel a client would have to recognise.
 */
export function changeAllowedFrom(
  changedAt: Date | null,
  now: Date,
  lockDays: number = BIRTHDAY_CHANGE_LOCK_DAYS,
): string | null {
  if (changedAt === null) return null;
  const unlockMs = changedAt.getTime() + lockDays * 86_400_000;
  if (unlockMs <= now.getTime()) return null;
  return londonDateOf(new Date(unlockMs)).iso;
}
