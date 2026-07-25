/**
 * Unit + property tests for the reconciliation job (task 12.1).
 *
 * NO live/production database or Shopify Admin API is touched. The job is
 * exercised against a stateful in-memory fake {@link Queryable} that models the
 * `customers`, `ledger_entries`, and `point_lots` tables and every read/update
 * the reconciler and the reused metafield-cache path issue, plus a fake
 * {@link CustomerMetafieldClient} that records the metafield writes.
 *
 * Covers (Requirements 1.7, 13.7):
 *   - a drifted cached `tier` and `lifetime_points` are recomputed SOLELY from
 *     the ledger and overwritten (Req 1.7);
 *   - drifted lot `remaining_points` are reconstructed from the ledger (FIFO
 *     spend + linked expiry) and overwritten (Req 1.7);
 *   - the Metafield_Cache is refreshed from the ledger (Req 13.7);
 *   - a NO-OP when every cache already matches the ledger (no UPDATE issued);
 *   - an unknown customer is skipped (non-fatal);
 *   - a full run reports processed/repaired counts and the scheduler
 *     registration wires the callable job (Req 13.7);
 *   - PROPERTY: reconciliation converges every cache to the ledger and a second
 *     run is a no-op (idempotent), for arbitrary starting drift.
 */
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import type { QueryResult, QueryResultRow } from "pg";
import type { Queryable } from "../ledger/repository.js";
import {
  MetafieldCacheWriter,
  customerGid,
  type CustomerMetafieldClient,
  type MetafieldWriteInput,
} from "../shopify/metafieldCache.js";
import { deriveTier } from "../tier/tier.js";
import {
  reconcileCustomer,
  reconstructLotRemainders,
  registerReconciliationJob,
  RECONCILIATION_MAX_INTERVAL_MS,
  RECONCILIATION_SCHEDULE,
  runReconciliation,
  type ReconcileDeps,
  type RecurringScheduler,
  type Transactor,
} from "./reconcile.js";

/* --------------------------------- fakes ---------------------------------- */

interface FakeCustomer {
  id: string;
  shopify_customer_id: number;
  tier: string;
  lifetime_points: number;
  lifetime_spend_gbp: number;
  created_at: Date;
}

interface FakeLot {
  id: string;
  customer_id: string;
  original_points: number;
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
  point_lot_id: string | null;
  created_at: Date;
}

interface FakeDb {
  db: Queryable;
  customers: FakeCustomer[];
  lots: FakeLot[];
  ledger: FakeLedgerEntry[];
  statements: string[];
}

