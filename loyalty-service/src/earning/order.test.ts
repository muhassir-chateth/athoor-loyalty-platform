/**
 * Unit tests for paid-order earning, first-purchase bonus, and point lots
 * (task 4.2).
 *
 * No live/production database is touched. A fake {@link Queryable} backed by a
 * tiny in-memory store routes the statements the flow issues — the customer
 * upsert, the order-replay idempotency guard, the first-purchase guard, the
 * ledger appends (via {@link LedgerRepository}), the point-lot inserts, and the
 * customer totals update — so the order-earning contract is verified without
 * any Postgres or Shopify Admin API:
 *
 *   - tiered earning `floor(eligibleTotal × multiplier(tier_at_time))` (Req 2.2);
 *   - first-purchase +100 exactly once (Req 2.5);
 *   - `eligibleTotal <= 0` is a balance-preserving no-op (Req 2.3);
 *   - each earning gets a matching lot expiring exactly 12 months later (Req 2.6);
 *   - tier advances and is never lowered (Property 11 / Req 7.3);
 *   - a replayed `orders/paid` for the same order does not double-earn;
 *   - only the target customer is affected (Req 2.11).
 */
import { describe, expect, it } from "vitest";
import type { QueryResult, QueryResultRow } from "pg";
import { LedgerRepository, type Queryable } from "../ledger/repository.js";
import type { WebhookJob } from "../webhooks/enqueue.js";
import {
  addMonths,
  computeOrderPoints,
  deriveEligibleTotal,
  earnOrder,
  FIRST_PURCHASE_POINTS,
  FIRST_PURCHASE_REASON,
  handleOrdersPaidJob,
  InvalidOrdersPaidPayloadError,
  ORDER_EARN_REASON,
  ORDERS_PAID_TOPIC,
  type Transactor,
} from "./order.js";

interface LedgerRowStore {
  id: string;
  customer_id: string;
  entry_type: string;
  points: number;
  reason: string;
  order_reference: number | null;
  source_event_id: string | null;
  created_at: Date;
}

interface PointLotStore {
  id: string;
  customer_id: string;
  ledger_entry_id: string;
  original_points: number;
  remaining_points: number;
  earned_at: Date;
  expires_at: Date | null;
}

interface CustomerStore {
  id: string;
  shopify_customer_id: number;
  email: string | null;
  tier: string;
  lifetime_spend_gbp: number;
}

const FIXED_CREATED_AT = new Date("2025-01-15T10:00:00.000Z");

/**
 * An in-memory fake Postgres that understands exactly the statements the
 * order-earning flow issues. It keeps customers (by shopify id), a ledger
 * array, and a point_lots array so idempotency, first-purchase detection,
 * tier/spend updates, lot creation, and per-customer isolation behave
 * realistically.
 */
