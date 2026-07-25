/**
 * Unit tests for the idempotent FIFO expiry scan (task 10.1).
 *
 * No live/production database or Shopify Admin API is touched. The scan is
 * exercised against a stateful in-memory fake that models the `point_lots`
 * table and the SQL the scan issues — the matured-lot FOR UPDATE select, the
 * append-only ledger insert, and the lot-zeroing update — plus a fake
 * Transactor. The real {@link LedgerRepository} is used unchanged; only the DB
 * boundary is faked.
 *
 * Covers (Requirements 5.2, 5.3; Property 9):
 *   - a lot matured on/before the scan date is expired exactly once, with one
 *     negative `expire` entry equal to its remainder, and its remaining zeroed;
 *   - non-expired lots and NULL-expiry (never-expiring) lots are untouched;
 *   - zero-remaining lots are untouched (no entry created);
 *   - re-running the same date is a no-op (no second entry, remaining stays 0);
 *   - the expire entry links back to its lot and carries a negative amount.
 */
import { describe, expect, it } from "vitest";
import type { QueryResult, QueryResultRow } from "pg";
import { LedgerRepository, type Queryable } from "../ledger/repository.js";
import { EXPIRY_REASON, runExpiryScan, type ExpiryScanDeps, type Transactor } from "./expiryScan.js";

interface FakeLot {
  id: string;
  customer_id: string;
  remaining_points: number;
  earned_at: Date;
  expires_at: Date | null;
  seq: number;
}

interface FakeLedgerEntry {
  id: string;
  customer_id: string;
  entry_type: string;
  points: number;
  reason: string;
  order_reference: number | null;
  point_lot_id: string | null;
  redemption_id: string | null;
  source_event_id: string | null;
  created_at: Date;
}

interface FakeDb {
  db: Queryable;
  lots: FakeLot[];
  ledger: FakeLedgerEntry[];
  statements: string[];
}

const CUSTOMER = "22222222-2222-2222-2222-222222222222";
const CUSTOMER_B = "33333333-3333-3333-3333-333333333333";

function makeDb(initialLots: FakeLot[] = []): FakeDb {
  const lots = initialLots.map((l) => ({ ...l }));
  const ledger: FakeLedgerEntry[] = [];
  const statements: string[] = [];
  let idCounter = 0;
  const nextId = (prefix: string): string => `${prefix}-${++idCounter}`;

  const db: Queryable = {
    async query<R extends QueryResultRow = QueryResultRow>(
      queryText: string,
      values: unknown[] = [],
    ): Promise<QueryResult<R>> {
      statements.push(queryText.trim());
      const ok = <T extends QueryResultRow>(rows: T[], command: string): QueryResult<T> => ({
        rows,
        rowCount: rows.length,
        command,
        oid: 0,
        fields: [],
      });

      // Matured-lot selection: expires_at IS NOT NULL AND <= asOf AND remaining > 0.
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
            remaining_points: String(l.remaining_points),
            earned_at: l.earned_at,
            expires_at: l.expires_at,
          }));
        return ok(selected as unknown as R[], "SELECT");
      }

      if (/UPDATE point_lots/i.test(queryText)) {
        const lotId = values[0] as string;
        const target = lots.find((l) => l.id === lotId);
        if (!target) {
          throw new Error(`lot ${lotId} not found`);
        }
        target.remaining_points = 0;
        return ok([], "UPDATE") as unknown as QueryResult<R>;
      }

      if (/INSERT INTO ledger_entries/i.test(queryText)) {
        const [
          customer_id,
          entry_type,
          points,
          reason,
          order_reference,
          point_lot_id,
          redemption_id,
          source_event_id,
        ] = values as [
          string,
          string,
          number,
          string,
          number | null,
          string | null,
          string | null,
          string | null,
        ];
        const row: FakeLedgerEntry = {
          id: nextId("ledger"),
          customer_id,
          entry_type,
          points,
          reason,
          order_reference: order_reference ?? null,
          point_lot_id: point_lot_id ?? null,
          redemption_id: redemption_id ?? null,
          source_event_id: source_event_id ?? null,
          created_at: new Date("2025-06-01T00:00:00.000Z"),
        };
        ledger.push(row);
        return ok([{ ...row, points: String(points) }] as unknown as R[], "INSERT");
      }

      throw new Error(`unexpected query: ${queryText}`);
    },
  };

  return { db, lots, ledger, statements };
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

