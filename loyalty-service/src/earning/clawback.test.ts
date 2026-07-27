/**
 * Unit tests for refund and cancellation clawback (task 9.1).
 *
 * No live/production database is touched. A fake {@link Queryable} backed by a
 * tiny in-memory store routes the statements the clawback flow issues — the
 * customer resolution by order reference, the totalEarned / already-clawed
 * sums, the duplicate-event guard, the spendable-balance projection, the FIFO
 * lot select-for-update + decrement, the ledger append (via
 * {@link LedgerRepository}), and the optional customer-totals update — so the
 * clawback contract is verified without any Postgres or Shopify Admin API:
 *
 *   - refund full/partial clawback math (Req 4.1, 4.4, 4.5);
 *   - cancellation reverses the order's earned points (Req 4.2);
 *   - cumulative absolute clawback never exceeds totalEarned (Property 8, Req 4.3);
 *   - full refund of a fully-earning order → net order balance 0 (Req 4.4);
 *   - allowNegative-off clamp keeps Spendable_Balance >= 0 (Req 4.6);
 *   - tier retained when allowTierDowngradeOnClawback is off (Req 4.7);
 *   - duplicate event id → no-op (Req 4.9);
 *   - unverified events never reach here: handlers only act on the verified/
 *     deduped job for their own topic and ignore all others (Req 4.8).
 */
import { describe, expect, it } from "vitest";
import type { QueryResult, QueryResultRow } from "pg";
import { LedgerRepository, type Queryable } from "../ledger/repository.js";
import type { WebhookJob } from "../webhooks/enqueue.js";
import {
  clawback,
  CANCELLATION_CLAWBACK_REASON,
  computeRefundRawClawback,
  deriveRefundedEligibleAmount,
  handleOrderCancelledJob,
  handleRefundJob,
  InvalidClawbackPayloadError,
  ORDERS_CANCELLED_TOPIC,
  REFUND_CLAWBACK_REASON,
  REFUNDS_CREATE_TOPIC,
  roundHalfUp,
  type ClawbackPolicy,
  type Transactor,
} from "./clawback.js";

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
  tier: string;
  lifetime_spend_gbp: number;
}

const FIXED_CREATED_AT = new Date("2025-03-01T12:00:00.000Z");
const LOT_EARNED_AT = new Date("2025-01-15T10:00:00.000Z");
// Far-future expiry so seeded lots are always non-expired relative to the test
// clock (Spendable_Balance = SUM of non-expired lot remainders).
const LOT_EXPIRES_AT = new Date("2999-01-15T10:00:00.000Z");

/**
 * An in-memory fake Postgres understanding exactly the statements the clawback
 * flow issues. It keeps customers, a ledger array, and a point_lots array so
 * customer resolution, totals, the duplicate guard, spendable projection, FIFO
 * consumption, and the clawback append all behave realistically.
 */
