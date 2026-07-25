/**
 * Property-based test for Property 7 (Earn correctness) — task 4.4.
 *
 * **Validates: Requirements 2.2**
 *
 * Property 7 (from design.md "Correctness Properties"):
 *   `earned == floor(eligibleTotal(o) × multiplier(tier_at_time))`, plus a
 *   one-time +100 first-purchase bonus if and only if it is the first paid-order
 *   earning.
 *
 * This exercises the APPROVED implementation of {@link earnOrder} (task 4.2)
 * and its tier-multiplier lookup (task 4.3) across many arbitrary eligible
 * totals and tiers, asserting two universal facts:
 *
 *   (7a) Earn amount — the `earn_order` movement equals
 *        `floor(eligibleTotal × multiplier(tier_at_time))`, computed here from
 *        an INDEPENDENT integer (pence · rational-multiplier) oracle so the
 *        assertion does not merely restate the code under test. When the floor
 *        is zero (a sub-point order) no `earn_order` entry is created, because
 *        an earn must be strictly positive (Req 1.4).
 *
 *   (7b) First-purchase bonus — across any sequence of paid orders for one
 *        customer, exactly one +100 `earn_first_purchase` entry exists iff at
 *        least one order produced an `earn_order`, and it is attached to the
 *        first earning order (the first paid-order earning) — never to a later
 *        one, and never more than once.
 *
 * No live/production system is touched: {@link earnOrder} is driven against a
 * tiny in-memory {@link Queryable} fake (the same technique used by the
 * unit tests in `order.test.ts`), so there is no Postgres or Shopify Admin API
 * dependency. This is a verification task — the implementation is not changed.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { QueryResult, QueryResultRow } from "pg";
import { LedgerRepository, type Queryable } from "../ledger/repository.js";
import {
  earnOrder,
  FIRST_PURCHASE_POINTS,
  type Transactor,
} from "./order.js";
import { TIERS, type Tier } from "../tier/tier.js";

// --- In-memory fake Postgres ------------------------------------------------

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

interface CustomerStore {
  id: string;
  shopify_customer_id: number;
  email: string | null;
  tier: string;
  lifetime_spend_gbp: number;
}

const FIXED_CREATED_AT = new Date("2025-01-15T10:00:00.000Z");

/**
 * Understands exactly the statements {@link earnOrder} issues: the customer
 * upsert, the order-replay guard, the first-purchase (any-earn_order) guard,
 * the ledger append, the point-lot insert, and the customer-totals update.
 * Enough state is kept for idempotency, first-purchase detection, and
 * per-customer isolation to behave realistically.
 */
class FakeDb implements Queryable, Transactor {
  readonly customers: CustomerStore[] = [];
  readonly ledger: LedgerRowStore[] = [];
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
      // Return a synthetic lot id; lot contents are validated by unit tests.
      return this.result<R>([{ id: this.nextId("lot") } as unknown as R]);
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

  /**
   * Seed a customer with a chosen tier and spend of 0. Because
   * {@link earnOrder} derives `tier_at_time` via `advanceTier(tier, spend)` and
   * advancement never LOWERS a retained tier, seeding spend 0 with tier `T`
   * yields `tier_at_time === T` for every tier — giving the property direct,
   * deterministic control over the multiplier under test.
   */
  seedCustomer(shopifyId: number, tier: Tier): string {
    const cust: CustomerStore = {
      id: this.nextId("cust"),
      shopify_customer_id: shopifyId,
      email: null,
      tier,
      lifetime_spend_gbp: 0,
    };
    this.customers.push(cust);
    return cust.id;
  }

  entriesOfType(customerId: string, type: string): LedgerRowStore[] {
    return this.ledger.filter((row) => row.customer_id === customerId && row.entry_type === type);
  }
}

// --- Independent earn-amount oracle -----------------------------------------

/**
 * Each tier multiplier expressed as an exact rational `num/den`, so the expected
 * earning can be computed with pure integer arithmetic on pence and be free of
 * binary-float drift — an oracle that does NOT reuse the implementation's own
 * pence maths.
 */
const TIER_MULTIPLIER_RATIONAL: Readonly<Record<Tier, readonly [number, number]>> = {
  bronze: [1, 1],
  silver: [3, 2],
  gold: [2, 1],
  royal_vip: [3, 1],
};

