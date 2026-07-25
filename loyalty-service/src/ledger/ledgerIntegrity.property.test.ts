/**
 * Property-based test for Property 1 — "Ledger integrity" (task 2.2).
 *
 *   ∀ customer c, balance(c) == SUM(ledger_entries.points WHERE customer = c)
 *   and Balance is never independently mutable (it is a pure projection of the
 *   append-only ledger, never stored authoritatively).
 *
 * **Validates: Requirements 1.2**
 *
 * This is a DISTINCT property-test file for task 2.2 (Property 1). It is kept
 * separate from `balance.property.test.ts` (which owns task 2.4 / Property 2)
 * so the two properties never overwrite one another. It exercises the SAME
 * production writer ({@link LedgerRepository.append}) and the SAME production
 * projection ({@link computeBalance}) against a single in-memory,
 * APPEND-ONLY `ledger_entries` fake, so Property 1 is checked across many
 * randomly generated sequences of validly-signed movements spread over
 * multiple customers.
 *
 * No live/production database is touched. The fake implements exactly the SQL
 * shapes the production code emits — the append `INSERT ... RETURNING`, and the
 * `SUM(points)` balance projection — over a shared, strictly append-only row
 * set (it REJECTS any `UPDATE`/`DELETE`, mirroring the append-only ledger).
 * BIGINT sums are returned as strings, just as `pg` does. The oracle for each
 * customer's balance is recomputed INDEPENDENTLY in the test with a plain
 * reduction, so any divergence between the production `SUM` projection and the
 * Property-1 definition would fail the test.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import type { QueryResult, QueryResultRow } from "pg";
import {
  AppendOnlyViolationError,
  EARN_ENTRY_TYPES,
  DEBIT_ENTRY_TYPES,
  LEDGER_ENTRY_TYPES,
  LedgerRepository,
  type LedgerEntryType,
  type Queryable,
} from "./repository.js";
import { computeBalance } from "./balance.js";

/** A fixed pool of customers so movements spread across several customers. */
const CUSTOMERS = [
  "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
  "cccccccc-cccc-cccc-cccc-cccccccccccc",
  "dddddddd-dddd-dddd-dddd-dddddddddddd",
] as const;

const EARN_SET = new Set<string>(EARN_ENTRY_TYPES);
const DEBIT_SET = new Set<string>(DEBIT_ENTRY_TYPES);

/** A row physically stored in the append-only fake. */
interface StoredLedgerRow extends QueryResultRow {
  id: string;
  customer_id: string;
  entry_type: string;
  points: string; // pg returns BIGINT as a string
  reason: string;
  order_reference: string | null;
  point_lot_id: string | null;
  redemption_id: string | null;
  source_event_id: string | null;
  created_at: Date;
}

/**
 * An in-memory, strictly APPEND-ONLY `ledger_entries` fake. It accepts the
 * repository's `INSERT ... RETURNING`, answers the `SUM(points)` balance
 * projection filtered by customer, and REJECTS any `UPDATE`/`DELETE` — so there
 * is no way to mutate a balance except by appending a new signed row, and the
 * balance itself is never stored (there is no balance column). This mirrors the
 * append-only ledger of Requirement 1.
 */
