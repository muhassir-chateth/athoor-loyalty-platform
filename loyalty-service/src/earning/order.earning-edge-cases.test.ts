/**
 * Unit tests for earning EDGE CASES (task 4.6).
 *
 * _Requirements: 2.3, 2.4_
 *
 * These tests pin down the boundary behaviour of the APPROVED earning engine
 * (`earnOrder` / `computeOrderPoints`, task 4.2) and the tier-multiplier lookup
 * (`tierMultiplier`, task 4.3). They are deliberately DISTINCT from:
 *   - `order.test.ts` (happy-path + first-purchase + isolation), and
 *   - `order.earn-correctness.property.test.ts` (Property 7, randomised),
 * focusing instead on the three edge groups called out by task 4.6:
 *
 *   1. Zero / negative eligible total  → NO `earn_order` entry, Balance
 *      unchanged, spend + tier untouched (Req 2.3).
 *   2. Tier multiplier default fallback → an undefined / unrecognized tier
 *      earns at Bronze 1x (Req 2.4).
 *   3. Floor rounding boundaries        → `floor(eligibleTotal × multiplier)`
 *      at, just below, and just above whole-point boundaries, including the
 *      sub-point (floor == 0) case that creates no earn (Req 1.4 / 2.2).
 *
 * SAFETY: no live/production system is touched. `earnOrder` is exercised
 * against a tiny in-memory {@link Queryable} fake — no Postgres, no Shopify
 * Admin API. This is a verification task; the implementation is not changed.
 */
import { describe, expect, it } from "vitest";
import type { QueryResult, QueryResultRow } from "pg";
import { LedgerRepository, type Queryable } from "../ledger/repository.js";
import { computeOrderPoints, earnOrder, type Transactor } from "./order.js";
import { DEFAULT_TIER, tierMultiplier, TIER_MULTIPLIERS } from "../tier/tier.js";

// --- Minimal in-memory fake Postgres for earnOrder --------------------------

interface LedgerRowStore {
  id: string;
  customer_id: string;
  entry_type: string;
  points: number;
  order_reference: number | null;
}

interface PointLotStore {
  id: string;
  customer_id: string;
  ledger_entry_id: string;
}

interface CustomerStore {
  id: string;
  shopify_customer_id: number;
  tier: string;
  lifetime_spend_gbp: number;
}

const FIXED_CREATED_AT = new Date("2025-01-15T10:00:00.000Z");

/**
 * Understands exactly the statements {@link earnOrder} issues: the customer
 * upsert, the order-replay guard, the any-earn_order (first-purchase) guard,
 * the ledger append, the point-lot insert, and the customer-totals update.
 * Supports seeding a customer with an ARBITRARY (incl. unrecognized) tier so
 * the default-fallback edge case can be driven.
 */
class FakeDb implements Queryable, Transactor {
  readonly customers: CustomerStore[] = [];
  readonly ledger: LedgerRowStore[] = [];
  readonly lots: PointLotStore[] = [];
  /** How many tier_change_history rows were written (task 46). */
  tierChangeCount = 0;
  private seq = 0;

  async query<R extends QueryResultRow = QueryResultRow>(
    queryText: string,
    values: unknown[] = [],
  ): Promise<QueryResult<R>> {
    if (queryText.includes("INSERT INTO customers")) {
      return this.upsertCustomer<R>(values);
    }
    if (
      queryText.includes("FROM ledger_entries") &&
      queryText.includes("earn_order") &&
      queryText.includes("order_reference")
    ) {
      return this.guardOrderReplay<R>(values);
    }
    if (queryText.includes("FROM ledger_entries") && queryText.includes("earn_order")) {
      return this.guardAnyOrderEarning<R>(values);
    }
    if (queryText.includes("INSERT INTO ledger_entries")) {
      return this.appendLedger<R>(values);
    }
    if (queryText.includes("INSERT INTO point_lots")) {
      return this.insertLot<R>(values);
    }
    if (queryText.includes("UPDATE customers")) {
      return this.updateCustomerTotals<R>(values);
    }
    if (queryText.includes("INSERT INTO tier_change_history")) {
      // Task 46: accepted so a threshold-crossing edge case does not fail here.
      this.tierChangeCount += 1;
      return this.result<R>([]);
    }
    throw new Error(`Unexpected query in FakeDb: ${queryText}`);
  }