class FakeDb implements Queryable, Transactor {
  readonly customers: CustomerStore[] = [];
  readonly ledger: LedgerRowStore[] = [];
  readonly lots: PointLotStore[] = [];
  /** tier_change_history rows written by a downgrade (task 46). */
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
    // Order of checks matters: more specific SELECTs before generic ones.
    if (queryText.includes("SELECT customer_id") && queryText.includes("order_reference = $1")) {
      return this.resolveCustomerByOrder<R>(values);
    }
    if (queryText.includes("entry_type = 'clawback'") && queryText.includes("source_event_id = $3")) {
      return this.duplicateGuard<R>(values);
    }
    if (queryText.includes("SUM(points)") && queryText.includes("entry_type IN")) {
      return this.sumEarned<R>(values);
    }
    if (queryText.includes("SUM(points)") && queryText.includes("entry_type = 'clawback'")) {
      return this.sumClawed<R>(values);
    }
    if (queryText.includes("SUM(remaining_points)")) {
      return this.spendable<R>(values);
    }
    if (queryText.includes("FOR UPDATE") && queryText.includes("FROM point_lots")) {
      return this.selectConsumableLots<R>(values);
    }
    if (queryText.includes("UPDATE point_lots") && queryText.includes("remaining_points = remaining_points - $1")) {
      return this.decrementLot<R>(values);
    }
    if (queryText.includes("SELECT tier, lifetime_spend_gbp") && queryText.includes("FROM customers")) {
      return this.customerTotals<R>(values);
    }
    if (queryText.includes("INSERT INTO ledger_entries")) {
      return this.appendLedger<R>(values);
    }
    if (queryText.includes("UPDATE customers")) {
      return this.updateCustomerTotals<R>(values);
    }
    if (queryText.includes("INSERT INTO tier_change_history")) {
      // Task 46: a clawback that actually lowers the tier records the change.
      // Only reachable while allowTierDowngradeOnClawback is enabled (A4).
      const [customerId, fromTier, toTier, reason] = values as [string, string, string, string];
      this.tierChanges.push({
        customer_id: customerId,
        from_tier: fromTier,
        to_tier: toTier,
        reason,
      });
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

  private result<R extends QueryResultRow>(rows: R[]): QueryResult<R> {
    return { rows, rowCount: rows.length, command: "SELECT", oid: 0, fields: [] };
  }

  private resolveCustomerByOrder<R extends QueryResultRow>(values: unknown[]): QueryResult<R> {
    const orderRef = values[0] as number;
    const row = this.ledger.find(
      (r) =>
        r.order_reference === orderRef &&
        ["earn_order", "earn_first_purchase", "earn_referral"].includes(r.entry_type),
    );
    return this.result<R>(row ? ([{ customer_id: row.customer_id } as unknown as R]) : []);
  }

  private duplicateGuard<R extends QueryResultRow>(values: unknown[]): QueryResult<R> {
    const [customerId, orderRef, eventId] = values as [string, number, string];
    const exists = this.ledger.some(
      (r) =>
        r.customer_id === customerId &&
        r.order_reference === orderRef &&
        r.entry_type === "clawback" &&
        r.source_event_id === eventId,
    );
    return this.result<R>(exists ? ([{ "?column?": 1 } as unknown as R]) : []);
  }

  private sumEarned<R extends QueryResultRow>(values: unknown[]): QueryResult<R> {
    const [customerId, orderRef] = values as [string, number];
    const total = this.ledger
      .filter(
        (r) =>
          r.customer_id === customerId &&
          r.order_reference === orderRef &&
          ["earn_order", "earn_first_purchase", "earn_referral"].includes(r.entry_type),
      )
      .reduce((s, r) => s + r.points, 0);
    return this.result<R>([{ total: String(total) } as unknown as R]);
  }

  private sumClawed<R extends QueryResultRow>(values: unknown[]): QueryResult<R> {
    const [customerId, orderRef] = values as [string, number];
    const total = this.ledger
      .filter(
        (r) =>
          r.customer_id === customerId &&
          r.order_reference === orderRef &&
          r.entry_type === "clawback",
      )
      .reduce((s, r) => s + r.points, 0);
    return this.result<R>([{ total: String(total) } as unknown as R]);
  }

  private spendable<R extends QueryResultRow>(values: unknown[]): QueryResult<R> {
    const [customerId, asOf] = values as [string, Date];
    const total = this.lots
      .filter(
        (l) =>
          l.customer_id === customerId &&
          l.remaining_points > 0 &&
          (l.expires_at === null || l.expires_at > asOf),
      )
      .reduce((s, l) => s + l.remaining_points, 0);
    return this.result<R>([{ spendable: String(total) } as unknown as R]);
  }

  private selectConsumableLots<R extends QueryResultRow>(values: unknown[]): QueryResult<R> {
    const [customerId, asOf] = values as [string, Date];
    const rows = this.lots
      .filter(
        (l) =>
          l.customer_id === customerId &&
          l.remaining_points > 0 &&
          (l.expires_at === null || l.expires_at > asOf),
      )
      .sort((a, b) => a.earned_at.getTime() - b.earned_at.getTime())
      .map((l) => ({
        id: l.id,
        remaining_points: String(l.remaining_points),
        earned_at: l.earned_at,
        expires_at: l.expires_at,
      }));
    return this.result<R>(rows as unknown as R[]);
  }

  private decrementLot<R extends QueryResultRow>(values: unknown[]): QueryResult<R> {
    const [take, lotId] = values as [number, string];
    const lot = this.lots.find((l) => l.id === lotId);
    if (lot) {
      lot.remaining_points -= take;
    }
    return this.result<R>([]);
  }

  private customerTotals<R extends QueryResultRow>(values: unknown[]): QueryResult<R> {
    const customerId = values[0] as string;
    const cust = this.customers.find((c) => c.id === customerId);
    return this.result<R>(
      cust
        ? ([{ tier: cust.tier, lifetime_spend_gbp: String(cust.lifetime_spend_gbp) } as unknown as R])
        : [],
    );
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
      points: String(row.points),
      reason: row.reason,
      order_reference: row.order_reference === null ? null : String(row.order_reference),
      point_lot_id: null,
      redemption_id: null,
      source_event_id: row.source_event_id,
      created_at: row.created_at,
    };
    return this.result<R>([returned as unknown as R]);
  }

