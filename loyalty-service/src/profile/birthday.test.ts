/**
 * Task 12.4 — birthday unit tests (design §11.3/§11.5/§11.8/§11.4, Req 11.3, 11.8, 11.9).
 *
 * The calendar table, the Europe/London boundary, and the `allowedFrom` arithmetic.
 * All pure — no database, no waiting for a date to arrive.
 */
import { describe, expect, it } from "vitest";
import {
  BIRTHDAY_CHANGE_LOCK_DAYS,
  BIRTHDAY_WINDOW_DAYS,
  changeAllowedFrom,
  deriveEligibilityState,
  isLeapYear,
  londonDateOf,
  resolveWindow,
  validateBirthday,
  windowOpenDateFor,
} from "./birthday.js";

describe("validateBirthday — the calendar table (Req 11.3, §11.3)", () => {
  it("ACCEPTS 29 February", () => {
    // Rejecting it would tell roughly one person in 1,461 their birthday does not
    // exist. The database CHECK permits it too.
    expect(validateBirthday(2, 29)).toEqual([]);
  });

  it("REJECTS 30 February", () => {
    expect(validateBirthday(2, 30)).toEqual([{ field: "day", code: "invalid_day_for_month" }]);
  });

  it("REJECTS the 31st of April, June, September and November", () => {
    for (const month of [4, 6, 9, 11]) {
      expect(validateBirthday(month, 31), `month ${month}`).toEqual([
        { field: "day", code: "invalid_day_for_month" },
      ]);
      // The 30th of those months is fine.
      expect(validateBirthday(month, 30), `month ${month} day 30`).toEqual([]);
    }
  });

  it("accepts the 31st of every 31-day month", () => {
    for (const month of [1, 3, 5, 7, 8, 10, 12]) {
      expect(validateBirthday(month, 31), `month ${month}`).toEqual([]);
    }
  });

  it("returns CODES, never sentences (Req 21.7)", () => {
    for (const [m, d] of [
      [0, 1],
      [13, 1],
      [1, 0],
      [1, 32],
    ] as const) {
      for (const err of validateBirthday(m, d)) {
        expect(err.code).toMatch(/^[a-z][a-z_]*$/);
        expect(err.code).not.toContain(" ");
      }
    }
  });

  it("rejects non-integers and missing values without inventing a default", () => {
    expect(validateBirthday(1.5, 1)).toEqual([{ field: "month", code: "not_an_integer" }]);
    expect(validateBirthday("2", 1)).toEqual([{ field: "month", code: "not_an_integer" }]);
    expect(validateBirthday(undefined, undefined)).toEqual([
      { field: "month", code: "required" },
      { field: "day", code: "required" },
    ]);
    expect(validateBirthday(null, 1)).toEqual([{ field: "month", code: "required" }]);
  });

  it("does not report an overlapping calendar error when a bound already failed", () => {
    // "31 for month 99" should say the month is out of range, not also guess about
    // the day for a month that does not exist.
    expect(validateBirthday(99, 31)).toEqual([{ field: "month", code: "out_of_range" }]);
  });
});

describe("isLeapYear / windowOpenDateFor — the 29 February substitution (§11.5)", () => {
  it("knows the Gregorian rule, including the century cases", () => {
    expect(isLeapYear(2024)).toBe(true);
    expect(isLeapYear(2027)).toBe(false);
    expect(isLeapYear(1900)).toBe(false);
    expect(isLeapYear(2000)).toBe(true);
  });

  it("opens on 29 February in a leap year", () => {
    expect(windowOpenDateFor({ month: 2, day: 29 }, 2028)).toBe("2028-02-29");
  });

  it("substitutes 28 FEBRUARY in a non-leap year, not 1 March", () => {
    // The design chooses 28 February so the recognition stays inside the month the
    // customer chose; a February birthday recognised in March reads as a mistake.
    expect(windowOpenDateFor({ month: 2, day: 29 }, 2027)).toBe("2027-02-28");
    expect(windowOpenDateFor({ month: 2, day: 29 }, 2027)).not.toBe("2027-03-01");
  });

  it("leaves every other date untouched in both leap and non-leap years", () => {
    for (const year of [2027, 2028]) {
      expect(windowOpenDateFor({ month: 2, day: 28 }, year)).toBe(`${year}-02-28`);
      expect(windowOpenDateFor({ month: 3, day: 1 }, year)).toBe(`${year}-03-01`);
      expect(windowOpenDateFor({ month: 12, day: 31 }, year)).toBe(`${year}-12-31`);
    }
  });
});