  async transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
    return fn(this);
  }

  private nextId(prefix: string): string {
    this.seq += 1;
    return `${prefix}-${String(this.seq).padStart(12, "0")}`;
  }

  private upsertCustomer<R extends QueryResultRow>(values: unknown[]): QueryResult<R> {
    const shopifyId = values[0] as number;
    let cust = this.customers.find((c) => c.shopify_customer_id === shopifyId);
    if (!cust) {
      cust = {
        id: this.nextId("cust"),
        shopify_customer_id: shopifyId,
        tier: "bronze",
        lifetime_spend_gbp: 0,
      };
      this.customers.push(cust);
    }
    return this.result<R>([
      { id: cust.id, tier: cust.tier, lifetime_spend_gbp: String(cust.lifetime_spend_gbp) } as unknown as R,
    ]);
  }

  private guardOrderReplay<R extends QueryResultRow>(values: unknown[]): QueryResult<R> {
    const [customerId, orderRef] = values as [string, number];
    const exists = this.ledger.some(
      (row) =>
        row.customer_id === customerId &&
        row.entry_type === "earn_order" &&
        row.order_reference === orderRef,
    );
    return this.result<R>(exists ? [{ "?column?": 1 } as unknown as R] : []);
  }

  private guardAnyOrderEarning<R extends QueryResultRow>(values: unknown[]): QueryResult<R> {
    const customerId = values[0] as string;
    const exists = this.ledger.some(
      (row) => row.customer_id === customerId && row.entry_type === "earn_order",
    );
    return this.result<R>(exists ? [{ "?column?": 1 } as unknown as R] : []);
  }

  private appendLedger<R extends QueryResultRow>(values: unknown[]): QueryResult<R> {
    const [customerId, entryType, points, , orderReference, , , sourceEventId] = values;
    const row: LedgerRowStore = {
      id: this.nextId("ledg"),
      customer_id: customerId as string,
      entry_type: entryType as string,
      points: points as number,
      order_reference: (orderReference as number | null) ?? null,
    };
    this.ledger.push(row);
    const returned = {
      id: row.id,
      customer_id: row.customer_id,
      entry_type: row.entry_type,
      points: String(row.points), // pg returns BIGINT as string
      reason: "",
      order_reference: row.order_reference === null ? null : String(row.order_reference),
      point_lot_id: null,
      redemption_id: null,
      source_event_id: (sourceEventId as string | null) ?? null,
      created_at: FIXED_CREATED_AT,
    };
    return this.result<R>([returned as unknown as R]);
  }

  private insertLot<R extends QueryResultRow>(values: unknown[]): QueryResult<R> {
    const [customerId, ledgerEntryId] = values as [string, string];
    const row: PointLotStore = {
      id: this.nextId("lot"),
      customer_id: customerId,
      ledger_entry_id: ledgerEntryId,
    };
    this.lots.push(row);
    return this.result<R>([{ id: row.id } as unknown as R]);
  }

  private updateCustomerTotals<R extends QueryResultRow>(values: unknown[]): QueryResult<R> {
    const [customerId, delta, tier] = values as [string, number, string];
    const cust = this.customers.find((c) => c.id === customerId);
    if (cust) {
      cust.lifetime_spend_gbp = Math.round((cust.lifetime_spend_gbp + delta) * 100) / 100;
      cust.tier = tier;
    }
    return this.result<R>([]);
  }

  private result<R extends QueryResultRow>(rows: R[]): QueryResult<R> {
    return { rows, rowCount: rows.length, command: "SELECT", oid: 0, fields: [] };
  }

  /** Seed a customer with any tier string (incl. unrecognized) and spend 0. */
  seedCustomer(shopifyId: number, tier: string): string {
    const cust: CustomerStore = {
      id: this.nextId("cust"),
      shopify_customer_id: shopifyId,
      tier,
      lifetime_spend_gbp: 0,
    };
    this.customers.push(cust);
    return cust.id;
  }

  ledgerFor(customerId: string): LedgerRowStore[] {
    return this.ledger.filter((row) => row.customer_id === customerId);
  }

  entriesOfType(customerId: string, type: string): LedgerRowStore[] {
    return this.ledgerFor(customerId).filter((row) => row.entry_type === type);
  }

  lotsFor(customerId: string): PointLotStore[] {
    return this.lots.filter((row) => row.customer_id === customerId);
  }

  customerById(id: string): CustomerStore | undefined {
    return this.customers.find((c) => c.id === id);
  }

  balanceOf(customerId: string): number {
    return this.ledgerFor(customerId).reduce((sum, row) => sum + row.points, 0);
  }
}