  private updateCustomerTotals<R extends QueryResultRow>(values: unknown[]): QueryResult<R> {
    const [customerId, moneyBack, tier] = values as [string, number, string];
    const cust = this.customers.find((c) => c.id === customerId);
    if (cust) {
      cust.lifetime_spend_gbp = Math.max(0, cust.lifetime_spend_gbp - moneyBack);
      cust.tier = tier;
    }
    return this.result<R>([]);
  }

  // --- seeding + assertions helpers ---------------------------------------

  seedCustomer(shopifyId: number, tier: string, lifetimeSpend: number): string {
    const cust: CustomerStore = {
      id: this.nextId("cust"),
      shopify_customer_id: shopifyId,
      tier,
      lifetime_spend_gbp: lifetimeSpend,
    };
    this.customers.push(cust);
    return cust.id;
  }

  /** Seed an earn entry + a matching consumable lot (mirrors order.ts). */
  seedEarning(
    customerId: string,
    entryType: string,
    points: number,
    orderRef: number | null,
  ): void {
    const entry: LedgerRowStore = {
      id: this.nextId("ledg"),
      customer_id: customerId,
      entry_type: entryType,
      points,
      reason: entryType,
      order_reference: orderRef,
      source_event_id: null,
      created_at: LOT_EARNED_AT,
    };
    this.ledger.push(entry);
    this.lots.push({
      id: this.nextId("lot"),
      customer_id: customerId,
      ledger_entry_id: entry.id,
      original_points: points,
      remaining_points: points,
      earned_at: LOT_EARNED_AT,
      expires_at: LOT_EXPIRES_AT,
    });
  }

  balanceOf(customerId: string): number {
    return this.ledger
      .filter((r) => r.customer_id === customerId)
      .reduce((s, r) => s + r.points, 0);
  }

  spendableOf(customerId: string): number {
    return this.lots
      .filter((l) => l.customer_id === customerId && l.remaining_points > 0)
      .reduce((s, l) => s + l.remaining_points, 0);
  }

  clawbacksFor(customerId: string, orderRef: number): LedgerRowStore[] {
    return this.ledger.filter(
      (r) =>
        r.customer_id === customerId &&
        r.order_reference === orderRef &&
        r.entry_type === "clawback",
    );
  }

  customerById(id: string): CustomerStore | undefined {
    return this.customers.find((c) => c.id === id);
  }
}

// --- Pure helpers -----------------------------------------------------------

describe("roundHalfUp: nearest whole point, 0.5 rounds up (Req 4.1)", () => {
  it("rounds halves up and keeps whole numbers", () => {
    expect(roundHalfUp(2.5)).toBe(3);
    expect(roundHalfUp(2.49)).toBe(2);
    expect(roundHalfUp(2.51)).toBe(3);
    expect(roundHalfUp(10)).toBe(10);
  });

  it("returns 0 for non-positive or non-finite input", () => {
    expect(roundHalfUp(0)).toBe(0);
    expect(roundHalfUp(-5)).toBe(0);
    expect(roundHalfUp(Number.NaN)).toBe(0);
  });
});