describe("londonDateOf — Europe/London, never UTC (Req 11.8, §11.8)", () => {
  it("reports the LONDON date at 00:30 BST, when the UTC date is still yesterday", () => {
    // THE CASE THE REQUIREMENT EXISTS FOR. 2026-06-15T23:30Z is 00:30 on the 16th in
    // London (BST, UTC+1). A UTC comparison would say the 15th and open a customer's
    // window an hour late — telling them on their birthday that they are not eligible.
    const utc = new Date("2026-06-15T23:30:00Z");
    expect(utc.toISOString().slice(0, 10)).toBe("2026-06-15");
    expect(londonDateOf(utc).iso).toBe("2026-06-16");
  });

  it("agrees with UTC in winter, when London is GMT", () => {
    const utc = new Date("2026-01-15T23:30:00Z");
    expect(londonDateOf(utc).iso).toBe("2026-01-15");
  });

  it("puts 00:30 BST on 1 January in the NEW year, so grant_year follows the customer", () => {
    // §11.8: "a grant taken at 00:30 on 1 January belongs to the new year in the
    // customer's own reckoning". January is GMT, so this is the year-boundary case.
    const justAfterMidnight = new Date("2027-01-01T00:30:00Z");
    expect(londonDateOf(justAfterMidnight).year).toBe(2027);
    // And 23:30 on 31 December is still the old year.
    expect(londonDateOf(new Date("2026-12-31T23:30:00Z")).year).toBe(2026);
  });

  it("returns YYYY-MM-DD, which sorts lexicographically", () => {
    const d = londonDateOf(new Date("2026-03-05T12:00:00Z"));
    expect(d.iso).toBe("2026-03-05");
    expect(d).toMatchObject({ year: 2026, month: 3, day: 5 });
  });
});

describe("resolveWindow — 14 days, and always a date the customer can act on", () => {
  const bday = { month: 6, day: 10 };

  it("is inside the window on the birthday itself and on day 13", () => {
    expect(resolveWindow(bday, londonDateOf(new Date("2026-06-10T12:00:00Z")))).toEqual({
      opensOn: "2026-06-10",
      inWindow: true,
    });
    expect(resolveWindow(bday, londonDateOf(new Date("2026-06-23T12:00:00Z"))).inWindow).toBe(true);
  });

  it("closes on day 14 — the window is 14 days, not 15", () => {
    expect(resolveWindow(bday, londonDateOf(new Date("2026-06-24T12:00:00Z"))).inWindow).toBe(false);
    expect(BIRTHDAY_WINDOW_DAYS).toBe(14);
  });

  it("names NEXT year's date once this year's window has closed", () => {
    // §11.10's example shows a future date beside `outside_window`: a date already
    // passed is not something the customer can act on.
    expect(resolveWindow(bday, londonDateOf(new Date("2026-08-01T12:00:00Z")))).toEqual({
      opensOn: "2027-06-10",
      inWindow: false,
    });
  });

  it("names THIS year's date while it is still ahead", () => {
    expect(resolveWindow(bday, londonDateOf(new Date("2026-01-05T12:00:00Z")))).toEqual({
      opensOn: "2026-06-10",
      inWindow: false,
    });
  });

  it("applies the 28 February substitution when resolving the next window", () => {
    const feb29 = { month: 2, day: 29 };
    // 2027 is not a leap year, so the window opens on the 28th.
    expect(resolveWindow(feb29, londonDateOf(new Date("2027-02-28T12:00:00Z")))).toEqual({
      opensOn: "2027-02-28",
      inWindow: true,
    });
    // Late 2027 looks forward to 2028, which IS a leap year.
    expect(resolveWindow(feb29, londonDateOf(new Date("2027-12-01T12:00:00Z"))).opensOn).toBe(
      "2028-02-29",
    );
  });
});

describe("deriveEligibilityState (§11.6, Req 11.6)", () => {
  const today = londonDateOf(new Date("2026-06-12T12:00:00Z"));

  it("is not_set with no birthday", () => {
    expect(deriveEligibilityState(null, today, false)).toBe("not_set");
  });

  it("is eligible inside the window with no grant", () => {
    expect(deriveEligibilityState({ month: 6, day: 10 }, today, false)).toBe("eligible");
  });

  it("is outside_window when the window is not open", () => {
    expect(deriveEligibilityState({ month: 1, day: 1 }, today, false)).toBe("outside_window");
  });

  it("already_granted_this_year OUTRANKS eligible", () => {
    // A customer inside their window who has already been granted is not eligible
    // again — the grant, not the window, carries the once-per-year guarantee.
    expect(deriveEligibilityState({ month: 6, day: 10 }, today, true)).toBe(
      "already_granted_this_year",
    );
  });
});

describe("changeAllowedFrom — the 365-day lock arithmetic (§11.4, Req 11.9)", () => {
  it("is null when never changed — there is no future date to name", () => {
    expect(changeAllowedFrom(null, new Date("2026-06-01T00:00:00Z"))).toBeNull();
  });

  it("names changed_at + 365 days while the lock holds", () => {
    const changedAt = new Date("2026-04-02T10:00:00Z");
    const allowed = changeAllowedFrom(changedAt, new Date("2026-06-01T00:00:00Z"));
    expect(allowed).toBe("2027-04-02");
  });

  it("is null once 365 days have elapsed", () => {
    const changedAt = new Date("2025-04-02T10:00:00Z");
    expect(changeAllowedFrom(changedAt, new Date("2026-06-01T00:00:00Z"))).toBeNull();
  });

  it("is null exactly at the boundary, not one day late", () => {
    const changedAt = new Date("2026-01-01T00:00:00Z");
    const exactly = new Date(changedAt.getTime() + BIRTHDAY_CHANGE_LOCK_DAYS * 86_400_000);
    expect(changeAllowedFrom(changedAt, exactly)).toBeNull();
    const oneMsEarlier = new Date(exactly.getTime() - 1);
    expect(changeAllowedFrom(changedAt, oneMsEarlier)).not.toBeNull();
  });

  it("uses 365 days, matching the SQL predicate", () => {
    expect(BIRTHDAY_CHANGE_LOCK_DAYS).toBe(365);
  });
});