// --- Edge group 1: zero / negative eligible total (Req 2.3) -----------------

describe("earning edge cases — zero/negative eligible total creates no earning (Req 2.3)", () => {
  it("eligibleTotal == 0 → no earn_order, no lot, balance/spend/tier unchanged", async () => {
    const db = new FakeDb();
    const repo = new LedgerRepository(db);
    const customerId = db.seedCustomer(1001, "silver"); // non-Bronze to prove tier isn't touched

    const outcome = await earnOrder(
      repo,
      { shopifyCustomerId: 1001, shopifyOrderId: 5001, eligibleTotal: 0 },
      db,
    );

    expect(outcome.status).toBe("no_earning");
    expect(db.entriesOfType(customerId, "earn_order")).toHaveLength(0);
    expect(db.entriesOfType(customerId, "earn_first_purchase")).toHaveLength(0);
    expect(db.ledgerFor(customerId)).toHaveLength(0);
    expect(db.lotsFor(customerId)).toHaveLength(0);
    expect(db.balanceOf(customerId)).toBe(0);
    expect(db.customerById(customerId)!.lifetime_spend_gbp).toBe(0);
    expect(db.customerById(customerId)!.tier).toBe("silver");
  });

  it("eligibleTotal < 0 → no earn_order, no lot, balance unchanged", async () => {
    const db = new FakeDb();
    const repo = new LedgerRepository(db);
    const customerId = db.seedCustomer(1002, "bronze");

    const outcome = await earnOrder(
      repo,
      { shopifyCustomerId: 1002, shopifyOrderId: 6001, eligibleTotal: -0.01 },
      db,
    );

    expect(outcome.status).toBe("no_earning");
    expect(db.ledgerFor(customerId)).toHaveLength(0);
    expect(db.lotsFor(customerId)).toHaveLength(0);
    expect(db.balanceOf(customerId)).toBe(0);
  });

  it("a strongly negative eligibleTotal is still a balance-preserving no-op", async () => {
    const db = new FakeDb();
    const repo = new LedgerRepository(db);
    const customerId = db.seedCustomer(1003, "bronze");

    const outcome = await earnOrder(
      repo,
      { shopifyCustomerId: 1003, shopifyOrderId: 7001, eligibleTotal: -250 },
      db,
    );

    expect(outcome.status).toBe("no_earning");
    expect(db.ledgerFor(customerId)).toHaveLength(0);
    expect(db.customerById(customerId)!.lifetime_spend_gbp).toBe(0);
  });

  it("computeOrderPoints returns 0 for zero and negative totals at every multiplier", () => {
    for (const m of [1, 1.5, 2, 3]) {
      expect(computeOrderPoints(0, m)).toBe(0);
      expect(computeOrderPoints(-1, m)).toBe(0);
      expect(computeOrderPoints(-999.99, m)).toBe(0);
    }
  });
});

// --- Edge group 2: tier multiplier default fallback (Req 2.4) ---------------

describe("earning edge cases — tier multiplier defaults to Bronze 1x (Req 2.4)", () => {
  it("tierMultiplier(undefined | null | unknown) == Bronze 1x", () => {
    expect(tierMultiplier(undefined)).toBe(1);
    expect(tierMultiplier(null)).toBe(1);
    expect(tierMultiplier("platinum")).toBe(1); // not a real tier
    expect(tierMultiplier("")).toBe(1);
    expect(tierMultiplier(DEFAULT_TIER)).toBe(TIER_MULTIPLIERS.bronze);
    expect(TIER_MULTIPLIERS.bronze).toBe(1);
  });

  it("earnOrder earns at Bronze 1x when the stored tier is unrecognized", async () => {
    const db = new FakeDb();
    const repo = new LedgerRepository(db);
    // Corrupt/unknown tier value → must be treated as Bronze (1x).
    const customerId = db.seedCustomer(2001, "platinum");

    const outcome = await earnOrder(
      repo,
      { shopifyCustomerId: 2001, shopifyOrderId: 8001, eligibleTotal: 100 },
      db,
    );

    expect(outcome.status).toBe("earned");
    if (outcome.status !== "earned") return;
    expect(outcome.tierAtTime).toBe(DEFAULT_TIER); // normalized to bronze
    expect(outcome.orderPoints).toBe(100); // floor(100 × 1x)
    expect(db.entriesOfType(customerId, "earn_order")[0]!.points).toBe(100);
  });

  it("earnOrder earns at Bronze 1x for a brand-new lazily-enrolled customer (no tier yet)", async () => {
    const db = new FakeDb();
    const repo = new LedgerRepository(db);

    const outcome = await earnOrder(
      repo,
      { shopifyCustomerId: 2002, shopifyOrderId: 8002, eligibleTotal: 73 },
      db,
    );

    expect(outcome.status).toBe("earned");
    if (outcome.status !== "earned") return;
    expect(outcome.tierAtTime).toBe(DEFAULT_TIER);
    expect(outcome.orderPoints).toBe(73); // floor(73 × 1x)
  });
});