describe("computeRefundRawClawback: rate vs fraction form (Req 4.1/4.4/4.5)", () => {
  it("rate form: round(refundedEligibleAmount × earnRate)", () => {
    // £30 refunded at Silver 1.5x = 45 points.
    expect(
      computeRefundRawClawback({ refundedEligibleAmount: 30, earnRate: 1.5, totalEarned: 999 }),
    ).toBe(45);
    // £19.99 at 1x rounds 19.99 -> 20 (0.5 up on .99 obviously up).
    expect(
      computeRefundRawClawback({ refundedEligibleAmount: 19.99, earnRate: 1, totalEarned: 999 }),
    ).toBe(20);
  });

  it("fraction form (preferred when originalEligibleTotal > 0): round(totalEarned × refunded/original)", () => {
    // Half the order refunded -> half of everything earned.
    expect(
      computeRefundRawClawback({
        refundedEligibleAmount: 50,
        originalEligibleTotal: 100,
        totalEarned: 145,
      }),
    ).toBe(73); // 72.5 -> 73 (0.5 up)
    // Full refund -> all earnings (net 0 later).
    expect(
      computeRefundRawClawback({
        refundedEligibleAmount: 100,
        originalEligibleTotal: 100,
        totalEarned: 145,
      }),
    ).toBe(145);
  });

  it("caps the fraction at 1 when refunded exceeds original", () => {
    expect(
      computeRefundRawClawback({
        refundedEligibleAmount: 150,
        originalEligibleTotal: 100,
        totalEarned: 145,
      }),
    ).toBe(145);
  });

  it("returns 0 for non-positive amounts or rates", () => {
    expect(computeRefundRawClawback({ refundedEligibleAmount: 0, earnRate: 2, totalEarned: 99 })).toBe(0);
    expect(computeRefundRawClawback({ refundedEligibleAmount: 10, earnRate: 0, totalEarned: 99 })).toBe(0);
  });
});

describe("deriveRefundedEligibleAmount: sums refund line-item subtotals", () => {
  it("prefers explicit subtotal", () => {
    expect(
      deriveRefundedEligibleAmount({
        order_id: 1,
        refund_line_items: [{ subtotal: "30.00" }, { subtotal: "12.50" }],
      }),
    ).toBe(42.5);
  });

  it("falls back to subtotal_set.shop_money.amount", () => {
    expect(
      deriveRefundedEligibleAmount({
        order_id: 1,
        refund_line_items: [{ subtotal_set: { shop_money: { amount: "15.00" } } }],
      }),
    ).toBe(15);
  });

  it("returns 0 when there are no refund line items", () => {
    expect(deriveRefundedEligibleAmount({ order_id: 1 })).toBe(0);
  });
});

// --- clawback: refund math --------------------------------------------------

describe("clawback (refund): full refund → net order-attributable balance 0 (Req 4.4)", () => {
  it("claws back exactly what the order earned on a full refund", async () => {
    const db = new FakeDb();
    const repo = new LedgerRepository(db);
    const customerId = db.seedCustomer(1001, "bronze", 100);
    // A fully-earning order: 45 (order) + 100 (first purchase) = 145.
    db.seedEarning(customerId, "earn_order", 45, 5001);
    db.seedEarning(customerId, "earn_first_purchase", 100, 5001);
    expect(db.balanceOf(customerId)).toBe(145);

    const outcome = await clawback(
      repo,
      {
        orderReference: 5001,
        mode: "refund",
        refundedEligibleAmount: 100, // full eligible refunded
        originalEligibleTotal: 100,
        sourceEventId: "wh-refund-1",
      },
      db,
    );

    expect(outcome.status).toBe("clawed_back");
    if (outcome.status !== "clawed_back") return;
    expect(outcome.clawbackPoints).toBe(145);
    expect(outcome.cumulativeClawback).toBe(145);
    expect(outcome.totalEarned).toBe(145);
    // Net order-attributable balance is 0.
    expect(db.balanceOf(customerId)).toBe(0);
    expect(db.spendableOf(customerId)).toBe(0);
    const cb = db.clawbacksFor(customerId, 5001);
    expect(cb).toHaveLength(1);
    expect(cb[0]!.points).toBe(-145);
    expect(cb[0]!.reason).toBe(REFUND_CLAWBACK_REASON);
  });
});

