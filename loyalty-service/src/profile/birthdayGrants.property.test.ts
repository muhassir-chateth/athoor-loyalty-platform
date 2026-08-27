// Feature: customer-experience-portal, Property 9: Birthday changes cannot multiply rewards
/**
 * PROPERTY 9 — spec task 12.3. Validates Requirements 11.3, 11.5, 11.6, 11.7.
 *
 * The property: NO sequence of birthday changes, elapsed-time jumps or grant attempts
 * can produce more than one grant per customer per Europe/London calendar year.
 *
 * ── WHY THIS IS THE ABUSE THAT MATTERS ──────────────────────────────────────
 * The obvious attack is to set a birthday, take the gift, then move the birthday
 * forward and take another. Design §5 lists three independent layers against it, and
 * this property exercises all three at once:
 *   (i)   at most one change per 365 days, enforced by a conditional UPDATE;
 *   (ii)  at most one grant per (customer_id, grant_year), enforced by UNIQUE;
 *   (iii) the grant keys on grant_year, NEVER on the birthday value, so a changed
 *         birthday cannot retroactively grant in a year already granted (Req 11.7).
 *
 * Layer (iii) is the subtle one: if the grant were keyed on the birthday, changing it
 * would present a "new" birthday the guard had never seen. Keying on the year means
 * the birthday is irrelevant to the guarantee.
 *
 * The fake enforces the same PRIMARY KEY and the same conditional-UPDATE semantics
 * Postgres does, so a property that passes here is a property about the statements
 * rather than about the fake.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import type { QueryResult, QueryResultRow } from "pg";
import type { Queryable } from "../ledger/repository.js";
import type { CustomerScope } from "../auth/customerScope.js";
import {
  changeBirthdayIfUnlocked,
  claimGrantForYear,
  createBirthdayIfAbsent,
  hasGrantForYear,
  readBirthday,
} from "../portal/repository/birthday.js";
import { BIRTHDAY_CHANGE_LOCK_DAYS } from "./birthday.js";

const CUSTOMER_A = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const CUSTOMER_B = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const SCOPE_A = { customerId: CUSTOMER_A } as unknown as CustomerScope;
const SCOPE_B = { customerId: CUSTOMER_B } as unknown as CustomerScope;

/**
 * A Postgres stand-in for `customer_birthdays` and `birthday_grants`.
 *
 * Enforces `customer_birthdays PRIMARY KEY (customer_id)` and `birthday_grants
 * PRIMARY KEY (customer_id, grant_year)` exactly, and evaluates the conditional
 * UPDATE's predicate against the STORED row at statement time — which is what makes
 * "two concurrent changes cannot both win" a property of the statement rather than of
 * the test's ordering. An injected clock drives `now()`.
 */
class FakeBirthdayDb implements Queryable {
  readonly birthdays = new Map<string, { month: number; day: number; changedAt: Date | null }>();
  readonly grants = new Set<string>();
  now = new Date("2026-01-01T12:00:00Z");

  advanceDays(days: number): void {
    this.now = new Date(this.now.getTime() + days * 86_400_000);
  }

  async query<R extends QueryResultRow = QueryResultRow>(
    sql: string,
    values: unknown[] = [],
  ): Promise<QueryResult<R>> {
    const q = sql.trim();
    if (/ledger_entries|point_lots|redemptions/i.test(q)) {
      throw new Error(`FakeBirthdayDb: the birthday path must never touch the ledger: ${q}`);
    }
    const customerId = String(values[0] ?? "");
    const ok = (rows: QueryResultRow[], rowCount = rows.length): QueryResult<R> => ({
      rows: rows as R[],
      rowCount,
      command: "SELECT",
      oid: 0,
      fields: [],
    });

    // Longest table name first — `birthday_grants` and `customer_birthdays` share no
    // prefix, but the habit is cheap and task 9.1 was caught three times without it.
    if (q.startsWith("INSERT INTO birthday_grants")) {
      const key = `${customerId}|${String(values[1])}`;
      if (this.grants.has(key)) return ok([], 0); // ON CONFLICT DO NOTHING
      this.grants.add(key);
      return ok([], 1);
    }
    if (q.includes("FROM birthday_grants")) {
      return ok(this.grants.has(`${customerId}|${String(values[1])}`) ? [{ one: 1 }] : []);
    }
    if (q.startsWith("INSERT INTO customer_birthdays")) {
      if (this.birthdays.has(customerId)) return ok([], 0); // ON CONFLICT DO NOTHING
      this.birthdays.set(customerId, {
        month: Number(values[1]),
        day: Number(values[2]),
        changedAt: null,
      });
      return ok([], 1);
    }
    if (q.startsWith("UPDATE customer_birthdays")) {
      const row = this.birthdays.get(customerId);
      if (!row) return ok([], 0);
      const lockDays = Number(values[3]);
      // `coalesce(changed_at, 'epoch')` — a never-changed row is always changeable.
      const effective = row.changedAt ?? new Date(0);
      const threshold = new Date(this.now.getTime() - lockDays * 86_400_000);
      if (effective.getTime() > threshold.getTime()) return ok([], 0); // the lock held
      this.birthdays.set(customerId, {
        month: Number(values[1]),
        day: Number(values[2]),
        changedAt: this.now,
      });
      return ok([], 1);
    }
    if (q.includes("FROM customer_birthdays")) {
      const row = this.birthdays.get(customerId);
      return ok(
        row ? [{ birth_month: row.month, birth_day: row.day, changed_at: row.changedAt }] : [],
      );
    }
    throw new Error(`FakeBirthdayDb: unknown statement: ${q}`);
  }
}