function makeAppendOnlyLedger(): { db: Queryable; rows: StoredLedgerRow[] } {
  const rows: StoredLedgerRow[] = [];
  let nextId = 1;
  const db: Queryable = {
    async query<R extends QueryResultRow = QueryResultRow>(
      queryText: string,
      values: unknown[] = [],
    ): Promise<QueryResult<R>> {
      if (/INSERT INTO ledger_entries/i.test(queryText)) {
        const [customerId, entryType, points, reason, orderRef, lotId, redemptionId, sourceEventId] =
          values;
        const row: StoredLedgerRow = {
          id: `ledger-${String(nextId++).padStart(6, "0")}`,
          customer_id: customerId as string,
          entry_type: entryType as string,
          points: String(points), // stored/returned as string, like pg BIGINT
          reason: reason as string,
          order_reference:
            orderRef === null || orderRef === undefined ? null : String(orderRef),
          point_lot_id: (lotId as string | null) ?? null,
          redemption_id: (redemptionId as string | null) ?? null,
          source_event_id: (sourceEventId as string | null) ?? null,
          created_at: new Date("2025-01-01T00:00:00.000Z"),
        };
        rows.push(row);
        return { rows: [row as unknown as R], rowCount: 1, command: "INSERT", oid: 0, fields: [] };
      }

      // The ledger is append-only: no existing row may be updated or deleted.
      if (/^\s*(UPDATE|DELETE)\b/i.test(queryText)) {
        throw new Error(
          "append-only ledger: UPDATE/DELETE of ledger_entries is not permitted",
        );
      }

      // Balance projection: SUM(points) for one customer.
      if (/SUM\(points\)/i.test(queryText)) {
        const customerId = values[0] as string;
        const sum = rows
          .filter((r) => r.customer_id === customerId)
          .reduce((s, r) => s + Number(r.points), 0);
        return {
          rows: [{ balance: String(sum) } as unknown as R],
          rowCount: 1,
          command: "SELECT",
          oid: 0,
          fields: [],
        };
      }

      throw new Error(`unexpected query against append-only ledger fake: ${queryText}`);
    },
  };
  return { db, rows };
}

/** A single validly-signed movement for one customer. */
interface Movement {
  customerId: string;
  entryType: LedgerEntryType;
  points: number;
  reason: string;
}

/** Applies the correct sign for an entry type (Req 1.4/1.5): earns > 0, debits < 0. */
function signedPoints(entryType: LedgerEntryType, magnitude: number, adjustPositive: boolean): number {
  if (EARN_SET.has(entryType)) {
    return magnitude; // earn_* strictly positive
  }
  if (DEBIT_SET.has(entryType)) {
    return -magnitude; // spend / clawback / expire strictly negative
  }
  // adjust / migration may carry either sign, but must be non-zero.
  return adjustPositive ? magnitude : -magnitude;
}

/** Generates one validly-signed movement assigned to a customer in the pool. */
const movementArb: fc.Arbitrary<Movement> = fc
  .record({
    customerId: fc.constantFrom(...CUSTOMERS),
    entryType: fc.constantFrom(...LEDGER_ENTRY_TYPES),
    // Bounded so cumulative sums stay well inside the safe-integer range.
    magnitude: fc.integer({ min: 1, max: 1_000_000 }),
    adjustPositive: fc.boolean(),
  })
  .map(({ customerId, entryType, magnitude, adjustPositive }) => ({
    customerId,
    entryType,
    points: signedPoints(entryType, magnitude, adjustPositive),
    reason: `${entryType} movement`,
  }));

/**
 * Generates a sequence of movements together with a same-length array of random
 * sort keys used to derive an INDEPENDENT append order, so the property can
 * assert append-order-independence of the projection.
 */
const movementsArb = fc
  .array(movementArb, { maxLength: 40 })
  .chain((movements) =>
    fc.tuple(
      fc.constant(movements),
      fc.array(fc.integer(), { minLength: movements.length, maxLength: movements.length }),
    ),
  );

/** Independent oracle: per-customer SUM(points) computed with a plain reduction. */
function expectedBalances(movements: readonly Movement[]): Map<string, number> {
  const balances = new Map<string, number>();
  for (const mv of movements) {
    balances.set(mv.customerId, (balances.get(mv.customerId) ?? 0) + mv.points);
  }
  return balances;
}

/** Appends every movement through the REAL repository against a fresh fake. */
async function appendAll(
  repo: LedgerRepository,
  movements: readonly Movement[],
): Promise<void> {
  for (const mv of movements) {
    await repo.append({
      customerId: mv.customerId,
      entryType: mv.entryType,
      points: mv.points,
      reason: mv.reason,
    });
  }
}

/** Reorders movements by zipping with random keys and stable-sorting on them. */
function reorderBy(movements: readonly Movement[], keys: readonly number[]): Movement[] {
  return movements
    .map((mv, i) => ({ mv, key: keys[i]!, i }))
    .sort((a, b) => a.key - b.key || a.i - b.i)
    .map(({ mv }) => mv);
}