describe("clawback (refund): partial refund is proportional and bounded (Req 4.5)", () => {
  it("claws back the refunded fraction of the order's earnings", async () => {
    const db = new FakeDb();
    const repo = new LedgerRepository(db);
    const customerId = db.seedCustomer(1001, "bronze", 100);
    db.seedEarning(customerId, "earn_order", 100, 5001); // totalEarned = 100

    const outcome = await clawback(
      repo,
      {
        orderReference: 5001,
        mode: "refund",
        refundedEligibleAmount: 40,
        originalEligibleTotal: 100,
        sourceEventId: "wh-refund-1",
      },
      db,
    );

    expect(outcome.status).toBe("clawed_back");
    if (outcome.status !== "clawed_back") return;
    expect(outcome.clawbackPoints).toBe(40); // 40% of 100
    expect(db.balanceOf(customerId)).toBe(60);
    expect(db.spendableOf(customerId)).toBe(60);
  });

  it("uses the rate form when the original eligible total is not supplied (Req 4.1)", async () => {
    const db = new FakeDb();
    const repo = new LedgerRepository(db);
    const customerId = db.seedCustomer(1001, "silver", 400);
    db.seedEarning(customerId, "earn_order", 300, 5001); // plenty of head-room

    const outcome = await clawback(
      repo,
      {
        orderReference: 5001,
        mode: "refund",
        refundedEligibleAmount: 30,
        earnRate: 1.5, // Silver
        sourceEventId: "wh-refund-1",
      },
      db,
    );

    expect(outcome.status).toBe("clawed_back");
    if (outcome.status !== "clawed_back") return;
    expect(outcome.clawbackPoints).toBe(45); // round(30 × 1.5)
    expect(db.balanceOf(customerId)).toBe(255);
  });
});

describe("clawback: cumulative absolute clawback never exceeds totalEarned (Property 8, Req 4.3)", () => {
  it("bounds a sequence of refunds to totalEarned", async () => {
    const db = new FakeDb();
    const repo = new LedgerRepository(db);
    const customerId = db.seedCustomer(1001, "bronze", 100);
    db.seedEarning(customerId, "earn_order", 100, 5001); // totalEarned = 100

    // First refund: 70% → 70.
    const first = await clawback(
      repo,
      { orderReference: 5001, mode: "refund", refundedEligibleAmount: 70, originalEligibleTotal: 100, sourceEventId: "wh-1" },
      db,
    );
    expect(first.status === "clawed_back" && first.clawbackPoints).toBe(70);

    // Second refund also claims 70% → raw 70, but only 30 head-room remains.
    const second = await clawback(
      repo,
      { orderReference: 5001, mode: "refund", refundedEligibleAmount: 70, originalEligibleTotal: 100, sourceEventId: "wh-2" },
      db,
    );
    expect(second.status).toBe("clawed_back");
    if (second.status !== "clawed_back") return;
    expect(second.clawbackPoints).toBe(30); // bounded to remaining
    expect(second.cumulativeClawback).toBe(100);

    // A third refund has no head-room left → no-op.
    const third = await clawback(
      repo,
      { orderReference: 5001, mode: "refund", refundedEligibleAmount: 50, originalEligibleTotal: 100, sourceEventId: "wh-3" },
      db,
    );
    expect(third.status).toBe("no_op");

    // Cumulative absolute clawback == totalEarned, never more.
    const totalClawed = db
      .clawbacksFor(customerId, 5001)
      .reduce((s, r) => s + Math.abs(r.points), 0);
    expect(totalClawed).toBe(100);
    expect(db.balanceOf(customerId)).toBe(0);
  });
});

// --- clawback: cancellation -------------------------------------------------