const monthDay = fc
  .tuple(fc.integer({ min: 1, max: 12 }), fc.integer({ min: 1, max: 28 }))
  .map(([month, day]) => ({ month, day }));

/** Includes 29 February explicitly — the value the substitution rule exists for. */
const monthDayWithLeap = fc.oneof(monthDay, fc.constant({ month: 2, day: 29 }));

type Op =
  | { kind: "change"; birthday: { month: number; day: number } }
  | { kind: "grant"; year: number }
  | { kind: "advance"; days: number };

const op: fc.Arbitrary<Op> = fc.oneof(
  monthDayWithLeap.map((birthday) => ({ kind: "change", birthday }) as Op),
  fc.integer({ min: 2026, max: 2028 }).map((year) => ({ kind: "grant", year }) as Op),
  fc.integer({ min: 1, max: 500 }).map((days) => ({ kind: "advance", days }) as Op),
);

describe("Property 9: birthday changes cannot multiply rewards", () => {
  it("yields AT MOST ONE grant per customer per year, for any sequence", async () => {
    await fc.assert(
      fc.asyncProperty(
        monthDayWithLeap,
        fc.array(op, { minLength: 1, maxLength: 30 }),
        async (initial, ops) => {
          const db = new FakeBirthdayDb();
          await createBirthdayIfAbsent(db, SCOPE_A, initial);

          // COUNT THE SUCCESSFUL CLAIMS, not the rows. Counting rows would be
          // vacuous: `grants` is a Set keyed on customer|year, so it cannot hold the
          // same key twice no matter how broken the code under test is. The claim
          // returning `true` is what would authorise an award, so the number of
          // `true`s per year is the quantity that must never exceed one.
          const awardsAuthorisedPerYear = new Map<number, number>();
          let grantAttempts = 0;

          for (const o of ops) {
            if (o.kind === "advance") {
              db.advanceDays(o.days);
            } else if (o.kind === "change") {
              await changeBirthdayIfUnlocked(db, SCOPE_A, o.birthday, BIRTHDAY_CHANGE_LOCK_DAYS);
            } else {
              grantAttempts += 1;
              if (await claimGrantForYear(db, SCOPE_A, o.year)) {
                awardsAuthorisedPerYear.set(o.year, (awardsAuthorisedPerYear.get(o.year) ?? 0) + 1);
              }
            }
          }

          // AT MOST ONE authorised award per year, across the whole interleaving of
          // changes, time jumps and repeated claims (Req 11.6).
          for (const [year, count] of awardsAuthorisedPerYear) {
            expect(count, `authorised awards in ${year}`).toBe(1);
          }
          // Repeated attempts cannot outrun the constraint: however many times the
          // sequence asked, at most one per distinct year was granted.
          expect(
            [...awardsAuthorisedPerYear.values()].reduce((a, b) => a + b, 0),
          ).toBeLessThanOrEqual(Math.min(grantAttempts, 3)); // 3 distinct years generated
          // Every stored grant is this customer's, and matches an authorisation.
          expect(db.grants.size).toBe(awardsAuthorisedPerYear.size);
          for (const key of db.grants) {
            expect(key.startsWith(`${CUSTOMER_A}|`)).toBe(true);
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it("a changed birthday cannot grant again in a year already granted (Req 11.7)", async () => {
    // Layer (iii). The grant keys on grant_year, never on the birthday value, so
    // presenting a "new" birthday cannot present a new key.
    await fc.assert(
      fc.asyncProperty(
        monthDayWithLeap,
        monthDayWithLeap,
        fc.integer({ min: 2026, max: 2028 }),
        async (first, second, year) => {
          const db = new FakeBirthdayDb();
          await createBirthdayIfAbsent(db, SCOPE_A, first);
          expect(await claimGrantForYear(db, SCOPE_A, year)).toBe(true);

          // Wait out the change lock, change the birthday, and try again.
          db.advanceDays(BIRTHDAY_CHANGE_LOCK_DAYS + 1);
          await changeBirthdayIfUnlocked(db, SCOPE_A, second, BIRTHDAY_CHANGE_LOCK_DAYS);

          expect(await claimGrantForYear(db, SCOPE_A, year)).toBe(false);
          expect([...db.grants].filter((k) => k === `${CUSTOMER_A}|${year}`)).toHaveLength(1);
        },
      ),
      { numRuns: 150 },
    );
  });

  it("N concurrent grant attempts in one year produce exactly ONE winner", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 2, max: 8 }), async (attempts) => {
        const db = new FakeBirthdayDb();
        await createBirthdayIfAbsent(db, SCOPE_A, { month: 6, day: 10 });
        const results = await Promise.all(
          Array.from({ length: attempts }, () => claimGrantForYear(db, SCOPE_A, 2026)),
        );
        expect(results.filter(Boolean)).toHaveLength(1);
        expect(db.grants.size).toBe(1);
      }),
      { numRuns: 150 },
    );
  });

  it("N concurrent CHANGES produce exactly one winner, and a rejected change stores nothing", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(monthDayWithLeap, { minLength: 2, maxLength: 6 }),
        async (candidates) => {
          const db = new FakeBirthdayDb();
          await createBirthdayIfAbsent(db, SCOPE_A, { month: 1, day: 1 });
          // Past the lock, so exactly one change is permitted.
          db.advanceDays(BIRTHDAY_CHANGE_LOCK_DAYS + 1);

          const results = await Promise.all(
            candidates.map((b) => changeBirthdayIfUnlocked(db, SCOPE_A, b, BIRTHDAY_CHANGE_LOCK_DAYS)),
          );
          expect(results.filter(Boolean)).toHaveLength(1);

          // The stored value is one of the candidates — a losing change wrote nothing.
          const stored = await readBirthday(db, SCOPE_A);
          expect(candidates).toContainEqual(stored?.birthday);
        },
      ),
      { numRuns: 150 },
    );
  });

  it("a REJECTED change leaves the stored record byte-identical", async () => {
    await fc.assert(
      fc.asyncProperty(monthDayWithLeap, monthDayWithLeap, async (initial, attempted) => {
        const db = new FakeBirthdayDb();
        await createBirthdayIfAbsent(db, SCOPE_A, initial);
        // First change consumes the allowance.
        db.advanceDays(BIRTHDAY_CHANGE_LOCK_DAYS + 1);
        await changeBirthdayIfUnlocked(db, SCOPE_A, initial, BIRTHDAY_CHANGE_LOCK_DAYS);
        const before = await readBirthday(db, SCOPE_A);

        // A second change inside the lock must be refused and must change nothing.
        db.advanceDays(10);
        expect(
          await changeBirthdayIfUnlocked(db, SCOPE_A, attempted, BIRTHDAY_CHANGE_LOCK_DAYS),
        ).toBe(false);
        const after = await readBirthday(db, SCOPE_A);
        expect(after?.birthday).toEqual(before?.birthday);
        expect(after?.changedAt?.getTime()).toBe(before?.changedAt?.getTime());
      }),
      { numRuns: 150 },
    );
  });

  it("grants are isolated per customer — A's grant never blocks B", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 2026, max: 2028 }), async (year) => {
        const db = new FakeBirthdayDb();
        await createBirthdayIfAbsent(db, SCOPE_A, { month: 6, day: 10 });
        await createBirthdayIfAbsent(db, SCOPE_B, { month: 6, day: 10 });

        expect(await claimGrantForYear(db, SCOPE_A, year)).toBe(true);
        // B has never been granted, so B wins their own year.
        expect(await claimGrantForYear(db, SCOPE_B, year)).toBe(true);
        expect(await hasGrantForYear(db, SCOPE_A, year)).toBe(true);
        expect(await hasGrantForYear(db, SCOPE_B, year)).toBe(true);
        expect(db.grants.size).toBe(2);
      }),
      { numRuns: 100 },
    );
  });

  it("A cannot change or read B's birthday", async () => {
    const db = new FakeBirthdayDb();
    await createBirthdayIfAbsent(db, SCOPE_B, { month: 3, day: 3 });
    // A has no row of their own, so A's read is null and A's change affects nothing.
    expect(await readBirthday(db, SCOPE_A)).toBeNull();
    expect(await changeBirthdayIfUnlocked(db, SCOPE_A, { month: 9, day: 9 }, 365)).toBe(false);
    expect(db.birthdays.get(CUSTOMER_B)).toMatchObject({ month: 3, day: 3 });
  });

  it("no path through the birthday repository touches the ledger", async () => {
    // The fake throws on any ledger statement, so reaching the end proves it.
    const db = new FakeBirthdayDb();
    await createBirthdayIfAbsent(db, SCOPE_A, { month: 2, day: 29 });
    db.advanceDays(BIRTHDAY_CHANGE_LOCK_DAYS + 1);
    await changeBirthdayIfUnlocked(db, SCOPE_A, { month: 3, day: 1 }, BIRTHDAY_CHANGE_LOCK_DAYS);
    await claimGrantForYear(db, SCOPE_A, 2027);
    await hasGrantForYear(db, SCOPE_A, 2027);
    await readBirthday(db, SCOPE_A);
    expect(db.grants.size).toBe(1);
  });
});
