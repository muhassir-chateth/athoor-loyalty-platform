/**
 * Unit tests for portal-visit state (task 14.6).
 *
 * NO live/production database or Shopify Admin API is touched. `markPortalVisit`
 * is exercised against a stateful in-memory fake {@link Queryable} that models
 * the off-ledger `portal_visits` table and the atomic
 * `INSERT ... ON CONFLICT DO UPDATE ... RETURNING (xmax = 0)` upsert, including
 * the first-visit (INSERT) vs returning (DO UPDATE) discriminator.
 *
 * Covers (Requirements 16.1, 16.2):
 *   - first call for a customer records the visit and reports firstVisit=true,
 *     stamping first_visited_at and last_visited_at (Req 16.1);
 *   - a subsequent call reports firstVisit=false, preserves first_visited_at,
 *     and advances last_visited_at (Req 16.2);
 *   - visits are tracked independently per customer;
 *   - the upsert writes ONLY to portal_visits (off-ledger, Req 17.3);
 *   - input validation and DB-failure handling leave state unchanged.
 */
import { describe, expect, it } from "vitest";
import type { QueryResult, QueryResultRow } from "pg";
import type { Queryable } from "../ledger/repository.js";
import {
  markPortalVisit,
  PortalVisitMarkError,
  PortalVisitValidationError,
} from "./portalVisit.js";

/* --------------------------------- fakes ---------------------------------- */

interface StoredVisit {
  customer_id: string;
  first_visited_at: Date;
  last_visited_at: Date;
}

interface FakeDb {
  db: Queryable;
  visits: Map<string, StoredVisit>;
  statements: string[];
  /** Monotonic clock so each write yields a strictly later `now()`. */
  tick: () => Date;
}

/**
 * Builds a fake Queryable modelling the `portal_visits` upsert. A monotonic
 * clock backs `now()` so first_visited_at (set on INSERT) and last_visited_at
 * (advanced on UPDATE) can be compared for ordering in assertions.
 */
function makeDb(startMs = Date.UTC(2025, 0, 1)): FakeDb {
  const visits = new Map<string, StoredVisit>();
  const statements: string[] = [];
  let clock = startMs;
  const tick = (): Date => {
    clock += 1000;
    return new Date(clock);
  };

  const ok = <T extends QueryResultRow>(rows: T[]): QueryResult<T> => ({
    rows,
    rowCount: rows.length,
    command: "INSERT",
    oid: 0,
    fields: [],
  });

  const db: Queryable = {
    async query<R extends QueryResultRow = QueryResultRow>(
      text: string,
      values: unknown[] = [],
    ): Promise<QueryResult<R>> {
      statements.push(text.trim());

      if (/INSERT INTO portal_visits/i.test(text)) {
        const customerId = values[0] as string;
        const existing = visits.get(customerId);
        if (!existing) {
          // INSERT branch: xmax = 0 → first_visit true.
          const now = tick();
          const stored: StoredVisit = {
            customer_id: customerId,
            first_visited_at: now,
            last_visited_at: now,
          };
          visits.set(customerId, stored);
          return ok([
            {
              first_visit: true,
              first_visited_at: stored.first_visited_at,
              last_visited_at: stored.last_visited_at,
            },
          ] as unknown as R[]);
        }
        // DO UPDATE branch: xmax <> 0 → first_visit false; advance last_visited_at.
        existing.last_visited_at = tick();
        return ok([
          {
            first_visit: false,
            first_visited_at: existing.first_visited_at,
            last_visited_at: existing.last_visited_at,
          },
        ] as unknown as R[]);
      }

      throw new Error(`unexpected query: ${text}`);
    },
  };

  return { db, visits, statements, tick };
}

const CUST = "11111111-1111-1111-1111-111111111111";
const OTHER = "22222222-2222-2222-2222-222222222222";

/* ------------------------------ first visit ------------------------------- */

describe("markPortalVisit: first visit (Req 16.1)", () => {
  it("records the visit and reports firstVisit=true with both timestamps stamped", async () => {
    const fake = makeDb();

    const result = await markPortalVisit(CUST, fake.db);

    expect(result.firstVisit).toBe(true);
    // First visit stamps first_visited_at and last_visited_at to the same instant.
    expect(result.firstVisitedAt).toEqual(result.lastVisitedAt);

    const stored = fake.visits.get(CUST);
    expect(stored).toBeDefined();
    expect(stored!.first_visited_at).toEqual(result.firstVisitedAt);
    expect(stored!.last_visited_at).toEqual(result.lastVisitedAt);
  });
});