function makeDb(seed: {
  customers?: FakeCustomer[];
  lots?: FakeLot[];
  ledger?: FakeLedgerEntry[];
}): FakeDb {
  const customers = (seed.customers ?? []).map((c) => ({ ...c }));
  const lots = (seed.lots ?? []).map((l) => ({ ...l }));
  const ledger = (seed.ledger ?? []).map((e) => ({ ...e }));
  const statements: string[] = [];

  const ok = <T extends QueryResultRow>(rows: T[], command: string): QueryResult<T> => ({
    rows,
    rowCount: rows.length,
    command,
    oid: 0,
    fields: [],
  });

  const db: Queryable = {
    async query<R extends QueryResultRow = QueryResultRow>(
      text: string,
      values: unknown[] = [],
    ): Promise<QueryResult<R>> {
      statements.push(text.trim());

      if (/UPDATE customers/i.test(text)) {
        const [tier, points, id] = values as [string, number, string];
        const c = customers.find((x) => x.id === id);
        if (c) {
          c.tier = tier;
          c.lifetime_points = points;
        }
        return ok([], "UPDATE") as unknown as QueryResult<R>;
      }

      if (/UPDATE point_lots/i.test(text)) {
        const [remaining, id] = values as [number, string];
        const l = lots.find((x) => x.id === id);
        if (l) {
          l.remaining_points = remaining;
        }
        return ok([], "UPDATE") as unknown as QueryResult<R>;
      }

      if (/SELECT id\s+FROM customers/i.test(text)) {
        const rows = [...customers]
          .sort((a, b) => a.created_at.getTime() - b.created_at.getTime() || a.id.localeCompare(b.id))
          .map((c) => ({ id: c.id }));
        return ok(rows as unknown as R[], "SELECT");
      }

      if (/FROM customers/i.test(text)) {
        const c = customers.find((x) => x.id === values[0]);
        if (!c) {
          return ok([] as R[], "SELECT");
        }
        if (/lifetime_points/i.test(text)) {
          // reconcile LOAD_CUSTOMER
          return ok(
            [
              {
                id: c.id,
                tier: c.tier,
                lifetime_points: String(c.lifetime_points),
                lifetime_spend_gbp: c.lifetime_spend_gbp.toFixed(2),
              },
            ] as unknown as R[],
            "SELECT",
          );
        }
        // metafield deriveCacheSnapshot customer load
        return ok(
          [
            {
              shopify_customer_id: c.shopify_customer_id,
              tier: c.tier,
              lifetime_spend_gbp: c.lifetime_spend_gbp.toFixed(2),
            },
          ] as unknown as R[],
          "SELECT",
        );
      }

      if (/SUM\(points\)/i.test(text)) {
        const sum = ledger
          .filter((e) => e.customer_id === values[0])
          .reduce((acc, e) => acc + e.points, 0);
        return ok([{ balance: String(sum) }] as unknown as R[], "SELECT");
      }

      if (/SUM\(remaining_points\)/i.test(text)) {
        const asOf = values[1] as Date;
        const sum = lots
          .filter(
            (l) =>
              l.customer_id === values[0] &&
              l.remaining_points > 0 &&
              (l.expires_at === null || l.expires_at.getTime() > asOf.getTime()),
          )
          .reduce((acc, l) => acc + l.remaining_points, 0);
        return ok([{ spendable: String(sum) }] as unknown as R[], "SELECT");
      }

      if (/FROM point_lots/i.test(text)) {
        const rows = lots
          .filter((l) => l.customer_id === values[0])
          .sort((a, b) => a.earned_at.getTime() - b.earned_at.getTime() || a.seq - b.seq)
          .map((l) => ({
            id: l.id,
            original_points: String(l.original_points),
            remaining_points: String(l.remaining_points),
            earned_at: l.earned_at,
            expires_at: l.expires_at,
          }));
        return ok(rows as unknown as R[], "SELECT");
      }

      if (/FROM ledger_entries/i.test(text)) {
        const rows = ledger
          .filter((e) => e.customer_id === values[0] && e.points < 0)
          .sort((a, b) => a.created_at.getTime() - b.created_at.getTime() || a.id.localeCompare(b.id))
          .map((e) => ({
            entry_type: e.entry_type,
            points: String(e.points),
            point_lot_id: e.point_lot_id,
            created_at: e.created_at,
          }));
        return ok(rows as unknown as R[], "SELECT");
      }

      throw new Error(`unexpected query: ${text}`);
    },
  };

  return { db, customers, lots, ledger, statements };
}

/** A Transactor that runs against the fake db (no real BEGIN/COMMIT). */
function makeTransactor(db: Queryable): Transactor {
  return {
    async transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
      return fn(db);
    },
  };
}

/** A fake Admin metafield client that records the last write per customer GID. */
class FakeMetafieldClient implements CustomerMetafieldClient {
  calls = 0;
  readonly stored = new Map<string, MetafieldWriteInput["metafields"]>();
  async writeCustomerMetafields(input: MetafieldWriteInput): Promise<void> {
    this.calls += 1;
    this.stored.set(input.customerGid, input.metafields);
  }
}

function makeDeps(fake: FakeDb): { deps: ReconcileDeps; client: FakeMetafieldClient } {
  const client = new FakeMetafieldClient();
  const deps: ReconcileDeps = {
    db: fake.db,
    transactor: makeTransactor(fake.db),
    metafieldWriter: new MetafieldCacheWriter(client),
    now: () => new Date("2025-01-01T00:00:00.000Z"),
  };
  return { deps, client };
}

const CUST = "11111111-1111-1111-1111-111111111111";
const T0 = new Date("2024-01-01T00:00:00.000Z");
/** Lot expiry comfortably AFTER the reconciliation instant (2025-01-01) so lots stay spendable. */
const EXPIRES = new Date("2026-01-01T00:00:00.000Z");

function metafieldValue(
  client: FakeMetafieldClient,
  shopifyId: number,
  key: string,
): string | undefined {
  return client.stored.get(customerGid(shopifyId))?.find((f) => f.key === key)?.value;
}

/* ----------------------- drifted tier + lifetime_points ------------------- */