describe("clawback (cancellation): reverses the order's earned points (Req 4.2)", () => {
  it("claws back the full remaining earning for the order", async () => {
    const db = new FakeDb();
    const repo = new LedgerRepository(db);
    const customerId = db.seedCustomer(1001, "bronze", 80);
    db.seedEarning(customerId, "earn_order", 80, 6001);
    db.seedEarning(customerId, "earn_first_purchase", 100, 6001); // totalEarned = 180

    const outcome = await clawback(
      repo,
      { orderReference: 6001, mode: "cancellation", sourceEventId: "wh-cancel-1" },
      db,
    );

    expect(outcome.status).toBe("clawed_back");
    if (outcome.status !== "clawed_back") return;
    expect(outcome.clawbackPoints).toBe(180);
    expect(outcome.cumulativeClawback).toBe(180);
    expect(db.balanceOf(customerId)).toBe(0);
    const cb = db.clawbacksFor(customerId, 6001);
    expect(cb[0]!.reason).toBe(CANCELLATION_CLAWBACK_REASON);
  });

  it("reverses only the remaining earning after a prior partial refund", async () => {
    const db = new FakeDb();
    const repo = new LedgerRepository(db);
    const customerId = db.seedCustomer(1001, "bronze", 100);
    db.seedEarning(customerId, "earn_order", 100, 6001);

    await clawback(
      repo,
      { orderReference: 6001, mode: "refund", refundedEligibleAmount: 30, originalEligibleTotal: 100, sourceEventId: "wh-r" },
      db,
    );
    const cancel = await clawback(
      repo,
      { orderReference: 6001, mode: "cancellation", sourceEventId: "wh-c" },
      db,
    );

    expect(cancel.status).toBe("clawed_back");
    if (cancel.status !== "clawed_back") return;
    expect(cancel.clawbackPoints).toBe(70); // 100 total − 30 already clawed
    expect(cancel.cumulativeClawback).toBe(100);
    expect(db.balanceOf(customerId)).toBe(0);
  });
});

// --- clawback: clamp, tier, duplicate, no-op --------------------------------

describe("clawback: allowNegative-off clamp keeps Spendable_Balance >= 0 (Req 4.6)", () => {
  it("clamps the clawback to the available spendable balance", async () => {
    const db = new FakeDb();
    const repo = new LedgerRepository(db);
    const customerId = db.seedCustomer(1001, "bronze", 100);
    // Earned 100 on the order, but only 30 remains spendable (rest already spent).
    db.seedEarning(customerId, "earn_order", 100, 5001);
    // Simulate 70 already spent by reducing the lot remainder directly.
    db.lots[0]!.remaining_points = 30;
    expect(db.spendableOf(customerId)).toBe(30);

    const outcome = await clawback(
      repo,
      { orderReference: 5001, mode: "cancellation", sourceEventId: "wh-c" },
      db,
    );

    expect(outcome.status).toBe("clawed_back");
    if (outcome.status !== "clawed_back") return;
    // Desired was 100, clamped to 30 so spendable can't go negative.
    expect(outcome.clawbackPoints).toBe(30);
    expect(outcome.lotsConsumed).toBe(30);
    expect(db.spendableOf(customerId)).toBe(0);
    expect(db.spendableOf(customerId)).toBeGreaterThanOrEqual(0);
  });

  it("records the full magnitude (driving balance negative) when allowNegative is on", async () => {
    const db = new FakeDb();
    const repo = new LedgerRepository(db);
    const policy: ClawbackPolicy = { allowNegative: true, allowTierDowngradeOnClawback: false };
    const customerId = db.seedCustomer(1001, "bronze", 100);
    db.seedEarning(customerId, "earn_order", 100, 5001);
    db.lots[0]!.remaining_points = 30; // only 30 spendable

    const outcome = await clawback(
      repo,
      { orderReference: 5001, mode: "cancellation", sourceEventId: "wh-c", policy },
      db,
    );

    expect(outcome.status).toBe("clawed_back");
    if (outcome.status !== "clawed_back") return;
    expect(outcome.clawbackPoints).toBe(100); // full desired
    expect(outcome.lotsConsumed).toBe(30); // lots can't go below zero
    expect(db.spendableOf(customerId)).toBe(0);
    // Balance: 100 earned − 100 clawback = 0 in ledger terms here (single order).
    expect(db.balanceOf(customerId)).toBe(0);
  });
});

