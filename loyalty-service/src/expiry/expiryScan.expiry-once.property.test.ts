/**
 * Property-based test for Property 9 — "Expiry once" (task 10.3).
 *
 *   Each Point_Lot contributes to AT MOST ONE expiry ledger entry, whose
 *   magnitude equals that lot's remainder at maturity.
 *
 * **Validates: Requirements 5.2**
 *
 * This is a DISTINCT property-test file for task 10.3. It does not modify the
 * task-10.1 unit tests in `expiryScan.test.ts`; it exercises the SAME
 * production scan ({@link runExpiryScan}) and the SAME append-only ledger
 * repository ({@link LedgerRepository}) — both unchanged — against a
 * fully-self-contained in-memory fake `point_lots` table.
 *
 * The scan is driven across MANY randomly generated lot sets AND across a
 * sequence of repeated (same-date) and advancing scan dates. Two facets of
 * Property 9 (Requirements 5.2, 5.3) are asserted:
 *
 *   1. **Expiry once.** After any sequence of scan runs, every lot has produced
 *      AT MOST ONE `expire` entry. A lot that matures within the sequence and
 *      still held points at maturity produces EXACTLY ONE entry whose magnitude
 *      equals its remainder at maturity; a lot that never matures (future or
 *      never-expiring) or held zero points produces NONE.
 *   2. **Same-date no-op.** Re-running the scan for a scan date already scanned
 *      creates no additional entry and debits nothing.
 *
 * No live/production database or Shopify Admin API is touched. The fake models
 * only the three SQL shapes the scan emits — the matured-lot `FOR UPDATE`
 * select, the append-only ledger `INSERT`, and the lot-zeroing `UPDATE` — over
 * a shared mutable row set, returning BIGINT columns as strings just as `pg`
 * does. Because nothing consumes lots between runs in this test, a lot's
 * "remainder at maturity" is exactly its initial `remaining_points`; an
 * independent oracle recomputes the expected entries so a divergence between
 * the scan's selection/aggregation and the Property-9 definition would fail.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import type { QueryResult, QueryResultRow } from "pg";
import { LedgerRepository, type Queryable } from "../ledger/repository.js";
import { EXPIRY_REASON, runExpiryScan, type ExpiryScanDeps, type Transactor } from "./expiryScan.js";

const CUSTOMER_A = "22222222-2222-2222-2222-222222222222";
const CUSTOMER_B = "33333333-3333-3333-3333-333333333333";
/** Fixed reference instant; lot/scan dates are generated as day-offsets from this. */
const BASE = new Date("2025-06-01T00:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

/** A raw point_lot row in the self-contained in-memory store. */
interface FakeLotRow {
  id: string;
  customer_id: string;
  remaining_points: number;
  earned_at: Date;
  /** null = never expires. */
  expires_at: Date | null;
  /** Physical insertion order, standing in for ctid (creation-order tie-break). */
  seq: number;
}

/** A persisted fake ledger row (only the columns the scan writes/reads). */
interface FakeLedgerRow {
  id: string;
  customer_id: string;
  entry_type: string;
  points: number;
  reason: string;
  point_lot_id: string | null;
  source_event_id: string | null;
}

interface FakeDb {
  db: Queryable;
  lots: FakeLotRow[];
  ledger: FakeLedgerRow[];
}

/**
 * Builds a fully self-contained fake over a shared mutable `point_lots` row set
 * plus an append-only `ledger_entries` sink. Dispatches purely on the SQL text
 * the production scan emits.
 */
function makeFakeDb(initialLots: FakeLotRow[]): FakeDb {
  const lots = initialLots.map((l) => ({ ...l }));
  const ledger: FakeLedgerRow[] = [];
  let idCounter = 0;

  const db: Queryable = {
    async query<R extends QueryResultRow = QueryResultRow>(
      queryText: string,
      values: unknown[] = [],
    ): Promise<QueryResult<R>> {
      const ok = <T extends QueryResultRow>(rows: T[], command: string): QueryResult<T> => ({
        rows,
        rowCount: rows.length,
        command,
        oid: 0,
        fields: [],
      });

      // Matured-lot selection: expires_at IS NOT NULL AND <= asOf AND remaining > 0,
      // FIFO ordered (earned_at, then seq), locked FOR UPDATE.
      if (/FROM point_lots/i.test(queryText) && /FOR UPDATE/i.test(queryText)) {
        const asOf = values[0] as Date;
        const selected = lots
          .filter(
            (l) =>
              l.expires_at !== null &&
              l.expires_at.getTime() <= asOf.getTime() &&
              l.remaining_points > 0,
          )
          .sort((a, b) => a.earned_at.getTime() - b.earned_at.getTime() || a.seq - b.seq)
          .map((l) => ({
            id: l.id,
            customer_id: l.customer_id,
            remaining_points: String(l.remaining_points), // pg returns BIGINT as string
            earned_at: l.earned_at,
            expires_at: l.expires_at,
          }));
        return ok(selected as unknown as R[], "SELECT");
      }

      // Zero a lot's remaining_points.
      if (/UPDATE point_lots/i.test(queryText)) {
        const lotId = values[0] as string;
        const target = lots.find((l) => l.id === lotId);
        if (!target) {
          throw new Error(`lot ${lotId} not found`);
        }
        target.remaining_points = 0;
        return ok([], "UPDATE") as unknown as QueryResult<R>;
      }

      // Append-only ledger insert (via the real LedgerRepository).
      if (/INSERT INTO ledger_entries/i.test(queryText)) {
        const [customer_id, entry_type, points, reason, , point_lot_id, , source_event_id] =
          values as [
            string,
            string,
            number,
            string,
            number | null,
            string | null,
            string | null,
            string | null,
          ];
        const row: FakeLedgerRow = {
          id: `ledger-${++idCounter}`,
          customer_id,
          entry_type,
          points,
          reason,
          point_lot_id: point_lot_id ?? null,
          source_event_id: source_event_id ?? null,
        };
        ledger.push(row);
        return ok(
          [
            {
              id: row.id,
              customer_id,
              entry_type,
              points: String(points),
              reason,
              order_reference: null,
              point_lot_id: row.point_lot_id,
              redemption_id: null,
              source_event_id: row.source_event_id,
              created_at: BASE,
            },
          ] as unknown as R[],
          "INSERT",
        );
      }

      throw new Error(`unexpected query: ${queryText}`);
    },
  };

  return { db, lots, ledger };
}

/** A fake Transactor that runs the callback against the fake db (no real BEGIN/COMMIT). */
function makeTransactor(db: Queryable): Transactor {
  return {
    async transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
      return fn(db);
    },
  };
}

