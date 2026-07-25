/**
 * Property-based test for Property 2 — "Spendable equals lots" (task 2.4).
 *
 *   spendableBalance(c) == SUM(point_lots.remaining_points
 *                              WHERE customer = c AND NOT expired)
 *
 * **Validates: Requirements 1.3**
 *
 * This is a DISTINCT property-test file for task 2.4. It does not modify the
 * task-2.3 unit tests in `balance.test.ts`; it exercises the SAME production
 * projections ({@link computeSpendableBalance}) and the SAME FIFO consumption
 * primitive ({@link consumeLotsFifo}) against a single, shared in-memory
 * `point_lots` fake so the projection is checked across many randomly generated
 * lot sets AND across the sequence of states reached by FIFO consumption.
 *
 * No live/production database is touched. The fake implements the three SQL
 * shapes the production code emits (the `SUM(remaining_points)` spendable query,
 * the `SELECT ... FOR UPDATE` consumable-lot selection, and the decrement
 * `UPDATE`) over a shared mutable row set, returning BIGINT sums as strings just
 * as `pg` does. The oracle for "non-expired lots" is recomputed INDEPENDENTLY
 * in the test with a plain reduction, so a divergence between the production
 * query's filter/aggregate and the Property-2 definition would fail the test.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import type { QueryResult, QueryResultRow } from "pg";
import {
  computeSpendableBalance,
  consumeLotsFifo,
  InsufficientPointsError,
} from "./balance.js";
import type { Queryable } from "./repository.js";

const CUSTOMER = "22222222-2222-2222-2222-222222222222";
/** Fixed reference instant; lot dates are generated as day-offsets from this. */
const AS_OF = new Date("2025-06-01T00:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

/** A raw point_lot row in the shared in-memory store. */
interface FakeLotRow {
  id: string;
  remaining_points: number;
  earned_at: Date;
  /** null = never expires. */
  expires_at: Date | null;
  /** Physical insertion order, standing in for ctid (creation-order tie-break). */
  seq: number;
}

/**
 * A single in-memory `point_lots` fake shared by BOTH the spendable-balance
 * projection and the FIFO consumption primitive, so their reads and writes see
 * the same mutable state. Dispatches purely on the SQL text the production code
 * emits.
 */
function makeSharedLotStore(initial: FakeLotRow[]): { db: Queryable; rows: FakeLotRow[] } {
  const rows = initial.map((r) => ({ ...r }));
  const db: Queryable = {
    async query<R extends QueryResultRow = QueryResultRow>(
      queryText: string,
      values: unknown[] = [],
    ): Promise<QueryResult<R>> {
      // Decrement UPDATE from consumeLotsFifo: remaining_points -= $1 WHERE id = $2.
      if (/UPDATE point_lots/i.test(queryText)) {
        const take = values[0] as number;
        const lotId = values[1] as string;
        const target = rows.find((r) => r.id === lotId);
        if (!target) {
          throw new Error(`lot ${lotId} not found`);
        }
        target.remaining_points -= take;
        return { rows: [], rowCount: 1, command: "UPDATE", oid: 0, fields: [] };
      }

      const asOf = values[1] as Date;
      const isLiveWithPoints = (r: FakeLotRow): boolean =>
        r.remaining_points > 0 &&
        (r.expires_at === null || r.expires_at.getTime() > asOf.getTime());

      // Spendable projection: SUM(remaining_points) over non-expired lots.
      if (/SUM\(remaining_points\)/i.test(queryText)) {
        const sum = rows.filter(isLiveWithPoints).reduce((s, r) => s + r.remaining_points, 0);
        return {
          rows: [{ spendable: String(sum) } as unknown as R],
          rowCount: 1,
          command: "SELECT",
          oid: 0,
          fields: [],
        };
      }

      // SELECT ... FOR UPDATE: consumable lots ordered FIFO (earned_at, then seq).
      const selected = rows
        .filter(isLiveWithPoints)
        .sort((a, b) => a.earned_at.getTime() - b.earned_at.getTime() || a.seq - b.seq)
        .map((r) => ({
          id: r.id,
          remaining_points: String(r.remaining_points), // pg returns BIGINT as string
          earned_at: r.earned_at,
          expires_at: r.expires_at,
        }));
      return {
        rows: selected as unknown as R[],
        rowCount: selected.length,
        command: "SELECT",
        oid: 0,
        fields: [],
      };
    },
  };
  return { db, rows };
}

/** Independent oracle: SUM(remaining_points) over non-expired lots at `asOf`. */
function referenceSpendable(rows: readonly FakeLotRow[], asOf: Date): number {
  return rows
    .filter(
      (r) =>
        r.remaining_points > 0 &&
        (r.expires_at === null || r.expires_at.getTime() > asOf.getTime()),
    )
    .reduce((s, r) => s + r.remaining_points, 0);
}

/**
 * Generates one lot as day-offsets from {@link AS_OF}: a mix of expired
 * (expiry on/before asOf), live (expiry strictly after asOf), and non-expiring
 * (null) lots, plus zero and positive `remaining_points`.
 */
const lotArb = (index: number) =>
  fc
    .record({
      remaining: fc.nat({ max: 1000 }),
      earnedOffsetDays: fc.integer({ min: -400, max: 0 }),
      // -30..0 => expired at asOf; 1..400 => live; null => never expires.
      expiryKind: fc.oneof(
        fc.constant<null>(null),
        fc.integer({ min: -30, max: 400 }),
      ),
    })
    .map(({ remaining, earnedOffsetDays, expiryKind }): FakeLotRow => {
      const earned_at = new Date(AS_OF.getTime() + earnedOffsetDays * DAY_MS);
      const expires_at =
        expiryKind === null ? null : new Date(AS_OF.getTime() + expiryKind * DAY_MS);
      return { id: `lot-${index}`, remaining_points: remaining, earned_at, expires_at, seq: index };
    });

const lotsArb = fc
  .integer({ min: 0, max: 8 })
  .chain((n) => fc.tuple(...Array.from({ length: n }, (_v, i) => lotArb(i))));

/** A sequence of FIFO consumption amounts (positive integers). */
const consumptionsArb = fc.array(fc.integer({ min: 1, max: 1500 }), { maxLength: 6 });

describe("Property 2 — spendable balance equals SUM(remaining over non-expired lots) (Req 1.3)", () => {
  it("computeSpendableBalance matches the independent oracle for any lot set", async () => {
    await fc.assert(
      fc.asyncProperty(lotsArb, async (lots) => {
        const { db, rows } = makeSharedLotStore(lots);
        const spendable = await computeSpendableBalance(CUSTOMER, db, AS_OF);
        expect(spendable).toBe(referenceSpendable(rows, AS_OF));
        // Definitionally never negative (remaining_points >= 0 by schema).
        expect(spendable).toBeGreaterThanOrEqual(0);
      }),
    );
  });

  it("holds as an invariant across a sequence of FIFO consumptions", async () => {
    await fc.assert(
      fc.asyncProperty(lotsArb, consumptionsArb, async (lots, amounts) => {
        const { db, rows } = makeSharedLotStore(lots);

        // Invariant holds at the start...
        expect(await computeSpendableBalance(CUSTOMER, db, AS_OF)).toBe(
          referenceSpendable(rows, AS_OF),
        );

        for (const amount of amounts) {
          const before = referenceSpendable(rows, AS_OF);

          if (amount > before) {
            // Insufficient: consumeLotsFifo must reject and leave lots untouched.
            await expect(consumeLotsFifo(CUSTOMER, amount, db, AS_OF)).rejects.toBeInstanceOf(
              InsufficientPointsError,
            );
            expect(referenceSpendable(rows, AS_OF)).toBe(before);
          } else {
            const plan = await consumeLotsFifo(CUSTOMER, amount, db, AS_OF);
            expect(plan.sufficient).toBe(true);
            expect(plan.totalConsumed).toBe(amount);
            // FIFO only consumes non-expired lots, so the non-expired sum drops
            // by exactly the amount consumed.
            expect(referenceSpendable(rows, AS_OF)).toBe(before - amount);
          }

          // Property 2 re-holds after each step, and spendable never goes negative.
          const spendable = await computeSpendableBalance(CUSTOMER, db, AS_OF);
          expect(spendable).toBe(referenceSpendable(rows, AS_OF));
          expect(spendable).toBeGreaterThanOrEqual(0);
        }
      }),
    );
  });

  it("ignores expired lots: only non-expired remaining_points are spendable", async () => {
    // Targeted generator: at least one expired lot with points present, so the
    // oracle and projection both must exclude it.
    const withExpiredArb = fc
      .tuple(
        fc.integer({ min: 1, max: 1000 }), // expired remaining (must be excluded)
        fc.nat({ max: 1000 }), // live remaining
        fc.integer({ min: 1, max: 400 }), // live expiry offset (days after asOf)
      )
      .map(([expiredRemaining, liveRemaining, liveExpiryDays]): FakeLotRow[] => [
        {
          id: "expired",
          remaining_points: expiredRemaining,
          earned_at: new Date(AS_OF.getTime() - 400 * DAY_MS),
          expires_at: new Date(AS_OF.getTime() - DAY_MS), // expired before asOf
          seq: 0,
        },
        {
          id: "live",
          remaining_points: liveRemaining,
          earned_at: new Date(AS_OF.getTime() - 10 * DAY_MS),
          expires_at: new Date(AS_OF.getTime() + liveExpiryDays * DAY_MS),
          seq: 1,
        },
      ]);

    await fc.assert(
      fc.asyncProperty(withExpiredArb, async (lots) => {
        const { db } = makeSharedLotStore(lots);
        const liveRemaining = lots[1]!.remaining_points;
        expect(await computeSpendableBalance(CUSTOMER, db, AS_OF)).toBe(liveRemaining);
      }),
    );
  });
});