describe("reconcileCustomer: drifted tier/lifetime_points repaired from ledger (Req 1.7)", () => {
  it("overwrites a wrong cached tier and lifetime_points with ledger-derived values", async () => {
    const fake = makeDb({
      customers: [
        {
          id: CUST,
          shopify_customer_id: 555,
          tier: "bronze", // WRONG: £800 spend should be gold
          lifetime_points: 999, // WRONG: ledger sums to 250
          lifetime_spend_gbp: 800,
          created_at: T0,
        },
      ],
      lots: [
        { id: "lot-1", customer_id: CUST, original_points: 250, remaining_points: 250, earned_at: T0, expires_at: EXPIRES, seq: 0 },
      ],
      ledger: [
        { id: "e1", customer_id: CUST, entry_type: "earn_signup", points: 50, point_lot_id: null, created_at: T0 },
        { id: "e2", customer_id: CUST, entry_type: "earn_order", points: 200, point_lot_id: null, created_at: T0 },
      ],
    });
    const { deps, client } = makeDeps(fake);

    const result = await reconcileCustomer(CUST, deps);

    expect(result.status).toBe("reconciled");
    if (result.status !== "reconciled") return;

    expect(result.lifetimePoints).toEqual({ cached: 999, recomputed: 250, repaired: true });
    expect(result.tier).toEqual({ cached: "bronze", recomputed: "gold", repaired: true });
    expect(result.dbRepaired).toBe(true);

    // Authoritative caches overwritten in the DB.
    expect(fake.customers[0]!.tier).toBe("gold");
    expect(fake.customers[0]!.lifetime_points).toBe(250);

    // Metafield cache refreshed from the ledger (Req 13.7).
    expect(result.metafield.status).toBe("written");
    expect(metafieldValue(client, 555, "tier")).toBe("gold");
    expect(metafieldValue(client, 555, "lifetime_points")).toBe("250");
    expect(metafieldValue(client, 555, "points_balance")).toBe("250");
  });
});

/* -------------------------- drifted lot remainders ------------------------ */

describe("reconcileCustomer: drifted lot remainders reconstructed from ledger (Req 1.7)", () => {
  it("repairs a lot whose cached remaining ignores a recorded spend (FIFO replay)", async () => {
    const fake = makeDb({
      customers: [
        { id: CUST, shopify_customer_id: 7, tier: "bronze", lifetime_points: 150, lifetime_spend_gbp: 0, created_at: T0 },
      ],
      lots: [
        // cached remaining 200 is WRONG: a -50 spend was recorded against the ledger.
        { id: "lot-1", customer_id: CUST, original_points: 200, remaining_points: 200, earned_at: T0, expires_at: EXPIRES, seq: 0 },
      ],
      ledger: [
        { id: "e1", customer_id: CUST, entry_type: "earn_order", points: 200, point_lot_id: null, created_at: T0 },
        { id: "e2", customer_id: CUST, entry_type: "spend", points: -50, point_lot_id: null, created_at: new Date("2024-02-01T00:00:00Z") },
      ],
    });
    const { deps, client } = makeDeps(fake);

    const result = await reconcileCustomer(CUST, deps);

    expect(result.status).toBe("reconciled");
    if (result.status !== "reconciled") return;

    expect(result.lots).toEqual([{ lotId: "lot-1", cached: 200, recomputed: 150, repaired: true }]);
    expect(fake.lots[0]!.remaining_points).toBe(150);
    // Spendable (points_balance) reflects the repaired lot.
    expect(metafieldValue(client, 7, "points_balance")).toBe("150");
  });

  it("repairs a lot expired in the ledger but still cached as funded (linked expiry replay)", async () => {
    const fake = makeDb({
      customers: [
        { id: CUST, shopify_customer_id: 9, tier: "bronze", lifetime_points: 0, lifetime_spend_gbp: 0, created_at: T0 },
      ],
      lots: [
        { id: "lot-1", customer_id: CUST, original_points: 100, remaining_points: 100, earned_at: T0, expires_at: EXPIRES, seq: 0 },
      ],
      ledger: [
        { id: "e1", customer_id: CUST, entry_type: "earn_order", points: 100, point_lot_id: null, created_at: T0 },
        { id: "e2", customer_id: CUST, entry_type: "expire", points: -100, point_lot_id: "lot-1", created_at: EXPIRES },
      ],
    });
    const { deps } = makeDeps(fake);

    const result = await reconcileCustomer(CUST, deps);

    expect(result.status).toBe("reconciled");
    if (result.status !== "reconciled") return;
    expect(result.lots).toEqual([{ lotId: "lot-1", cached: 100, recomputed: 0, repaired: true }]);
    expect(fake.lots[0]!.remaining_points).toBe(0);
  });
});

/* --------------------------------- no-op ---------------------------------- */

