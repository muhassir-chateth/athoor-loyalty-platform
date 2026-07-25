/**
 * Property-based test for Property 8 (Refund conservation) — task 9.2.
 *
 * **Validates: Requirements 4.3**
 *
 * Property 8 (from design.md "Correctness Properties"):
 *   `clawback(f) <= totalEarned(o)` — for any order, the cumulative absolute
 *   clawback stays within `[0, totalEarned(order)]`; and a full refund of a
 *   fully-earning order claws back EXACTLY what the order earned (net
 *   order-attributable balance 0).
 *
 * This exercises the APPROVED implementation of {@link clawback} (task 9.1)
 * across many arbitrary orders (arbitrary eligible amount + tier/earn rate)
 * and arbitrary refund sequences, asserting two universal facts:
 *
 *   (8a) Conservation bound — after ANY prefix of an arbitrary refund sequence
 *        (each refund may even over-claim more than the order earned), the
 *        cumulative absolute clawback recorded against the order is in
 *        `[0, totalEarned]`, the ledger balance for the order never drops below
 *        zero, and Spendable_Balance stays >= 0 (allowNegative off, A7).
 *
 *   (8b) Full refund of a fully-earning order — a single full refund
 *        (refunded eligible == original eligible) claws back exactly
 *        `totalEarned`, leaving the net order-attributable balance at 0
 *        (Req 4.4).
 *
 * `totalEarned` is computed here from an INDEPENDENT integer (pence ·
 * rational-multiplier) oracle plus the fixed +100 first-purchase bonus, so the
 * assertions do not merely restate the code under test.
 *
 * No live/production system is touched: {@link clawback} is driven against a
 * tiny self-contained in-memory {@link Queryable} fake (the same technique used
 * by the unit tests in `clawback.test.ts`), so there is no Postgres or Shopify
 * Admin API dependency. This is a verification task — the approved
 * implementation is NOT changed.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { QueryResult, QueryResultRow } from "pg";
import { LedgerRepository, type Queryable } from "../ledger/repository.js";
import { clawback, type Transactor } from "./clawback.js";
import { TIERS, type Tier } from "../tier/tier.js";

// --- In-memory fake Postgres (self-contained; all constants defined here) ---

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

/** Fixed clock timestamps so seeded lots are always non-expired in-test. */
const LOT_EARNED_AT = new Date("2025-01-15T10:00:00.000Z");
const LOT_EXPIRES_AT = new Date("2999-01-15T10:00:00.000Z");
const CLAWBACK_CREATED_AT = new Date("2025-03-01T12:00:00.000Z");

/**
 * An in-memory fake Postgres understanding exactly the statements the clawback
 * flow issues: customer resolution by order reference, the totalEarned /
 * already-clawed sums, the duplicate-event guard, the Spendable_Balance
 * projection, the FIFO select-for-update + decrement, the ledger append (via
 * {@link LedgerRepository}), and the optional customer-totals read/update — so
 * the Property-8 contract is verified with no Postgres or Shopify Admin API.
 */
class FakeDb implements Queryable, Transactor {
  readonly customers: CustomerStore[] = [];
  readonly ledger: LedgerRowStore[] = [];
  readonly lots: PointLotStore[] = [];
  private seq = 0;