class FakeDb implements Queryable, Transactor {
  readonly customers: CustomerStore[] = [];
  readonly ledger: LedgerRowStore[] = [];
  readonly lots: PointLotStore[] = [];
  /** tier_change_history rows written during the flow (task 46). */
  readonly tierChanges: Array<{
    customer_id: string;
    from_tier: string;
    to_tier: string;
    reason: string;
  }> = [];
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
      return this.insertTierChange<R>(values);
    }
    throw new Error(`Unexpected query in FakeDb: ${queryText}`);
  }

  // Transactor: run the unit of work directly on this fake (no real BEGIN).
  async transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
    return fn(this);
  }

  /** Records a tier_change_history row (task 46). */
  private insertTierChange<R extends QueryResultRow>(values: unknown[]): QueryResult<R> {
    const [customerId, fromTier, toTier, reason] = values as [string, string, string, string];
    this.tierChanges.push({
      customer_id: customerId,
      from_tier: fromTier,
      to_tier: toTier,
      reason,
    });
    return this.result<R>([]);
  }

  private nextId(prefix: string): string {
    this.seq += 1;
    return `${prefix}-${String(this.seq).padStart(12, "0")}`;
  }

  private upsertCustomer<R extends QueryResultRow>(values: unknown[]): QueryResult<R> {
    const shopifyId = values[0] as number;
    const email = (values[1] as string | null) ?? null;
    let cust = this.customers.find((c) => c.shopify_customer_id === shopifyId);
    if (!cust) {
      cust = {
        id: this.nextId("cust"),
        shopify_customer_id: shopifyId,
        email,
        tier: "bronze",
        lifetime_spend_gbp: 0,
      };
      this.customers.push(cust);
    } else if (!cust.email && email) {
      cust.email = email;
    }
    return this.result<R>([
      {
        id: cust.id,
        tier: cust.tier,
        lifetime_spend_gbp: String(cust.lifetime_spend_gbp),
      } as unknown as R,
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
    return this.result<R>(exists ? ([{ "?column?": 1 } as unknown as R]) : []);
  }

  private guardAnyOrderEarning<R extends QueryResultRow>(values: unknown[]): QueryResult<R> {
    const customerId = values[0] as string;
    const exists = this.ledger.some(
      (row) => row.customer_id === customerId && row.entry_type === "earn_order",
    );
    return this.result<R>(exists ? ([{ "?column?": 1 } as unknown as R]) : []);
  }

  private appendLedger<R extends QueryResultRow>(values: unknown[]): QueryResult<R> {
    const [customerId, entryType, points, reason, orderReference, , , sourceEventId] = values;
    const row: LedgerRowStore = {
      id: this.nextId("ledg"),
      customer_id: customerId as string,
      entry_type: entryType as string,
      points: points as number,
      reason: reason as string,
      order_reference: (orderReference as number | null) ?? null,
      source_event_id: (sourceEventId as string | null) ?? null,
      created_at: FIXED_CREATED_AT,
    };
    this.ledger.push(row);
    const returned = {
      id: row.id,
      customer_id: row.customer_id,
      entry_type: row.entry_type,
      points: String(row.points), // pg returns BIGINT as string
      reason: row.reason,
      order_reference: row.order_reference === null ? null : String(row.order_reference),
      point_lot_id: null,
      redemption_id: null,
      source_event_id: row.source_event_id,
      created_at: row.created_at,
    };
    return this.result<R>([returned as unknown as R]);
  }

  private insertLot<R extends QueryResultRow>(values: unknown[]): QueryResult<R> {
    const [customerId, ledgerEntryId, points, earnedAt, expiresAt] = values as [
      string,
      string,
      number,
      Date,
      Date | null,
    ];
    const row: PointLotStore = {
      id: this.nextId("lot"),
      customer_id: customerId,
      ledger_entry_id: ledgerEntryId,
      original_points: points,
      remaining_points: points,
      earned_at: earnedAt,
      expires_at: expiresAt,
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

  /** Seed a customer with a given tier / spend to exercise multiplier + monotonicity. */
  seedCustomer(shopifyId: number, tier: string, lifetimeSpend: number): string {
    const cust: CustomerStore = {
      id: this.nextId("cust"),
      shopify_customer_id: shopifyId,
      email: null,
      tier,
      lifetime_spend_gbp: lifetimeSpend,
    };
    this.customers.push(cust);
    return cust.id;
  }

  balanceOf(customerId: string): number {
    return this.ledgerFor(customerId).reduce((sum, row) => sum + row.points, 0);
  }
}

function makeJob(overrides: Partial<WebhookJob> = {}): WebhookJob {
  return {
    webhookId: "wh-order-1",
    topic: ORDERS_PAID_TOPIC,
    shopDomain: "myathoorlondon.myshopify.com",
    payload: {
      id: 5001,
      customer: { id: 1001, email: "buyer@example.com" },
      current_subtotal_price: "45.00",
    },
    ...overrides,
  };
}

// --- Pure helpers -----------------------------------------------------------

describe("computeOrderPoints: floor(eligibleTotal × multiplier) (Req 2.2, Property 7)", () => {
  it("floors Bronze 1x earnings", () => {
    expect(computeOrderPoints(45, 1)).toBe(45);
    expect(computeOrderPoints(45.99, 1)).toBe(45);
  });

  it("floors Silver 1.5x earnings without float drift", () => {
    expect(computeOrderPoints(45, 1.5)).toBe(67); // 67.5 -> 67
    expect(computeOrderPoints(20, 1.5)).toBe(30); // exact integer, no drift to 29
    expect(computeOrderPoints(10.1, 1.5)).toBe(15); // 15.15 -> 15
  });

  it("floors Gold 2x and Royal_VIP 3x earnings", () => {
    expect(computeOrderPoints(33.33, 2)).toBe(66); // 66.66 -> 66
    expect(computeOrderPoints(19.99, 3)).toBe(59); // 59.97 -> 59
  });

  it("returns 0 for sub-point and non-positive totals", () => {
    expect(computeOrderPoints(0.99, 1)).toBe(0);
    expect(computeOrderPoints(0, 1)).toBe(0);
    expect(computeOrderPoints(-10, 2)).toBe(0);
  });
});

describe("addMonths: exact 12-month expiry window (Req 2.6, A1)", () => {
  it("adds 12 months preserving day and time", () => {
    const earned = new Date("2025-01-15T10:00:00.000Z");
    expect(addMonths(earned, 12).toISOString()).toBe("2026-01-15T10:00:00.000Z");
  });

  it("clamps 29 Feb to 28 Feb when the target year is not a leap year", () => {
    const earned = new Date("2024-02-29T00:00:00.000Z");
    expect(addMonths(earned, 12).toISOString()).toBe("2025-02-28T00:00:00.000Z");
  });
});

describe("deriveEligibleTotal: post-discount subtotal excl shipping/tax (A2)", () => {
  it("prefers current_subtotal_price", () => {
    expect(
      deriveEligibleTotal({ id: 1, customer: { id: 2 }, current_subtotal_price: "45.00", subtotal_price: "99.00" }),
    ).toBe(45);
  });

  it("falls back to subtotal_price", () => {
    expect(deriveEligibleTotal({ id: 1, customer: { id: 2 }, subtotal_price: "30.50" })).toBe(30.5);
  });

  it("computes line-items minus discounts as last resort", () => {
    expect(
      deriveEligibleTotal({
        id: 1,
        customer: { id: 2 },
        total_line_items_price: "50.00",
        total_discounts: "8.00",
      }),
    ).toBe(42);
  });

  it("never returns a negative computed subtotal", () => {
    expect(
      deriveEligibleTotal({
        id: 1,
        customer: { id: 2 },
        total_line_items_price: "5.00",
        total_discounts: "9.00",
      }),
    ).toBe(0);
  });
});

// --- earnOrder --------------------------------------------------------------

describe("earnOrder: tiered earning + matching lot (Req 2.2, 2.6, Property 7)", () => {
  it("creates one earn_order of floor(eligibleTotal × multiplier) at the tier-at-time", async () => {
    const db = new FakeDb();
    const repo = new LedgerRepository(db);
    // Seed a Silver customer (1.5x) so the multiplier is exercised.
    const customerId = db.seedCustomer(1001, "silver", 400);

    const outcome = await earnOrder(
      repo,
      { shopifyCustomerId: 1001, shopifyOrderId: 5001, eligibleTotal: 45, sourceEventId: "wh-order-1" },
      db,
    );

    expect(outcome.status).toBe("earned");
    if (outcome.status !== "earned") return;
    expect(outcome.tierAtTime).toBe("silver");
    expect(outcome.orderPoints).toBe(67); // floor(45 * 1.5)

    const orderEntries = db.entriesOfType(customerId, "earn_order");
    expect(orderEntries).toHaveLength(1);
    expect(orderEntries[0]!.points).toBe(67);
    expect(orderEntries[0]!.reason).toBe(ORDER_EARN_REASON);
    expect(orderEntries[0]!.order_reference).toBe(5001);
    expect(orderEntries[0]!.source_event_id).toBe("wh-order-1");

    // Matching lot for the order earning expires exactly 12 months later (Req 2.6).
    const orderLot = db.lots.find((l) => l.ledger_entry_id === orderEntries[0]!.id);
    expect(orderLot).toBeDefined();
    expect(orderLot!.original_points).toBe(67);
    expect(orderLot!.remaining_points).toBe(67);
    expect(orderLot!.expires_at?.toISOString()).toBe(addMonths(orderLot!.earned_at, 12).toISOString());
  });

  it("applies Bronze 1x by default for a brand-new (lazily enrolled) customer", async () => {
    const db = new FakeDb();
    const repo = new LedgerRepository(db);

    const outcome = await earnOrder(
      repo,
      { shopifyCustomerId: 2002, shopifyOrderId: 6001, eligibleTotal: 100 },
      db,
    );

    expect(outcome.status).toBe("earned");
    if (outcome.status !== "earned") return;
    expect(outcome.tierAtTime).toBe("bronze");
    expect(outcome.orderPoints).toBe(100); // floor(100 * 1)
    expect(db.customers.some((c) => c.shopify_customer_id === 2002)).toBe(true);
  });
});

describe("earnOrder: first-purchase +100 exactly once (Req 2.5)", () => {
  it("adds a +100 earn_first_purchase on the first earning order", async () => {
    const db = new FakeDb();
    const repo = new LedgerRepository(db);
    const customerId = db.seedCustomer(1001, "bronze", 0);

    const outcome = await earnOrder(
      repo,
      { shopifyCustomerId: 1001, shopifyOrderId: 5001, eligibleTotal: 50 },
      db,
    );

    expect(outcome.status).toBe("earned");
    if (outcome.status !== "earned") return;
    expect(outcome.firstPurchase).toBe(true);

    const fp = db.entriesOfType(customerId, "earn_first_purchase");
    expect(fp).toHaveLength(1);
    expect(fp[0]!.points).toBe(FIRST_PURCHASE_POINTS);
    expect(fp[0]!.points).toBe(100);
    expect(fp[0]!.reason).toBe(FIRST_PURCHASE_REASON);

    // Balance = 50 (order) + 100 (first purchase).
    expect(db.balanceOf(customerId)).toBe(150);
    // A matching lot exists for the first-purchase earning too (Req 2.6).
    expect(db.lots.some((l) => l.ledger_entry_id === fp[0]!.id && l.original_points === 100)).toBe(true);
  });

  it("does NOT add first-purchase on a second order for the same customer", async () => {
    const db = new FakeDb();
    const repo = new LedgerRepository(db);
    const customerId = db.seedCustomer(1001, "bronze", 0);

    await earnOrder(repo, { shopifyCustomerId: 1001, shopifyOrderId: 5001, eligibleTotal: 50 }, db);
    const second = await earnOrder(
      repo,
      { shopifyCustomerId: 1001, shopifyOrderId: 5002, eligibleTotal: 80 },
      db,
    );

    expect(second.status).toBe("earned");
    if (second.status !== "earned") return;
    expect(second.firstPurchase).toBe(false);

    // Exactly one first-purchase bonus across both orders.
    expect(db.entriesOfType(customerId, "earn_first_purchase")).toHaveLength(1);
    expect(db.entriesOfType(customerId, "earn_order")).toHaveLength(2);
  });
});

describe("earnOrder: non-positive eligible total is a no-op (Req 2.3)", () => {
  it("creates no earning and leaves the balance unchanged when eligibleTotal == 0", async () => {
    const db = new FakeDb();
    const repo = new LedgerRepository(db);
    const customerId = db.seedCustomer(1001, "bronze", 0);

    const outcome = await earnOrder(
      repo,
      { shopifyCustomerId: 1001, shopifyOrderId: 5001, eligibleTotal: 0 },
      db,
    );

    expect(outcome.status).toBe("no_earning");
    expect(db.ledgerFor(customerId)).toHaveLength(0);
    expect(db.lotsFor(customerId)).toHaveLength(0);
    expect(db.balanceOf(customerId)).toBe(0);
    // Spend + tier unchanged.
    expect(db.customerById(customerId)!.lifetime_spend_gbp).toBe(0);
    expect(db.customerById(customerId)!.tier).toBe("bronze");
  });

  it("creates no earning for a negative eligibleTotal", async () => {
    const db = new FakeDb();
    const repo = new LedgerRepository(db);
    const customerId = db.seedCustomer(1001, "bronze", 0);

    const outcome = await earnOrder(
      repo,
      { shopifyCustomerId: 1001, shopifyOrderId: 5001, eligibleTotal: -25 },
      db,
    );

    expect(outcome.status).toBe("no_earning");
    expect(db.ledgerFor(customerId)).toHaveLength(0);
  });
});

describe("earnOrder: tier advances and is never lowered (Property 11 / Req 7.3)", () => {
  it("advances Bronze → Gold when the order pushes lifetime spend over £750", async () => {
    const db = new FakeDb();
    const repo = new LedgerRepository(db);
    // Consistent seed: £200 lifetime spend is squarely Bronze.
    const customerId = db.seedCustomer(1001, "bronze", 200);

    const outcome = await earnOrder(
      repo,
      { shopifyCustomerId: 1001, shopifyOrderId: 5001, eligibleTotal: 600 }, // -> £800 lifetime
      db,
    );

    expect(outcome.status).toBe("earned");
    if (outcome.status !== "earned") return;
    // Multiplier used the tier at time of processing (Bronze), not the advanced tier.
    expect(outcome.tierAtTime).toBe("bronze");
    expect(outcome.orderPoints).toBe(600); // floor(600 * 1)
    // Tier advanced afterwards.
    expect(outcome.tier).toBe("gold");
    expect(db.customerById(customerId)!.tier).toBe("gold");
    expect(db.customerById(customerId)!.lifetime_spend_gbp).toBe(800);
  });

  it("never lowers a retained tier that exceeds the derived tier", async () => {
    const db = new FakeDb();
    const repo = new LedgerRepository(db);
    // Retained Gold but a low recorded spend (e.g. after a policy that never downgrades).
    const customerId = db.seedCustomer(1001, "gold", 100);

    const outcome = await earnOrder(
      repo,
      { shopifyCustomerId: 1001, shopifyOrderId: 5001, eligibleTotal: 50 },
      db,
    );

    expect(outcome.status).toBe("earned");
    if (outcome.status !== "earned") return;
    expect(outcome.tierAtTime).toBe("gold"); // multiplier from retained Gold (2x)
    expect(outcome.orderPoints).toBe(100); // floor(50 * 2)
    expect(outcome.tier).toBe("gold"); // not lowered to bronze/silver
    expect(db.customerById(customerId)!.tier).toBe("gold");
  });
});

describe("earnOrder: order-replay idempotency", () => {
  it("does not double-earn when the same order is processed twice", async () => {
    const db = new FakeDb();
    const repo = new LedgerRepository(db);
    const customerId = db.seedCustomer(1001, "bronze", 0);

    const first = await earnOrder(
      repo,
      { shopifyCustomerId: 1001, shopifyOrderId: 5001, eligibleTotal: 50 },
      db,
    );
    expect(first.status).toBe("earned");
    const balanceAfterFirst = db.balanceOf(customerId);
    const spendAfterFirst = db.customerById(customerId)!.lifetime_spend_gbp;

    const replay = await earnOrder(
      repo,
      { shopifyCustomerId: 1001, shopifyOrderId: 5001, eligibleTotal: 50 },
      db,
    );

    expect(replay.status).toBe("already_earned");
    // No new entries, lots, balance, or spend movement on replay.
    expect(db.entriesOfType(customerId, "earn_order")).toHaveLength(1);
    expect(db.entriesOfType(customerId, "earn_first_purchase")).toHaveLength(1);
    expect(db.balanceOf(customerId)).toBe(balanceAfterFirst);
    expect(db.customerById(customerId)!.lifetime_spend_gbp).toBe(spendAfterFirst);
  });
});

describe("earnOrder: affects only the target customer (Req 2.11)", () => {
  it("credits only the ordering customer, leaving others untouched", async () => {
    const db = new FakeDb();
    const repo = new LedgerRepository(db);
    const a = db.seedCustomer(1001, "bronze", 0);
    const b = db.seedCustomer(2002, "bronze", 0);

    await earnOrder(repo, { shopifyCustomerId: 1001, shopifyOrderId: 5001, eligibleTotal: 50 }, db);

    expect(db.ledgerFor(a).length).toBeGreaterThan(0);
    expect(db.ledgerFor(b)).toHaveLength(0);
    expect(db.balanceOf(b)).toBe(0);
    expect(db.customerById(b)!.lifetime_spend_gbp).toBe(0);
  });
});

// --- handleOrdersPaidJob ----------------------------------------------------

describe("handleOrdersPaidJob: verified/deduped path only", () => {
  it("earns from an orders/paid job, deriving eligibleTotal from the payload", async () => {
    const db = new FakeDb();
    const repo = new LedgerRepository(db);

    const outcome = await handleOrdersPaidJob(makeJob(), { repo, transactor: db });

    expect(outcome).not.toBeNull();
    expect(outcome?.status).toBe("earned");
    if (outcome?.status !== "earned") return;
    // Bronze 1x default on lazy enrolment: floor(45 * 1) = 45, plus +100 first purchase.
    expect(outcome.orderPoints).toBe(45);
    expect(outcome.firstPurchase).toBe(true);
    expect(db.balanceOf(outcome.customerId)).toBe(145);
  });

  it("ignores jobs for other topics (no earning created)", async () => {
    const db = new FakeDb();
    const repo = new LedgerRepository(db);

    const outcome = await handleOrdersPaidJob(
      makeJob({ topic: "customers/create", payload: { id: 999 } }),
      { repo, transactor: db },
    );

    expect(outcome).toBeNull();
    expect(db.ledger).toHaveLength(0);
  });

  it("does not double-earn when the same orders/paid job is reprocessed", async () => {
    const db = new FakeDb();
    const repo = new LedgerRepository(db);

    await handleOrdersPaidJob(makeJob(), { repo, transactor: db });
    const again = await handleOrdersPaidJob(makeJob(), { repo, transactor: db });

    expect(again?.status).toBe("already_earned");
    expect(db.entriesOfType(again!.customerId, "earn_order")).toHaveLength(1);
  });

  it("rejects a payload with no customer to attribute the earning to", async () => {
    const db = new FakeDb();
    const repo = new LedgerRepository(db);

    await expect(
      handleOrdersPaidJob(makeJob({ payload: { id: 5001, current_subtotal_price: "45.00" } }), {
        repo,
        transactor: db,
      }),
    ).rejects.toBeInstanceOf(InvalidOrdersPaidPayloadError);

    expect(db.ledger).toHaveLength(0);
  });
});