describe("reconcileCustomer: no-op when caches already match the ledger", () => {
  it("issues no customers/point_lots UPDATE and reports dbRepaired=false", async () => {
    const fake = makeDb({
      customers: [
        // silver is correct for £350; lifetime_points 250 matches the ledger.
        { id: CUST, shopify_customer_id: 1, tier: "silver", lifetime_points: 250, lifetime_spend_gbp: 350, created_at: T0 },
      ],
      lots: [
        { id: "lot-1", customer_id: CUST, original_points: 250, remaining_points: 250, earned_at: T0, expires_at: EXPIRES, seq: 0 },
      ],
      ledger: [
        { id: "e1", customer_id: CUST, entry_type: "earn_signup", points: 50, point_lot_id: null, created_at: T0 },
        { id: "e2", customer_id: CUST, entry_type: "earn_order", points: 200, point_lot_id: null, created_at: T0 },
      ],
    });
    const { deps } = makeDeps(fake);

    const result = await reconcileCustomer(CUST, deps);

    expect(result.status).toBe("reconciled");
    if (result.status !== "reconciled") return;
    expect(result.dbRepaired).toBe(false);
    expect(result.lifetimePoints.repaired).toBe(false);
    expect(result.tier.repaired).toBe(false);
    expect(result.lots.every((l) => !l.repaired)).toBe(true);

    // No authoritative cache write was issued.
    expect(fake.statements.some((s) => /UPDATE customers/i.test(s))).toBe(false);
    expect(fake.statements.some((s) => /UPDATE point_lots/i.test(s))).toBe(false);
  });
});

/* ----------------------------- unknown customer --------------------------- */

describe("reconcileCustomer: unknown customer", () => {
  it("skips a missing customer without touching the metafield cache", async () => {
    const fake = makeDb({ customers: [] });
    const { deps, client } = makeDeps(fake);

    const result = await reconcileCustomer("ghost", deps);

    expect(result).toEqual({ status: "skipped_unknown_customer", customerId: "ghost" });
    expect(client.calls).toBe(0);
  });
});

/* --------------------------- reconstruct primitive ------------------------ */

describe("reconstructLotRemainders: FIFO across multiple lots (Req 1.7 / 5.6)", () => {
  it("consumes oldest lots first when replaying a spend", async () => {
    const fake = makeDb({
      customers: [
        { id: CUST, shopify_customer_id: 2, tier: "bronze", lifetime_points: 0, lifetime_spend_gbp: 0, created_at: T0 },
      ],
      lots: [
        { id: "old", customer_id: CUST, original_points: 100, remaining_points: 100, earned_at: new Date("2024-01-01T00:00:00Z"), expires_at: EXPIRES, seq: 0 },
        { id: "new", customer_id: CUST, original_points: 100, remaining_points: 100, earned_at: new Date("2024-06-01T00:00:00Z"), expires_at: EXPIRES, seq: 1 },
      ],
      ledger: [
        { id: "e1", customer_id: CUST, entry_type: "spend", points: -120, point_lot_id: null, created_at: new Date("2024-07-01T00:00:00Z") },
      ],
    });

    const lots = await reconstructLotRemainders(CUST, fake.db);
    // 120 consumed FIFO: old fully (100), new partially (20) → new has 80 left.
    expect(lots.find((l) => l.id === "old")!.recomputedRemaining).toBe(0);
    expect(lots.find((l) => l.id === "new")!.recomputedRemaining).toBe(80);
  });
});

/* ------------------------------ full run + scheduler ---------------------- */

describe("runReconciliation + scheduler registration (Req 13.7)", () => {
  it("processes all customers and counts those repaired", async () => {
    const other = "22222222-2222-2222-2222-222222222222";
    const fake = makeDb({
      customers: [
        { id: CUST, shopify_customer_id: 1, tier: "bronze", lifetime_points: 0, lifetime_spend_gbp: 800, created_at: T0 }, // drift: tier
        { id: other, shopify_customer_id: 2, tier: "bronze", lifetime_points: 50, lifetime_spend_gbp: 0, created_at: new Date("2024-02-01T00:00:00Z") }, // consistent
      ],
      lots: [
        { id: "lot-2", customer_id: other, original_points: 50, remaining_points: 50, earned_at: T0, expires_at: EXPIRES, seq: 0 },
      ],
      ledger: [
        { id: "a", customer_id: other, entry_type: "earn_signup", points: 50, point_lot_id: null, created_at: T0 },
      ],
    });
    const { deps } = makeDeps(fake);

    const result = await runReconciliation(deps);

    expect(result.processed).toBe(2);
    expect(result.repaired).toBe(1);
    expect(result.asOf).toEqual(new Date("2025-01-01T00:00:00.000Z"));
  });

  it("registers the job on a scheduler with the ≤24h cadence and runs it", async () => {
    const fake = makeDb({
      customers: [
        { id: CUST, shopify_customer_id: 1, tier: "bronze", lifetime_points: 0, lifetime_spend_gbp: 0, created_at: T0 },
      ],
      lots: [],
      ledger: [{ id: "a", customer_id: CUST, entry_type: "earn_signup", points: 50, point_lot_id: null, created_at: T0 }],
    });
    const { deps, client } = makeDeps(fake);

    let registeredName = "";
    let registeredCron = "";
    let handler: (() => Promise<void>) | undefined;
    const scheduler: RecurringScheduler = {
      schedule(name, cron, h) {
        registeredName = name;
        registeredCron = cron;
        handler = h;
      },
    };

    const schedule = await registerReconciliationJob(scheduler, deps);

    expect(registeredName).toBe(RECONCILIATION_SCHEDULE.jobName);
    expect(registeredCron).toBe(RECONCILIATION_SCHEDULE.cron);
    expect(schedule.maxIntervalMs).toBeLessThanOrEqual(RECONCILIATION_MAX_INTERVAL_MS);

    // Invoking the registered handler runs a real reconciliation pass.
    await handler?.();
    // lifetime_points repaired 0 -> 50 and cache refreshed.
    expect(fake.customers[0]!.lifetime_points).toBe(50);
    expect(client.calls).toBeGreaterThan(0);
  });
});