  async query<R extends QueryResultRow = QueryResultRow>(
    queryText: string,
    values: unknown[] = [],
  ): Promise<QueryResult<R>> {
    // Order of checks matters: more specific SELECTs before generic ones.
    if (queryText.includes("SELECT customer_id") && queryText.includes("order_reference = $1")) {
      return this.resolveCustomerByOrder<R>(values);
    }
    if (
      queryText.includes("entry_type = 'clawback'") &&
      queryText.includes("source_event_id = $3")
    ) {
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
    if (
      queryText.includes("UPDATE point_lots") &&
      queryText.includes("remaining_points = remaining_points - $1")
    ) {
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
    return this.result<R>(row ? [{ customer_id: row.customer_id } as unknown as R] : []);
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
    return this.result<R>(exists ? [{ "?column?": 1 } as unknown as R] : []);
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
        ? [{ tier: cust.tier, lifetime_spend_gbp: String(cust.lifetime_spend_gbp) } as unknown as R]
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
      created_at: CLAWBACK_CREATED_AT,
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

  private updateCustomerTotals<R extends QueryResultRow>(values: unknown[]): QueryResult<R> {
    const [customerId, moneyBack, tier] = values as [string, number, string];
    const cust = this.customers.find((c) => c.id === customerId);
    if (cust) {
      cust.lifetime_spend_gbp = Math.max(0, cust.lifetime_spend_gbp - moneyBack);
      cust.tier = tier;
    }
    return this.result<R>([]);
  }

  // --- seeding + assertion helpers ----------------------------------------

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
  seedEarning(customerId: string, entryType: string, points: number, orderRef: number): void {
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

  /** Ledger balance for an order = SUM(points) of that order's entries. */
  orderBalance(customerId: string, orderRef: number): number {
    return this.ledger
      .filter((r) => r.customer_id === customerId && r.order_reference === orderRef)
      .reduce((s, r) => s + r.points, 0);
  }

  spendableOf(customerId: string): number {
    return this.lots
      .filter((l) => l.customer_id === customerId && l.remaining_points > 0)
      .reduce((s, l) => s + l.remaining_points, 0);
  }

  cumulativeClawback(customerId: string, orderRef: number): number {
    return this.ledger
      .filter(
        (r) =>
          r.customer_id === customerId &&
          r.order_reference === orderRef &&
          r.entry_type === "clawback",
      )
      .reduce((s, r) => s + Math.abs(r.points), 0);
  }
}

// --- Independent earn oracle ------------------------------------------------

/**
 * Each tier multiplier expressed as an exact rational `num/den`, so the
 * expected earning can be computed with pure integer arithmetic on pence,
 * free of binary-float drift, WITHOUT reusing the implementation's maths.
 */
const TIER_MULTIPLIER_RATIONAL: Readonly<Record<Tier, readonly [number, number]>> = {
  bronze: [1, 1],
  silver: [3, 2],
  gold: [2, 1],
  royal_vip: [3, 1],
};

/** The fixed first-purchase bonus (design.md / Req 2.5). */
const FIRST_PURCHASE_BONUS = 100;

/** floor(eligibleTotal × multiplier(tier)) computed from integer pence. */
function expectedOrderEarn(pence: number, tier: Tier): number {
  const [num, den] = TIER_MULTIPLIER_RATIONAL[tier];
  return Math.floor((pence * num) / (den * 100));
}

// --- Arbitraries ------------------------------------------------------------

const tierArb: fc.Arbitrary<Tier> = fc.constantFrom(...TIERS);

/** Strictly-positive money in whole pence (£0.01 .. £10,000) — exact 2dp. */
const eligiblePenceArb: fc.Arbitrary<number> = fc.integer({ min: 1, max: 1_000_000 });

let orderSeq = 8_000_000;
const nextOrderId = () => (orderSeq += 1);

// --- Property 8a: cumulative absolute clawback stays within [0, totalEarned] -

describe("Property 8 (Refund conservation) — Requirement 4.3", () => {
  it("cumulative absolute clawback stays within [0, totalEarned] across any refund sequence", async () => {
    await fc.assert(
      fc.asyncProperty(
        tierArb,
        eligiblePenceArb,
        fc.boolean(), // whether this order carries the +100 first-purchase bonus
        // Refund sequence: each refund claims a fraction of the original in
        // pence; the max exceeds the original so refunds can over-claim and we
        // verify the [0, totalEarned] ceiling is respected regardless.
        fc.array(fc.integer({ min: 1, max: 2_000_000 }), { minLength: 1, maxLength: 8 }),
        async (tier, pence, withFirstPurchase, refundPenceList) => {
          const orderEarn = expectedOrderEarn(pence, tier);
          const totalEarned = orderEarn + (withFirstPurchase ? FIRST_PURCHASE_BONUS : 0);

          const db = new FakeDb();
          const repo = new LedgerRepository(db);
          const orderRef = nextOrderId();
          const customerId = db.seedCustomer(orderRef, tier, pence / 100);

          if (orderEarn > 0) {
            db.seedEarning(customerId, "earn_order", orderEarn, orderRef);
          }
          if (withFirstPurchase) {
            db.seedEarning(customerId, "earn_first_purchase", FIRST_PURCHASE_BONUS, orderRef);
          }

          const originalEligibleTotal = pence / 100;
          let refundIndex = 0;

          for (const refundPence of refundPenceList) {
            refundIndex += 1;
            const outcome = await clawback(
              repo,
              {
                orderReference: orderRef,
                mode: "refund",
                refundedEligibleAmount: refundPence / 100,
                originalEligibleTotal,
                sourceEventId: `wh-refund-${refundIndex}`,
              },
              db,
            );

            // Every event is either a bounded clawback or a benign no-op.
            if (outcome.status === "clawed_back") {
              // Per-event report respects the Property-8 ceiling.
              expect(outcome.totalEarned).toBe(totalEarned);
              expect(outcome.clawbackPoints).toBeGreaterThan(0);
              expect(outcome.cumulativeClawback).toBeGreaterThanOrEqual(0);
              expect(outcome.cumulativeClawback).toBeLessThanOrEqual(totalEarned);
            }

            // Persisted cumulative absolute clawback stays within [0, totalEarned].
            const cumulative = db.cumulativeClawback(customerId, orderRef);
            expect(cumulative).toBeGreaterThanOrEqual(0);
            expect(cumulative).toBeLessThanOrEqual(totalEarned);

            // Ledger balance for the order never drops below zero, and
            // Spendable_Balance stays >= 0 (allowNegative off, A7).
            expect(db.orderBalance(customerId, orderRef)).toBeGreaterThanOrEqual(0);
            expect(db.spendableOf(customerId)).toBeGreaterThanOrEqual(0);
          }
        },
      ),
    );
  });

  // --- Property 8b: full refund of a fully-earning order → net balance 0 ----

  it("a full refund of a fully-earning order claws back exactly what it earned (net order balance 0)", async () => {
    await fc.assert(
      fc.asyncProperty(
        tierArb,
        eligiblePenceArb,
        fc.boolean(),
        async (tier, pence, withFirstPurchase) => {
          const orderEarn = expectedOrderEarn(pence, tier);
          const totalEarned = orderEarn + (withFirstPurchase ? FIRST_PURCHASE_BONUS : 0);
          // Only meaningful when the order actually earned something.
          fc.pre(totalEarned > 0);

          const db = new FakeDb();
          const repo = new LedgerRepository(db);
          const orderRef = nextOrderId();
          const customerId = db.seedCustomer(orderRef, tier, pence / 100);

          if (orderEarn > 0) {
            db.seedEarning(customerId, "earn_order", orderEarn, orderRef);
          }
          if (withFirstPurchase) {
            db.seedEarning(customerId, "earn_first_purchase", FIRST_PURCHASE_BONUS, orderRef);
          }

          const eligible = pence / 100;
          const outcome = await clawback(
            repo,
            {
              orderReference: orderRef,
              mode: "refund",
              refundedEligibleAmount: eligible, // full refund
              originalEligibleTotal: eligible,
              sourceEventId: "wh-full-refund",
            },
            db,
          );

          expect(outcome.status).toBe("clawed_back");
          if (outcome.status !== "clawed_back") return;

          // Claws back EXACTLY what the order earned.
          expect(outcome.clawbackPoints).toBe(totalEarned);
          expect(outcome.cumulativeClawback).toBe(totalEarned);
          expect(outcome.totalEarned).toBe(totalEarned);

          // Net order-attributable balance is 0 (Req 4.4), spendable exhausted.
          expect(db.orderBalance(customerId, orderRef)).toBe(0);
          expect(db.spendableOf(customerId)).toBe(0);
          expect(db.cumulativeClawback(customerId, orderRef)).toBe(totalEarned);
        },
      ),
    );
  });
});