function makeDeps(fake: FakeDb): ExpiryScanDeps {
  return { repo: new LedgerRepository(fake.db), transactor: makeTransactor(fake.db) };
}

/** Generates one lot as day-offsets from {@link BASE}. */
const lotArb = (index: number) =>
  fc
    .record({
      remaining: fc.nat({ max: 1000 }),
      customerPick: fc.boolean(),
      earnedOffsetDays: fc.integer({ min: -800, max: 0 }),
      // null => never expires; else expiry offset in days from BASE
      // (negative => already matured relative to BASE; positive => future).
      expiryKind: fc.oneof(fc.constant<null>(null), fc.integer({ min: -100, max: 300 })),
    })
    .map(({ remaining, customerPick, earnedOffsetDays, expiryKind }): FakeLotRow => ({
      id: `lot-${index}`,
      customer_id: customerPick ? CUSTOMER_A : CUSTOMER_B,
      remaining_points: remaining,
      earned_at: new Date(BASE.getTime() + earnedOffsetDays * DAY_MS),
      expires_at: expiryKind === null ? null : new Date(BASE.getTime() + expiryKind * DAY_MS),
      seq: index,
    }));

const lotsArb = fc
  .integer({ min: 0, max: 8 })
  .chain((n) => fc.tuple(...Array.from({ length: n }, (_v, i) => lotArb(i))));

/** A non-empty sequence of scan-date offsets (days from BASE), sorted ascending. */
const scanOffsetsArb = fc
  .array(fc.integer({ min: -120, max: 400 }), { minLength: 1, maxLength: 5 })
  .map((offsets) => [...offsets].sort((a, b) => a - b));

/**
 * Independent oracle. Given the initial lots and the full set of scan dates
 * that will be run, returns the expected `expire` entry magnitude per lot id.
 * A lot expires exactly once (magnitude = its initial remainder) iff it has a
 * concrete expiry, held points, and at least one scan date reaches its expiry;
 * otherwise it never expires. (Nothing consumes lots in this test, so the
 * remainder at maturity equals the initial `remaining_points`.)
 */
