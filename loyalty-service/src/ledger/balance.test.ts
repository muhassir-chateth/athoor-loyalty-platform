/**
 * Unit tests for balance / spendable-balance projection and FIFO lot
 * consumption (task 2.3).
 *
 * No live/production database is touched. Balance and Spendable_Balance are
 * verified against a fake {@link Queryable} that asserts the SQL shape and
 * returns a canned aggregate row (as `pg` would: BIGINT/NUMERIC sums come back
 * as strings). FIFO consumption is verified both as a pure planner and against
 * a stateful in-memory point_lots fake, so the append-only / decrement-only
 * contract and Req 5.6 ordering are exercised without any Postgres. Applying
 * against a real database is deferred to deploy time.
 *
 * Covers: Req 1.2 (Balance = SUM(ledger)), Req 1.3 (Spendable = SUM(remaining
 * over non-expired lots)), Req 5.6 (FIFO oldest-first, tie-break by creation
 * order, only lots with remaining > 0), Req 5.7 (insufficient leaves lots
 * unchanged).
 */
import { describe, expect, it } from "vitest";
import type { QueryResult, QueryResultRow } from "pg";
import {
  computeBalance,
  computeSpendableBalance,
  consumeLotsFifo,
  InsufficientPointsError,
  LotConsumptionValidationError,
  orderLotsFifo,
  planFifoConsumption,
  type FifoLot,
} from "./balance.js";
import type { Queryable } from "./repository.js";

const CUSTOMER = "11111111-1111-1111-1111-111111111111";

interface Captured {
  queryText: string;
  values: unknown[];
}

/**
 * A fake Queryable that returns a single canned row for the next query and
 * records every call. Used for the SUM projections.
 */
function makeAggregateDb(row: QueryResultRow): { db: Queryable; calls: Captured[] } {
  const calls: Captured[] = [];
  const db: Queryable = {
    async query<R extends QueryResultRow = QueryResultRow>(
      queryText: string,
      values: unknown[] = [],
    ): Promise<QueryResult<R>> {
      calls.push({ queryText, values });
      return { rows: [row as unknown as R], rowCount: 1, command: "SELECT", oid: 0, fields: [] };
    },
  };
  return { db, calls };
}

function lot(overrides: Partial<FifoLot> & Pick<FifoLot, "id" | "remainingPoints">): FifoLot {
  return {
    earnedAt: new Date("2025-01-01T00:00:00.000Z"),
    expiresAt: null,
    creationOrder: 0,
    ...overrides,
  };
}

describe("computeBalance: Balance = SUM(ledger_entries.points) (Req 1.2, Property 1)", () => {
  it("sums the customer's ledger entries via SUM(points)", async () => {
    const { db, calls } = makeAggregateDb({ balance: "150" });
    const balance = await computeBalance(CUSTOMER, db);

    expect(balance).toBe(150);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.queryText).toContain("SUM(points)");
    expect(calls[0]!.queryText).toContain("FROM ledger_entries");
    expect(calls[0]!.values).toEqual([CUSTOMER]);
  });

  it("parses a BIGINT sum returned as a string into a number", async () => {
    const { db } = makeAggregateDb({ balance: "1234" });
    const balance = await computeBalance(CUSTOMER, db);
    expect(balance).toBe(1234);
    expect(typeof balance).toBe("number");
  });

  it("returns 0 for a customer with no ledger entries (COALESCE)", async () => {
    const { db } = makeAggregateDb({ balance: "0" });
    expect(await computeBalance(CUSTOMER, db)).toBe(0);
  });

  it("handles a net-negative balance", async () => {
    const { db } = makeAggregateDb({ balance: "-25" });
    expect(await computeBalance(CUSTOMER, db)).toBe(-25);
  });
});

describe("computeSpendableBalance: SUM(remaining_points) over non-expired lots (Req 1.3, Property 2)", () => {
  it("sums remaining_points and filters to non-expired lots", async () => {
    const asOf = new Date("2025-06-01T00:00:00.000Z");
    const { db, calls } = makeAggregateDb({ spendable: "300" });

    const spendable = await computeSpendableBalance(CUSTOMER, db, asOf);

    expect(spendable).toBe(300);
    expect(calls[0]!.queryText).toContain("SUM(remaining_points)");
    expect(calls[0]!.queryText).toContain("FROM point_lots");
    expect(calls[0]!.queryText).toContain("remaining_points > 0");
    expect(calls[0]!.queryText).toContain("expires_at IS NULL OR expires_at >");
    expect(calls[0]!.values).toEqual([CUSTOMER, asOf]);
  });

  it("returns 0 when the customer holds no non-expired lots (COALESCE)", async () => {
    const { db } = makeAggregateDb({ spendable: "0" });
    expect(await computeSpendableBalance(CUSTOMER, db)).toBe(0);
  });

  it("defaults asOf to now when omitted", async () => {
    const { db, calls } = makeAggregateDb({ spendable: "10" });
    await computeSpendableBalance(CUSTOMER, db);
    expect(calls[0]!.values[1]).toBeInstanceOf(Date);
  });
});