/* ------------------------------ property test ----------------------------- */

describe("reconciliation properties", () => {
  it("converges every cache to the ledger and a second run is a no-op (Req 1.7)", async () => {
    await fc.assert(
      fc.asyncProperty(
        // Non-expiring earn lots (positive amounts) and a spend fraction.
        fc.array(fc.integer({ min: 1, max: 500 }), { minLength: 1, maxLength: 6 }),
        fc.integer({ min: 0, max: 3000 }), // total spend to replay
        fc.integer({ min: 0, max: 3000 }), // arbitrary WRONG cached lifetime_points
        fc.constantFrom("bronze", "silver", "gold", "royal_vip"), // arbitrary WRONG cached tier
        fc.integer({ min: 0, max: 2000 }), // lifetime spend (GBP) → correct tier
        async (earns, spendRaw, wrongPoints, wrongTier, spendGbp) => {
          const totalEarned = earns.reduce((a, b) => a + b, 0);
          const spend = Math.min(spendRaw, totalEarned); // never spend more than earned

          const now = new Date("2024-01-01T00:00:00Z");
          const ledger: FakeLedgerEntry[] = earns.map((pts, i) => ({
            id: `earn-${i}`,
            customer_id: CUST,
            entry_type: "earn_order",
            points: pts,
            point_lot_id: null,
            created_at: new Date(now.getTime() + i * 1000),
          }));
          // Lots start at their original; caches are deliberately corrupted.
          const lots: FakeLot[] = earns.map((pts, i) => ({
            id: `lot-${i}`,
            customer_id: CUST,
            original_points: pts,
            remaining_points: pts, // pre-spend; drift is introduced by the spend below
            earned_at: new Date(now.getTime() + i * 1000),
            expires_at: null,
            seq: i,
          }));
          if (spend > 0) {
            ledger.push({
              id: "spend-1",
              customer_id: CUST,
              entry_type: "spend",
              points: -spend,
              point_lot_id: null,
              created_at: new Date(now.getTime() + 10_000),
            });
          }

          const fake = makeDb({
            customers: [
              {
                id: CUST,
                shopify_customer_id: 42,
                tier: wrongTier,
                lifetime_points: wrongPoints,
                lifetime_spend_gbp: spendGbp,
                created_at: now,
              },
            ],
            lots,
            ledger,
          });
          const { deps } = makeDeps(fake);

          const first = await reconcileCustomer(CUST, deps);
          expect(first.status).toBe("reconciled");

          // Converged: lifetime_points == net ledger, tier == derived from spend.
          const expectedPoints = totalEarned - spend;
          expect(fake.customers[0]!.lifetime_points).toBe(expectedPoints);
          expect(fake.customers[0]!.tier).toBe(deriveTier(spendGbp));

          // Lot remainders sum to the spendable pool (all non-expiring here).
          const remainingSum = fake.lots.reduce((a, l) => a + l.remaining_points, 0);
          expect(remainingSum).toBe(expectedPoints);
          expect(fake.lots.every((l) => l.remaining_points >= 0)).toBe(true);

          // Idempotent: a second run finds no drift.
          const second = await reconcileCustomer(CUST, deps);
          expect(second.status).toBe("reconciled");
          if (second.status === "reconciled") {
            expect(second.dbRepaired).toBe(false);
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});