describe("Property 1 — ledger integrity: balance(c) == SUM(ledger points for c) (Req 1.2)", () => {
  it("balance equals the independent per-customer ledger sum for every customer", async () => {
    await fc.assert(
      fc.asyncProperty(movementsArb, async ([movements]) => {
        const { db } = makeAppendOnlyLedger();
        const repo = new LedgerRepository(db);
        await appendAll(repo, movements);

        const expected = expectedBalances(movements);
        for (const customer of CUSTOMERS) {
          const balance = await computeBalance(customer, db);
          // A customer with no movements projects to 0 (COALESCE).
          expect(balance).toBe(expected.get(customer) ?? 0);
        }
      }),
    );
  });

  it("isolates customers: no customer's balance leaks into another's", async () => {
    await fc.assert(
      fc.asyncProperty(movementsArb, async ([movements]) => {
        const { db } = makeAppendOnlyLedger();
        const repo = new LedgerRepository(db);
        await appendAll(repo, movements);

        // The sum of every per-customer balance must equal the grand total of
        // all appended points — no double counting and no cross-customer leak.
        const grandTotal = movements.reduce((s, mv) => s + mv.points, 0);
        let summedBalances = 0;
        for (const customer of CUSTOMERS) {
          summedBalances += await computeBalance(customer, db);
        }
        expect(summedBalances).toBe(grandTotal);

        // A customer that received no movement has a strictly zero balance.
        const touched = new Set(movements.map((mv) => mv.customerId));
        for (const customer of CUSTOMERS) {
          if (!touched.has(customer)) {
            expect(await computeBalance(customer, db)).toBe(0);
          }
        }
      }),
    );
  });

  it("is a pure projection: recomputation is idempotent and append-order-independent", async () => {
    await fc.assert(
      fc.asyncProperty(movementsArb, async ([movements, keys]) => {
        // Store 1: append in the generated order.
        const first = makeAppendOnlyLedger();
        await appendAll(new LedgerRepository(first.db), movements);

        // Store 2: append the SAME multiset in an independently-derived order.
        const reordered = reorderBy(movements, keys);
        const second = makeAppendOnlyLedger();
        await appendAll(new LedgerRepository(second.db), reordered);

        for (const customer of CUSTOMERS) {
          const a1 = await computeBalance(customer, first.db);
          const a2 = await computeBalance(customer, first.db);
          // Idempotent: recomputing the projection yields the same value.
          expect(a2).toBe(a1);
          // Order-independent: append order does not change the projection.
          const b = await computeBalance(customer, second.db);
          expect(b).toBe(a1);
        }
      }),
    );
  });

  it("has no independently-mutable balance: only appended rows exist and update/remove are rejected", async () => {
    await fc.assert(
      fc.asyncProperty(movementsArb, async ([movements]) => {
        const { db, rows } = makeAppendOnlyLedger();
        const repo = new LedgerRepository(db);
        await appendAll(repo, movements);

        // The store holds exactly the appended rows — nothing more, and no
        // stored balance: balance only ever comes from SUM(points).
        expect(rows).toHaveLength(movements.length);
        for (const row of rows) {
          expect(row).not.toHaveProperty("balance");
        }

        // The append-only contract: there is no sanctioned mutation path.
        expect(() => repo.update()).toThrow(AppendOnlyViolationError);
        expect(() => repo.remove()).toThrow(AppendOnlyViolationError);

        // Even a raw UPDATE/DELETE against the ledger is rejected, so a balance
        // can never be mutated in place — it can only change by appending a new
        // signed row, after which the projection reflects it exactly.
        await expect(
          db.query("UPDATE ledger_entries SET points = 0 WHERE customer_id = $1", [CUSTOMERS[0]]),
        ).rejects.toThrow(/append-only/i);
        await expect(
          db.query("DELETE FROM ledger_entries WHERE customer_id = $1", [CUSTOMERS[0]]),
        ).rejects.toThrow(/append-only/i);

        // The projection still matches the independent oracle after the rejected
        // mutation attempts (the ledger is unchanged).
        const expected = expectedBalances(movements);
        for (const customer of CUSTOMERS) {
          expect(await computeBalance(customer, db)).toBe(expected.get(customer) ?? 0);
        }
      }),
    );
  });
});