describe("orderLotsFifo: oldest-first, tie-break by creation order (Req 5.6)", () => {
  it("orders by ascending earned_at", () => {
    const older = lot({ id: "old", remainingPoints: 10, earnedAt: new Date("2025-01-01T00:00:00Z") });
    const newer = lot({ id: "new", remainingPoints: 10, earnedAt: new Date("2025-03-01T00:00:00Z") });
    const ordered = orderLotsFifo([newer, older]);
    expect(ordered.map((l) => l.id)).toEqual(["old", "new"]);
  });

  it("breaks ties on identical earned_at by ascending creationOrder", () => {
    const at = new Date("2025-01-01T00:00:00Z");
    const first = lot({ id: "first", remainingPoints: 10, earnedAt: at, creationOrder: 0 });
    const second = lot({ id: "second", remainingPoints: 10, earnedAt: at, creationOrder: 1 });
    const ordered = orderLotsFifo([second, first]);
    expect(ordered.map((l) => l.id)).toEqual(["first", "second"]);
  });

  it("does not mutate the input array", () => {
    const a = lot({ id: "a", remainingPoints: 1, earnedAt: new Date("2025-02-01T00:00:00Z") });
    const b = lot({ id: "b", remainingPoints: 1, earnedAt: new Date("2025-01-01T00:00:00Z") });
    const input = [a, b];
    orderLotsFifo(input);
    expect(input.map((l) => l.id)).toEqual(["a", "b"]);
  });
});

describe("planFifoConsumption: greedy oldest-first allocation (Req 5.6)", () => {
  it("consumes a single lot partially", () => {
    const lots = [lot({ id: "l1", remainingPoints: 100 })];
    const plan = planFifoConsumption(lots, 30);
    expect(plan.sufficient).toBe(true);
    expect(plan.totalConsumed).toBe(30);
    expect(plan.shortfall).toBe(0);
    expect(plan.allocations).toEqual([
      { lotId: "l1", take: 30, remainingBefore: 100, remainingAfter: 70 },
    ]);
  });

  it("spans multiple lots oldest-first, fully draining the first", () => {
    const lots = [
      lot({ id: "old", remainingPoints: 40, earnedAt: new Date("2025-01-01T00:00:00Z") }),
      lot({ id: "new", remainingPoints: 100, earnedAt: new Date("2025-02-01T00:00:00Z") }),
    ];
    const plan = planFifoConsumption(lots, 60);
    expect(plan.sufficient).toBe(true);
    expect(plan.allocations).toEqual([
      { lotId: "old", take: 40, remainingBefore: 40, remainingAfter: 0 },
      { lotId: "new", take: 20, remainingBefore: 100, remainingAfter: 80 },
    ]);
  });

  it("respects creation-order tie-break across equal earned_at lots", () => {
    const at = new Date("2025-01-01T00:00:00Z");
    const lots = [
      lot({ id: "second", remainingPoints: 50, earnedAt: at, creationOrder: 1 }),
      lot({ id: "first", remainingPoints: 50, earnedAt: at, creationOrder: 0 }),
    ];
    const plan = planFifoConsumption(lots, 60);
    expect(plan.allocations.map((a) => a.lotId)).toEqual(["first", "second"]);
    expect(plan.allocations[0]).toMatchObject({ lotId: "first", take: 50 });
    expect(plan.allocations[1]).toMatchObject({ lotId: "second", take: 10 });
  });

  it("skips lots with remaining_points <= 0 (Req 5.6)", () => {
    const lots = [
      lot({ id: "empty", remainingPoints: 0, earnedAt: new Date("2025-01-01T00:00:00Z") }),
      lot({ id: "full", remainingPoints: 100, earnedAt: new Date("2025-02-01T00:00:00Z") }),
    ];
    const plan = planFifoConsumption(lots, 25);
    expect(plan.allocations).toEqual([
      { lotId: "full", take: 25, remainingBefore: 100, remainingAfter: 75 },
    ]);
  });

  it("consumes exactly to the last available point", () => {
    const lots = [lot({ id: "l1", remainingPoints: 100 })];
    const plan = planFifoConsumption(lots, 100);
    expect(plan.sufficient).toBe(true);
    expect(plan.allocations[0]).toMatchObject({ take: 100, remainingAfter: 0 });
  });

  it("reports a shortfall (not sufficient) when lots cannot cover the amount", () => {
    const lots = [
      lot({ id: "a", remainingPoints: 30 }),
      lot({ id: "b", remainingPoints: 20, earnedAt: new Date("2025-02-01T00:00:00Z") }),
    ];
    const plan = planFifoConsumption(lots, 100);
    expect(plan.sufficient).toBe(false);
    expect(plan.totalConsumed).toBe(50);
    expect(plan.shortfall).toBe(50);
  });

  it("never allocates more than the requested amount", () => {
    const lots = [lot({ id: "big", remainingPoints: 1_000 })];
    const plan = planFifoConsumption(lots, 250);
    const total = plan.allocations.reduce((s, a) => s + a.take, 0);
    expect(total).toBe(250);
    expect(total).toBeLessThanOrEqual(250);
  });

  it("rejects a non-positive amount", () => {
    expect(() => planFifoConsumption([], 0)).toThrow(LotConsumptionValidationError);
    expect(() => planFifoConsumption([], -5)).toThrow(LotConsumptionValidationError);
  });

  it("rejects a non-integer amount", () => {
    expect(() => planFifoConsumption([], 12.5)).toThrow(LotConsumptionValidationError);
  });
});