/** floor(eligibleTotal × multiplier(tier)) computed from integer pence. */
function expectedEarn(pence: number, tier: Tier): number {
  const [num, den] = TIER_MULTIPLIER_RATIONAL[tier];
  return Math.floor((pence * num) / (den * 100));
}

/** Arbitrary tier. */
const tierArb: fc.Arbitrary<Tier> = fc.constantFrom(...TIERS);

/**
 * Arbitrary strictly-positive money amount in pence (1p .. £10,000), used both
 * to build the `eligibleTotal` (pence/100) and the integer oracle. Kept as
 * whole pence so it is an exact 2dp money value.
 */
const pencePositiveArb: fc.Arbitrary<number> = fc.integer({ min: 1, max: 1_000_000 });

let orderSeq = 7_000_000;
const nextOrderId = () => (orderSeq += 1);

// --- Property 7a: earn amount = floor(eligibleTotal × multiplier) -----------

describe("Property 7 (Earn correctness) — Requirement 2.2", () => {
  it("earn_order == floor(eligibleTotal × multiplier(tier_at_time)) for any total and tier", async () => {
    await fc.assert(
      fc.asyncProperty(tierArb, pencePositiveArb, async (tier, pence) => {
        const db = new FakeDb();
        const repo = new LedgerRepository(db);
        const shopifyId = 100_000 + Math.floor(Math.random() * 1_000_000);
        const customerId = db.seedCustomer(shopifyId, tier);
        const eligibleTotal = pence / 100;
        const expected = expectedEarn(pence, tier);

        const outcome = await earnOrder(
          repo,
          { shopifyCustomerId: shopifyId, shopifyOrderId: nextOrderId(), eligibleTotal },
          db,
        );

        expect(outcome.status).toBe("earned");
        if (outcome.status !== "earned") return;

        // The multiplier applied is the tier held at processing time.
        expect(outcome.tierAtTime).toBe(tier);
        // The reported and persisted order earning equal the independent oracle.
        expect(outcome.orderPoints).toBe(expected);

        const orderEntries = db.entriesOfType(customerId, "earn_order");
        if (expected >= 1) {
          // A strictly-positive earn creates exactly one earn_order of `expected`.
          expect(orderEntries).toHaveLength(1);
          expect(orderEntries[0]!.points).toBe(expected);
        } else {
          // A sub-point order floors to 0 → no earn_order entry (Req 1.4).
          expect(orderEntries).toHaveLength(0);
        }
      }),
    );
  });

  // --- Property 7b: +100 first-purchase bonus exactly once, iff first earning -

  it("adds exactly one +100 first-purchase bonus iff there is a first paid-order earning", async () => {
    await fc.assert(
      fc.asyncProperty(
        tierArb,
        // A sequence of orders, each a strictly-positive money amount in pence.
        fc.array(pencePositiveArb, { minLength: 1, maxLength: 6 }),
        async (tier, penceList) => {
          const db = new FakeDb();
          const repo = new LedgerRepository(db);
          const shopifyId = 200_000 + Math.floor(Math.random() * 1_000_000);
          const customerId = db.seedCustomer(shopifyId, tier);

          let firstEarningSeen = false;
          let firstPurchaseFlaggedCount = 0;

          for (const pence of penceList) {
            const outcome = await earnOrder(
              repo,
              {
                shopifyCustomerId: shopifyId,
                shopifyOrderId: nextOrderId(),
                eligibleTotal: pence / 100,
              },
              db,
            );
            expect(outcome.status).toBe("earned");
            if (outcome.status !== "earned") return;

            const producedEarning = expectedEarn(pence, tier) >= 1;
            if (outcome.firstPurchase) {
              firstPurchaseFlaggedCount += 1;
              // The bonus is only ever flagged on the FIRST earning order.
              expect(firstEarningSeen).toBe(false);
              expect(producedEarning).toBe(true);
            }
            if (producedEarning) firstEarningSeen = true;
          }

          const bonuses = db.entriesOfType(customerId, "earn_first_purchase");
          const anyEarningOrder = db.entriesOfType(customerId, "earn_order").length > 0;

          // Exactly one +100 bonus iff at least one order earned; else none.
          expect(bonuses).toHaveLength(anyEarningOrder ? 1 : 0);
          expect(firstPurchaseFlaggedCount).toBe(anyEarningOrder ? 1 : 0);
          for (const bonus of bonuses) {
            expect(bonus.points).toBe(FIRST_PURCHASE_POINTS);
            expect(bonus.points).toBe(100);
          }
        },
      ),
    );
  });
});