// --- Edge group 3: floor rounding boundaries (Req 2.2 / 1.4) ----------------

describe("earning edge cases — floor rounding boundaries", () => {
  it("floors fractional products DOWN, just below a whole-point boundary", () => {
    // Bronze 1x: 45.99 → 45.99 → floor 45 (just below 46).
    expect(computeOrderPoints(45.99, 1)).toBe(45);
    // Silver 1.5x: 29.99 × 1.5 = 44.985 → 44 (just below 45).
    expect(computeOrderPoints(29.99, 1.5)).toBe(44);
    // Gold 2x: 33.33 × 2 = 66.66 → 66.
    expect(computeOrderPoints(33.33, 2)).toBe(66);
    // Royal_VIP 3x: 19.99 × 3 = 59.97 → 59.
    expect(computeOrderPoints(19.99, 3)).toBe(59);
  });

  it("keeps the whole value AT an exact integer boundary (no drift down)", () => {
    // Silver 1.5x: 20 × 1.5 = 30.0 exactly → 30, must not drift to 29.
    expect(computeOrderPoints(20, 1.5)).toBe(30);
    // Silver 1.5x: 30 × 1.5 = 45.0 exactly → 45.
    expect(computeOrderPoints(30, 1.5)).toBe(45);
    // Gold 2x: 12.5 × 2 = 25.0 exactly → 25.
    expect(computeOrderPoints(12.5, 2)).toBe(25);
    // Royal_VIP 3x: 0.67 × 3 = 2.01 → 2 (just above boundary, floors to 2).
    expect(computeOrderPoints(0.67, 3)).toBe(2);
  });

  it("floors a sub-point product to 0 → no earn_order entry is created (Req 1.4)", async () => {
    const db = new FakeDb();
    const repo = new LedgerRepository(db);
    const customerId = db.seedCustomer(3001, "bronze");

    // 0.99 × 1x = 0.99 → floor 0. An earn must be strictly positive (Req 1.4),
    // so no earn_order/lot is created — but the spend still accrues.
    expect(computeOrderPoints(0.99, 1)).toBe(0);

    const outcome = await earnOrder(
      repo,
      { shopifyCustomerId: 3001, shopifyOrderId: 9001, eligibleTotal: 0.99 },
      db,
    );

    expect(outcome.status).toBe("earned");
    if (outcome.status !== "earned") return;
    expect(outcome.orderPoints).toBe(0);
    expect(outcome.firstPurchase).toBe(false); // no first-purchase bonus without a first earning order
    expect(db.entriesOfType(customerId, "earn_order")).toHaveLength(0);
    expect(db.entriesOfType(customerId, "earn_first_purchase")).toHaveLength(0);
    expect(db.lotsFor(customerId)).toHaveLength(0);
    expect(db.balanceOf(customerId)).toBe(0);
    // The eligible spend is still recorded (drives tier), even with 0 points.
    expect(db.customerById(customerId)!.lifetime_spend_gbp).toBe(0.99);
  });

  it("the smallest earning amount at the 1-point boundary creates exactly one point", async () => {
    const db = new FakeDb();
    const repo = new LedgerRepository(db);
    const customerId = db.seedCustomer(3002, "bronze");

    // 1.00 × 1x = 1 → exactly one point, one earn_order, plus first-purchase.
    const outcome = await earnOrder(
      repo,
      { shopifyCustomerId: 3002, shopifyOrderId: 9002, eligibleTotal: 1 },
      db,
    );

    expect(outcome.status).toBe("earned");
    if (outcome.status !== "earned") return;
    expect(outcome.orderPoints).toBe(1);
    expect(db.entriesOfType(customerId, "earn_order")).toHaveLength(1);
    expect(db.entriesOfType(customerId, "earn_order")[0]!.points).toBe(1);
    expect(db.lotsFor(customerId).length).toBeGreaterThan(0);
  });
});