describe("clawback: tier retained when downgrade disabled (Req 4.7, A4)", () => {
  it("does not lower the customer's tier by default", async () => {
    const db = new FakeDb();
    const repo = new LedgerRepository(db);
    // Gold customer (£800 spend), refund would drop spend below Gold if applied.
    const customerId = db.seedCustomer(1001, "gold", 800);
    db.seedEarning(customerId, "earn_order", 800, 5001);

    const outcome = await clawback(
      repo,
      { orderReference: 5001, mode: "refund", refundedEligibleAmount: 800, originalEligibleTotal: 800, sourceEventId: "wh-r" },
      db,
    );

    expect(outcome.status).toBe("clawed_back");
    if (outcome.status !== "clawed_back") return;
    expect(outcome.tier).toBe("gold");
    expect(outcome.tierRetained).toBe(true);
    expect(db.customerById(customerId)!.tier).toBe("gold");
    // Lifetime spend untouched when downgrade is disabled.
    expect(db.customerById(customerId)!.lifetime_spend_gbp).toBe(800);
    // Task 46: no tier change happened, so no history row is written. This is
    // the DEFAULT policy, so tier history adds nothing to default behaviour.
    expect(db.tierChanges).toEqual([]);
  });

  it("recomputes the tier downward when downgrade is enabled", async () => {
    const db = new FakeDb();
    const repo = new LedgerRepository(db);
    const policy: ClawbackPolicy = { allowNegative: false, allowTierDowngradeOnClawback: true };
    const customerId = db.seedCustomer(1001, "gold", 800);
    db.seedEarning(customerId, "earn_order", 800, 5001);

    const outcome = await clawback(
      repo,
      {
        orderReference: 5001,
        mode: "refund",
        refundedEligibleAmount: 600, // £800 − £600 = £200 → Bronze
        originalEligibleTotal: 800,
        sourceEventId: "wh-r",
        policy,
      },
      db,
    );

    expect(outcome.status).toBe("clawed_back");
    if (outcome.status !== "clawed_back") return;
    expect(outcome.tier).toBe("bronze");
    expect(outcome.tierRetained).toBe(false);
    expect(db.customerById(customerId)!.tier).toBe("bronze");
    expect(db.customerById(customerId)!.lifetime_spend_gbp).toBe(200);
    // Task 46: a downgrade IS a tier change, so it is recorded once, with the
    // clawback reason, atomically with the tier UPDATE.
    expect(db.tierChanges).toEqual([
      { customer_id: customerId, from_tier: "gold", to_tier: "bronze", reason: "clawback" },
    ]);
  });
});

describe("clawback: duplicate event id → no-op (Req 4.9)", () => {
  it("creates no additional clawback for an already-processed event id", async () => {
    const db = new FakeDb();
    const repo = new LedgerRepository(db);
    const customerId = db.seedCustomer(1001, "bronze", 100);
    db.seedEarning(customerId, "earn_order", 100, 5001);

    const first = await clawback(
      repo,
      { orderReference: 5001, mode: "refund", refundedEligibleAmount: 40, originalEligibleTotal: 100, sourceEventId: "evt-dup" },
      db,
    );
    expect(first.status).toBe("clawed_back");
    const balanceAfter = db.balanceOf(customerId);

    const replay = await clawback(
      repo,
      { orderReference: 5001, mode: "refund", refundedEligibleAmount: 40, originalEligibleTotal: 100, sourceEventId: "evt-dup" },
      db,
    );

    expect(replay.status).toBe("no_op");
    if (replay.status === "no_op") {
      expect(replay.reason).toBe("duplicate_event");
    }
    expect(db.clawbacksFor(customerId, 5001)).toHaveLength(1);
    expect(db.balanceOf(customerId)).toBe(balanceAfter);
  });
});