function lot(over: Partial<FakeLot> & Pick<FakeLot, "id" | "remaining_points">): FakeLot {
  return {
    customer_id: CUSTOMER,
    earned_at: new Date("2024-01-01T00:00:00.000Z"),
    expires_at: new Date("2025-01-01T00:00:00.000Z"),
    seq: 0,
    ...over,
  };
}

const SCAN_DATE = new Date("2025-06-01T00:00:00.000Z");

describe("runExpiryScan: matured lots expire once with correct negative entry (Req 5.2)", () => {
  it("creates one negative expire entry equal to the remainder and zeroes the lot", async () => {
    const fake = makeDb([
      lot({ id: "matured", remaining_points: 120, expires_at: new Date("2025-05-01T00:00:00Z") }),
    ]);
    const deps = makeDeps(fake);

    const result = await runExpiryScan(SCAN_DATE, deps);

    // Exactly one expire entry equal in magnitude to the remainder (Req 5.2).
    expect(fake.ledger).toHaveLength(1);
    expect(fake.ledger[0]!.entry_type).toBe("expire");
    expect(fake.ledger[0]!.points).toBe(-120);
    expect(fake.ledger[0]!.reason).toBe(EXPIRY_REASON);
    expect(fake.ledger[0]!.point_lot_id).toBe("matured");

    // Lot remaining is zeroed.
    expect(fake.lots.find((l) => l.id === "matured")!.remaining_points).toBe(0);

    // Result summary reflects the single expiry.
    expect(result.expiredLotCount).toBe(1);
    expect(result.totalPointsExpired).toBe(120);
    expect(result.expiredLots).toEqual([
      {
        lotId: "matured",
        customerId: CUSTOMER,
        pointsExpired: 120,
        ledgerEntryId: fake.ledger[0]!.id,
      },
    ]);
  });

  it("expires a lot whose expires_at equals the scan date (on-or-before, inclusive)", async () => {
    const fake = makeDb([lot({ id: "boundary", remaining_points: 50, expires_at: SCAN_DATE })]);
    const result = await runExpiryScan(SCAN_DATE, makeDeps(fake));

    expect(result.expiredLotCount).toBe(1);
    expect(fake.ledger[0]!.points).toBe(-50);
    expect(fake.lots[0]!.remaining_points).toBe(0);
  });

  it("expires multiple matured lots across customers, one entry each", async () => {
    const fake = makeDb([
      lot({ id: "a", remaining_points: 30, expires_at: new Date("2025-02-01T00:00:00Z") }),
      lot({
        id: "b",
        remaining_points: 70,
        customer_id: CUSTOMER_B,
        expires_at: new Date("2025-03-01T00:00:00Z"),
      }),
    ]);
    const result = await runExpiryScan(SCAN_DATE, makeDeps(fake));

    expect(result.expiredLotCount).toBe(2);
    expect(result.totalPointsExpired).toBe(100);
    expect(fake.ledger.filter((e) => e.entry_type === "expire")).toHaveLength(2);
    expect(fake.lots.every((l) => l.remaining_points === 0)).toBe(true);
  });
});