/* ---------------------------- returning member ---------------------------- */

describe("markPortalVisit: returning member (Req 16.2)", () => {
  it("reports firstVisit=false, preserves first_visited_at, and advances last_visited_at", async () => {
    const fake = makeDb();

    const first = await markPortalVisit(CUST, fake.db);
    expect(first.firstVisit).toBe(true);

    const second = await markPortalVisit(CUST, fake.db);

    expect(second.firstVisit).toBe(false);
    // The originally recorded first visit is preserved.
    expect(second.firstVisitedAt).toEqual(first.firstVisitedAt);
    // last_visited_at is advanced to the returning visit's instant.
    expect(second.lastVisitedAt.getTime()).toBeGreaterThan(first.lastVisitedAt.getTime());

    // Still exactly one row for the customer.
    expect(fake.visits.size).toBe(1);
    expect(fake.visits.get(CUST)!.first_visited_at).toEqual(first.firstVisitedAt);
  });

  it("keeps reporting firstVisit=false on every visit after the first", async () => {
    const fake = makeDb();

    await markPortalVisit(CUST, fake.db);
    const outcomes = [
      await markPortalVisit(CUST, fake.db),
      await markPortalVisit(CUST, fake.db),
      await markPortalVisit(CUST, fake.db),
    ];

    expect(outcomes.every((o) => o.firstVisit === false)).toBe(true);
  });
});

/* --------------------------- per-customer state --------------------------- */

describe("markPortalVisit: independent per customer", () => {
  it("treats each customer's first visit independently", async () => {
    const fake = makeDb();

    const firstForCust = await markPortalVisit(CUST, fake.db);
    const firstForOther = await markPortalVisit(OTHER, fake.db);

    expect(firstForCust.firstVisit).toBe(true);
    // A different customer's first visit is still a first visit.
    expect(firstForOther.firstVisit).toBe(true);

    const returningCust = await markPortalVisit(CUST, fake.db);
    expect(returningCust.firstVisit).toBe(false);

    expect(fake.visits.size).toBe(2);
  });
});

/* ------------------------------- off-ledger ------------------------------- */

describe("markPortalVisit: off-ledger (Req 17.3)", () => {
  it("writes ONLY to portal_visits and never to ledger_entries", async () => {
    const fake = makeDb();

    await markPortalVisit(CUST, fake.db);
    await markPortalVisit(CUST, fake.db);

    expect(fake.statements.length).toBeGreaterThan(0);
    expect(fake.statements.every((s) => /portal_visits/i.test(s))).toBe(true);
    expect(fake.statements.some((s) => /ledger_entries/i.test(s))).toBe(false);
  });
});

/* -------------------------------- errors ---------------------------------- */

describe("markPortalVisit: input validation and failure handling", () => {
  it("rejects an empty/blank customer id without issuing any query", async () => {
    const fake = makeDb();

    await expect(markPortalVisit("", fake.db)).rejects.toBeInstanceOf(PortalVisitValidationError);
    await expect(markPortalVisit("   ", fake.db)).rejects.toBeInstanceOf(PortalVisitValidationError);

    expect(fake.statements.length).toBe(0);
    expect(fake.visits.size).toBe(0);
  });

  it("wraps a DB failure in PortalVisitMarkError", async () => {
    const failing: Queryable = {
      async query() {
        throw new Error("connection reset");
      },
    };

    await expect(markPortalVisit(CUST, failing)).rejects.toBeInstanceOf(PortalVisitMarkError);
  });

  it("throws PortalVisitMarkError when the upsert returns no row", async () => {
    const emptyReturning: Queryable = {
      async query<R extends QueryResultRow = QueryResultRow>(): Promise<QueryResult<R>> {
        return { rows: [], rowCount: 0, command: "INSERT", oid: 0, fields: [] };
      },
    };

    await expect(markPortalVisit(CUST, emptyReturning)).rejects.toBeInstanceOf(PortalVisitMarkError);
  });
});