/**
 * A stateful in-memory point_lots fake. Models the SELECT ... FOR UPDATE of
 * consumable lots (non-expired, remaining > 0, ordered FIFO) and the decrement
 * UPDATE, so consumeLotsFifo can be exercised end-to-end without Postgres.
 */
interface FakeLotRow {
  id: string;
  remaining_points: number;
  earned_at: Date;
  expires_at: Date | null;
  /** Physical insertion order, standing in for ctid. */
  seq: number;
}

function makeLotStore(initial: FakeLotRow[]): {
  db: Queryable;
  rows: FakeLotRow[];
  updates: Array<{ take: number; lotId: string }>;
} {
  const rows = initial.map((r) => ({ ...r }));
  const updates: Array<{ take: number; lotId: string }> = [];
  const db: Queryable = {
    async query<R extends QueryResultRow = QueryResultRow>(
      queryText: string,
      values: unknown[] = [],
    ): Promise<QueryResult<R>> {
      if (/UPDATE point_lots/i.test(queryText)) {
        const take = values[0] as number;
        const lotId = values[1] as string;
        const target = rows.find((r) => r.id === lotId);
        if (!target) {
          throw new Error(`lot ${lotId} not found`);
        }
        target.remaining_points -= take;
        updates.push({ take, lotId });
        return { rows: [], rowCount: 1, command: "UPDATE", oid: 0, fields: [] };
      }
      // SELECT consumable lots: filter non-expired + remaining > 0, order FIFO.
      const asOf = values[1] as Date;
      const selected = rows
        .filter(
          (r) =>
            r.remaining_points > 0 && (r.expires_at === null || r.expires_at.getTime() > asOf.getTime()),
        )
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
  return { db, rows, updates };
}

describe("consumeLotsFifo: FIFO consumption primitive (Req 5.6, 5.7)", () => {
  it("decrements lots oldest-first and returns the applied plan", async () => {
    const { db, rows, updates } = makeLotStore([
      {
        id: "old",
        remaining_points: 40,
        earned_at: new Date("2025-01-01T00:00:00Z"),
        expires_at: null,
        seq: 0,
      },
      {
        id: "new",
        remaining_points: 100,
        earned_at: new Date("2025-02-01T00:00:00Z"),
        expires_at: null,
        seq: 1,
      },
    ]);

    const plan = await consumeLotsFifo(CUSTOMER, 60, db);

    expect(plan.sufficient).toBe(true);
    expect(plan.totalConsumed).toBe(60);
    expect(updates).toEqual([
      { take: 40, lotId: "old" },
      { take: 20, lotId: "new" },
    ]);
    // Decrement-only: the older lot fully drained, the newer partially consumed.
    expect(rows.find((r) => r.id === "old")!.remaining_points).toBe(0);
    expect(rows.find((r) => r.id === "new")!.remaining_points).toBe(80);
  });

  it("consumes only from non-expired lots (spendable pool, Req 1.3/5.7)", async () => {
    const asOf = new Date("2025-06-01T00:00:00Z");
    const { db, rows, updates } = makeLotStore([
      {
        id: "expired",
        remaining_points: 100,
        earned_at: new Date("2024-01-01T00:00:00Z"),
        expires_at: new Date("2025-01-01T00:00:00Z"), // already expired at asOf
        seq: 0,
      },
      {
        id: "live",
        remaining_points: 100,
        earned_at: new Date("2025-03-01T00:00:00Z"),
        expires_at: new Date("2026-03-01T00:00:00Z"),
        seq: 1,
      },
    ]);

    const plan = await consumeLotsFifo(CUSTOMER, 50, db, asOf);

    expect(plan.allocations.map((a) => a.lotId)).toEqual(["live"]);
    expect(updates).toEqual([{ take: 50, lotId: "live" }]);
    // The expired lot is untouched.
    expect(rows.find((r) => r.id === "expired")!.remaining_points).toBe(100);
  });

  it("breaks ties by creation order (ctid/seq) for equal earned_at", async () => {
    const at = new Date("2025-01-01T00:00:00Z");
    const { db, updates } = makeLotStore([
      { id: "second", remaining_points: 50, earned_at: at, expires_at: null, seq: 1 },
      { id: "first", remaining_points: 50, earned_at: at, expires_at: null, seq: 0 },
    ]);

    await consumeLotsFifo(CUSTOMER, 60, db);

    expect(updates).toEqual([
      { take: 50, lotId: "first" },
      { take: 10, lotId: "second" },
    ]);
  });

  it("rejects with InsufficientPointsError and leaves every lot unchanged (Req 5.7)", async () => {
    const { db, rows, updates } = makeLotStore([
      {
        id: "l1",
        remaining_points: 30,
        earned_at: new Date("2025-01-01T00:00:00Z"),
        expires_at: null,
        seq: 0,
      },
    ]);

    await expect(consumeLotsFifo(CUSTOMER, 100, db)).rejects.toBeInstanceOf(InsufficientPointsError);

    // No decrement was applied.
    expect(updates).toHaveLength(0);
    expect(rows[0]!.remaining_points).toBe(30);
  });

  it("carries requested/available on the insufficient error", async () => {
    const { db } = makeLotStore([
      {
        id: "l1",
        remaining_points: 30,
        earned_at: new Date("2025-01-01T00:00:00Z"),
        expires_at: null,
        seq: 0,
      },
    ]);

    try {
      await consumeLotsFifo(CUSTOMER, 100, db);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(InsufficientPointsError);
      expect((err as InsufficientPointsError).requested).toBe(100);
      expect((err as InsufficientPointsError).available).toBe(30);
    }
  });

  it("consumes exactly the available balance to zero", async () => {
    const { db, rows } = makeLotStore([
      {
        id: "l1",
        remaining_points: 100,
        earned_at: new Date("2025-01-01T00:00:00Z"),
        expires_at: null,
        seq: 0,
      },
    ]);

    const plan = await consumeLotsFifo(CUSTOMER, 100, db);
    expect(plan.sufficient).toBe(true);
    expect(rows[0]!.remaining_points).toBe(0);
  });

  it("locks rows FOR UPDATE in the selection query", async () => {
    const seen: string[] = [];
    const db: Queryable = {
      async query<R extends QueryResultRow = QueryResultRow>(
        queryText: string,
      ): Promise<QueryResult<R>> {
        seen.push(queryText);
        return { rows: [] as unknown as R[], rowCount: 0, command: "SELECT", oid: 0, fields: [] };
      },
    };
    await expect(consumeLotsFifo(CUSTOMER, 10, db)).rejects.toBeInstanceOf(InsufficientPointsError);
    expect(seen[0]).toContain("FOR UPDATE");
    expect(seen[0]).toContain("ORDER BY earned_at ASC, ctid ASC");
  });

  it("rejects a non-positive amount before querying", async () => {
    const { db, updates } = makeLotStore([]);
    await expect(consumeLotsFifo(CUSTOMER, 0, db)).rejects.toBeInstanceOf(
      LotConsumptionValidationError,
    );
    expect(updates).toHaveLength(0);
  });
});