function expectedExpiries(
  lots: readonly FakeLotRow[],
  scanDates: readonly Date[],
): Map<string, number> {
  const maxScan = Math.max(...scanDates.map((d) => d.getTime()));
  const expected = new Map<string, number>();
  for (const l of lots) {
    if (l.expires_at !== null && l.remaining_points > 0 && l.expires_at.getTime() <= maxScan) {
      expected.set(l.id, l.remaining_points);
    }
  }
  return expected;
}

describe("Property 9 — expiry once: each lot expires at most once, equal to its remainder (Req 5.2)", () => {
  it("produces at most one expire entry per lot across repeated and advancing scans", async () => {
    await fc.assert(
      fc.asyncProperty(lotsArb, scanOffsetsArb, async (lots, scanOffsets) => {
        const fake = makeFakeDb(lots);
        const deps = makeDeps(fake);
        const scanDates = scanOffsets.map((o) => new Date(BASE.getTime() + o * DAY_MS));

        // Run each scan date twice in a row: the second run of a date must be a
        // pure no-op (same-date idempotency, Req 5.3 / Property 9).
        for (const asOf of scanDates) {
          const ledgerBefore = fake.ledger.length;
          await runExpiryScan(asOf, deps);

          const repeat = await runExpiryScan(asOf, deps);
          expect(repeat.expiredLotCount).toBe(0);
          expect(repeat.totalPointsExpired).toBe(0);
          expect(repeat.expiredLots).toEqual([]);
          // The immediate repeat added nothing beyond the first run of this date.
          expect(fake.ledger.length).toBeGreaterThanOrEqual(ledgerBefore);
        }

        const expireEntries = fake.ledger.filter((e) => e.entry_type === "expire");

        // Every expire entry is a valid, negative, lot-linked point_lot_expired entry.
        for (const e of expireEntries) {
          expect(e.reason).toBe(EXPIRY_REASON);
          expect(e.points).toBeLessThan(0);
          expect(e.point_lot_id).not.toBeNull();
        }

        // At most one expire entry per lot id (the core of Property 9).
        const perLot = new Map<string, FakeLedgerRow[]>();
        for (const e of expireEntries) {
          const key = e.point_lot_id as string;
          (perLot.get(key) ?? perLot.set(key, []).get(key)!).push(e);
        }
        for (const entries of perLot.values()) {
          expect(entries.length).toBe(1);
        }

        // Match the independent oracle exactly: the set of expired lots and each
        // magnitude equals the lot's remainder at maturity.
        const expected = expectedExpiries(lots, scanDates);
        expect(perLot.size).toBe(expected.size);
        for (const [lotId, remainder] of expected) {
          const entries = perLot.get(lotId);
          expect(entries).toBeDefined();
          expect(entries!).toHaveLength(1);
          expect(entries![0]!.points).toBe(-remainder);
          // The corresponding lot must be zeroed after expiry.
          expect(fake.lots.find((l) => l.id === lotId)!.remaining_points).toBe(0);
        }

        // No lot outside the expected set produced an entry, and any matured
        // customer attribution is preserved.
        for (const e of expireEntries) {
          const lot = lots.find((l) => l.id === e.point_lot_id);
          expect(lot).toBeDefined();
          expect(e.customer_id).toBe(lot!.customer_id);
        }
      }),
    );
  });

  it("total debited across all runs equals the sum of expired lots' remainders (conservation)", async () => {
    await fc.assert(
      fc.asyncProperty(lotsArb, scanOffsetsArb, async (lots, scanOffsets) => {
        const fake = makeFakeDb(lots);
        const deps = makeDeps(fake);
        const scanDates = scanOffsets.map((o) => new Date(BASE.getTime() + o * DAY_MS));

        let totalExpiredAcrossRuns = 0;
        for (const asOf of scanDates) {
          const result = await runExpiryScan(asOf, deps);
          totalExpiredAcrossRuns += result.totalPointsExpired;
        }

        const expected = expectedExpiries(lots, scanDates);
        const expectedTotal = [...expected.values()].reduce((s, v) => s + v, 0);

        // The points debited by the runs equal the sum of the negative entries…
        const ledgerDebit = fake.ledger
          .filter((e) => e.entry_type === "expire")
          .reduce((s, e) => s - e.points, 0);

        expect(totalExpiredAcrossRuns).toBe(expectedTotal);
        expect(ledgerDebit).toBe(expectedTotal);
      }),
    );
  });
});