describe("clawback: no earnings for the order → no-op", () => {
  it("returns no_op when no customer/earnings are attributable to the order", async () => {
    const db = new FakeDb();
    const repo = new LedgerRepository(db);

    const outcome = await clawback(
      repo,
      { orderReference: 9999, mode: "cancellation", sourceEventId: "wh-x" },
      db,
    );

    expect(outcome.status).toBe("no_op");
    if (outcome.status === "no_op") {
      expect(outcome.customerId).toBeNull();
      expect(outcome.reason).toBe("no_earnings");
    }
    expect(db.ledger).toHaveLength(0);
  });
});

// --- handlers: verified/deduped path only (Req 4.8) -------------------------

describe("handleRefundJob: verified/deduped path only", () => {
  it("claws back from a refunds/create job, deriving the refunded amount", async () => {
    const db = new FakeDb();
    const repo = new LedgerRepository(db);
    const customerId = db.seedCustomer(1001, "bronze", 100);
    db.seedEarning(customerId, "earn_order", 100, 5001);

    const job: WebhookJob = {
      webhookId: "wh-refund-1",
      topic: REFUNDS_CREATE_TOPIC,
      shopDomain: "myathoorlondon.myshopify.com",
      payload: { order_id: 5001, refund_line_items: [{ subtotal: "40.00" }] },
    };

    const outcome = await handleRefundJob(job, { repo, transactor: db });
    expect(outcome?.status).toBe("clawed_back");
    if (outcome?.status !== "clawed_back") return;
    // Rate form (no original supplied), Bronze default 1x → round(40 × 1) = 40.
    expect(outcome.clawbackPoints).toBe(40);
    expect(db.balanceOf(customerId)).toBe(60);
  });

  it("ignores jobs for other topics (no clawback created)", async () => {
    const db = new FakeDb();
    const repo = new LedgerRepository(db);
    const customerId = db.seedCustomer(1001, "bronze", 100);
    db.seedEarning(customerId, "earn_order", 100, 5001);

    const outcome = await handleRefundJob(
      { webhookId: "x", topic: "orders/paid", shopDomain: "d", payload: { id: 5001 } },
      { repo, transactor: db },
    );

    expect(outcome).toBeNull();
    expect(db.clawbacksFor(customerId, 5001)).toHaveLength(0);
  });

  it("rejects a refund payload with no usable order id", async () => {
    const db = new FakeDb();
    const repo = new LedgerRepository(db);

    await expect(
      handleRefundJob(
        { webhookId: "x", topic: REFUNDS_CREATE_TOPIC, shopDomain: "d", payload: { refund_line_items: [] } },
        { repo, transactor: db },
      ),
    ).rejects.toBeInstanceOf(InvalidClawbackPayloadError);
  });
});

describe("handleOrderCancelledJob: verified/deduped path only", () => {
  it("reverses an order's earnings from an orders/cancelled job", async () => {
    const db = new FakeDb();
    const repo = new LedgerRepository(db);
    const customerId = db.seedCustomer(1001, "bronze", 100);
    db.seedEarning(customerId, "earn_order", 100, 7001);
    db.seedEarning(customerId, "earn_first_purchase", 100, 7001);

    const outcome = await handleOrderCancelledJob(
      { webhookId: "wh-c", topic: ORDERS_CANCELLED_TOPIC, shopDomain: "d", payload: { id: 7001 } },
      { repo, transactor: db },
    );

    expect(outcome?.status).toBe("clawed_back");
    if (outcome?.status !== "clawed_back") return;
    expect(outcome.clawbackPoints).toBe(200);
    expect(db.balanceOf(customerId)).toBe(0);
  });

  it("ignores jobs for other topics", async () => {
    const db = new FakeDb();
    const repo = new LedgerRepository(db);

    const outcome = await handleOrderCancelledJob(
      { webhookId: "x", topic: REFUNDS_CREATE_TOPIC, shopDomain: "d", payload: { order_id: 1 } },
      { repo, transactor: db },
    );

    expect(outcome).toBeNull();
  });
});