describe("runExpiryScan: non-expired / never-expiring / zero-remaining lots untouched", () => {
  it("does not expire a lot whose expires_at is after the scan date", async () => {
    const fake = makeDb([
      lot({ id: "future", remaining_points: 200, expires_at: new Date("2025-12-01T00:00:00Z") }),
    ]);
    const result = await runExpiryScan(SCAN_DATE, makeDeps(fake));

    expect(result.expiredLotCount).toBe(0);
    expect(fake.ledger).toHaveLength(0);
    expect(fake.lots[0]!.remaining_points).toBe(200);
  });

  it("never expires a NULL-expiry (never-expiring) lot even if old", async () => {
    const fake = makeDb([
      lot({
        id: "migrated",
        remaining_points: 500,
        expires_at: null,
        earned_at: new Date("2020-01-01T00:00:00Z"),
      }),
    ]);
    const result = await runExpiryScan(SCAN_DATE, makeDeps(fake));

    expect(result.expiredLotCount).toBe(0);
    expect(fake.ledger).toHaveLength(0);
    expect(fake.lots[0]!.remaining_points).toBe(500);
  });

  it("ignores a matured lot that already has zero remaining (no entry created)", async () => {
    const fake = makeDb([
      lot({ id: "empty", remaining_points: 0, expires_at: new Date("2025-01-01T00:00:00Z") }),
    ]);
    const result = await runExpiryScan(SCAN_DATE, makeDeps(fake));

    expect(result.expiredLotCount).toBe(0);
    expect(fake.ledger).toHaveLength(0);
  });

  it("expires only the matured lot in a mixed set, leaving the rest intact", async () => {
    const fake = makeDb([
      lot({ id: "matured", remaining_points: 40, expires_at: new Date("2025-01-01T00:00:00Z") }),
      lot({ id: "future", remaining_points: 60, expires_at: new Date("2026-01-01T00:00:00Z") }),
      lot({ id: "never", remaining_points: 80, expires_at: null }),
    ]);
    const result = await runExpiryScan(SCAN_DATE, makeDeps(fake));

    expect(result.expiredLotCount).toBe(1);
    expect(result.totalPointsExpired).toBe(40);
    expect(fake.lots.find((l) => l.id === "matured")!.remaining_points).toBe(0);
    expect(fake.lots.find((l) => l.id === "future")!.remaining_points).toBe(60);
    expect(fake.lots.find((l) => l.id === "never")!.remaining_points).toBe(80);
  });
});

describe("runExpiryScan: idempotent — re-running the same date is a no-op (Req 5.3, Property 9)", () => {
  it("expires each lot at most once across repeated runs for the same date", async () => {
    const fake = makeDb([
      lot({ id: "l1", remaining_points: 90, expires_at: new Date("2025-04-01T00:00:00Z") }),
    ]);
    const deps = makeDeps(fake);

    const first = await runExpiryScan(SCAN_DATE, deps);
    expect(first.expiredLotCount).toBe(1);
    expect(fake.ledger).toHaveLength(1);

    const second = await runExpiryScan(SCAN_DATE, deps);
    // No-op: no new entry, count zero, remaining still zero (Property 9).
    expect(second.expiredLotCount).toBe(0);
    expect(second.totalPointsExpired).toBe(0);
    expect(fake.ledger).toHaveLength(1);
    expect(fake.ledger.filter((e) => e.point_lot_id === "l1")).toHaveLength(1);
    expect(fake.lots[0]!.remaining_points).toBe(0);
  });

  it("is also a no-op when re-run for a later date after expiry", async () => {
    const fake = makeDb([
      lot({ id: "l1", remaining_points: 25, expires_at: new Date("2025-04-01T00:00:00Z") }),
    ]);
    const deps = makeDeps(fake);

    await runExpiryScan(SCAN_DATE, deps);
    const later = await runExpiryScan(new Date("2025-09-01T00:00:00Z"), deps);

    expect(later.expiredLotCount).toBe(0);
    expect(fake.ledger).toHaveLength(1);
    expect(fake.lots[0]!.remaining_points).toBe(0);
  });
});

describe("runExpiryScan: input validation", () => {
  it("rejects an invalid asOf date", async () => {
    const fake = makeDb([]);
    await expect(runExpiryScan(new Date("not-a-date"), makeDeps(fake))).rejects.toBeInstanceOf(
      TypeError,
    );
    expect(fake.statements).toHaveLength(0);
  });

  it("returns an empty result when there are no lots", async () => {
    const fake = makeDb([]);
    const result = await runExpiryScan(SCAN_DATE, makeDeps(fake));
    expect(result.expiredLotCount).toBe(0);
    expect(result.totalPointsExpired).toBe(0);
    expect(result.expiredLots).toEqual([]);
  });
});
