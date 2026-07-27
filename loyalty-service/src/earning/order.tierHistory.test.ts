/**
 * Regression tests for tier-change history on the paid-order path (task 46).
 *
 * The defect these lock down was found by a GENUINE Shopify `orders/paid`
 * delivery (task 45): the order promoted a member Bronze → Gold and
 * `tier_change_history` stayed empty, so the timeline's `tier_change` milestone
 * could never appear for anybody.
 *
 * Covered here:
 *   - a promoting order writes exactly one row, atomically with the tier UPDATE;
 *   - a multi-threshold jump is ONE row, not one per threshold crossed;
 *   - an order that stays inside the tier writes NOTHING;
 *   - a redelivered webhook / replayed order writes no second row;
 *   - a failure after the tier update rolls the history row back with it;
 *   - nothing about the ledger, lots or balances changed (no unrelated drift).
 *
 * Validates: Requirements 17.8, 17.9, 7.2, 7.3, 2.8
 */
import { describe, expect, it } from "vitest";
import type { QueryResult, QueryResultRow } from "pg";
import { LedgerRepository, type Queryable } from "../ledger/repository.js";
import { earnOrder, handleOrdersPaidJob, ORDERS_PAID_TOPIC, type Transactor } from "./order.js";
import type { WebhookJob } from "../webhooks/enqueue.js";

interface CustomerStore {
  id: string;
  shopify_customer_id: number;
  email: string | null;
  tier: string;
  lifetime_spend_gbp: number;
}

interface TierChangeStore {
  customer_id: string;
  from_tier: string;
  to_tier: string;
  reason: string;
}

const FIXED_CREATED_AT = new Date("2026-03-01T09:00:00.000Z");

/**
 * In-memory Postgres covering the order-earning statements, including the
 * task 46 `tier_change_history` INSERT. `failOnTierHistory` lets a test prove
 * the surrounding transaction is what carries the row.
 */
class FakeDb implements Queryable, Transactor {
  readonly customers: CustomerStore[] = [];
  readonly ledger: Array<{
    id: string;
    customer_id: string;
    entry_type: string;
    points: number;
    order_reference: number | null;
  }> = [];
  readonly lots: Array<{ id: string; customer_id: string; original_points: number }> = [];
  readonly tierChanges: TierChangeStore[] = [];
  /** When true the history INSERT throws, modelling a mid-transaction failure. */
  failOnTierHistory = false;
  /** Statements seen, in order, so we can assert the write sequence. */
  readonly statements: string[] = [];
  private seq = 0;
  private committed = true;

  async query<R extends QueryResultRow = QueryResultRow>(
    sql: string,
    values: unknown[] = [],
  ): Promise<QueryResult<R>> {
    this.statements.push(sql.trim().split("\n")[0]!.trim());

    if (sql.includes("INSERT INTO customers")) {
      const shopifyId = values[0] as number;
      let cust = this.customers.find((c) => c.shopify_customer_id === shopifyId);
      if (!cust) {
        cust = {
          id: this.nextId("cust"),
          shopify_customer_id: shopifyId,
          email: (values[1] as string | null) ?? null,
          tier: "bronze",
          lifetime_spend_gbp: 0,
        };
        this.customers.push(cust);
      }
      return this.rows<R>([
        { id: cust.id, tier: cust.tier, lifetime_spend_gbp: String(cust.lifetime_spend_gbp) },
      ]);
    }
    if (sql.includes("FROM ledger_entries") && sql.includes("order_reference")) {
      const [customerId, orderRef] = values as [string, number];
      const exists = this.ledger.some(
        (r) =>
          r.customer_id === customerId &&
          r.entry_type === "earn_order" &&
          r.order_reference === orderRef,
      );
      return this.rows<R>(exists ? [{ "?column?": 1 }] : []);
    }
    if (sql.includes("FROM ledger_entries")) {
      const customerId = values[0] as string;
      const exists = this.ledger.some(
        (r) => r.customer_id === customerId && r.entry_type === "earn_order",
      );
      return this.rows<R>(exists ? [{ "?column?": 1 }] : []);
    }
    if (sql.includes("INSERT INTO ledger_entries")) {
      const [customerId, entryType, points, , orderReference] = values;
      const row = {
        id: this.nextId("ledg"),
        customer_id: customerId as string,
        entry_type: entryType as string,
        points: points as number,
        order_reference: (orderReference as number | null) ?? null,
      };
      this.ledger.push(row);
      return this.rows<R>([
        {
          id: row.id,
          customer_id: row.customer_id,
          entry_type: row.entry_type,
          points: String(row.points),
          reason: "paid_order",
          order_reference: row.order_reference === null ? null : String(row.order_reference),
          point_lot_id: null,
          redemption_id: null,
          source_event_id: null,
          created_at: FIXED_CREATED_AT,
        },
      ]);
    }
    if (sql.includes("INSERT INTO point_lots")) {
      const [customerId, , points] = values as [string, string, number];
      const lot = { id: this.nextId("lot"), customer_id: customerId, original_points: points };
      this.lots.push(lot);
      return this.rows<R>([{ id: lot.id }]);
    }
    if (sql.includes("UPDATE customers")) {
      const [customerId, delta, tier] = values as [string, number, string];
      const cust = this.customers.find((c) => c.id === customerId);
      if (cust) {
        cust.lifetime_spend_gbp = Math.round((cust.lifetime_spend_gbp + delta) * 100) / 100;
        cust.tier = tier;
      }
      return this.rows<R>([]);
    }
    if (sql.includes("INSERT INTO tier_change_history")) {
      if (this.failOnTierHistory) {
        throw new Error("tier history write failed");
      }
      const [customerId, fromTier, toTier, reason] = values as [string, string, string, string];
      this.tierChanges.push({
        customer_id: customerId,
        from_tier: fromTier,
        to_tier: toTier,
        reason,
      });
      return this.rows<R>([]);
    }
    throw new Error(`Unexpected query in FakeDb: ${sql}`);
  }

  /**
   * Models a real transaction: on failure every effect of the unit of work is
   * discarded, which is how we assert the history row is not left behind.
   */
  async transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
    const snapshot = {
      customers: this.customers.map((c) => ({ ...c })),
      ledger: this.ledger.map((r) => ({ ...r })),
      lots: this.lots.map((l) => ({ ...l })),
      tierChanges: this.tierChanges.map((t) => ({ ...t })),
    };
    try {
      const result = await fn(this);
      this.committed = true;
      return result;
    } catch (err) {
      this.customers.length = 0;
      this.customers.push(...snapshot.customers);
      this.ledger.length = 0;
      this.ledger.push(...snapshot.ledger);
      this.lots.length = 0;
      this.lots.push(...snapshot.lots);
      this.tierChanges.length = 0;
      this.tierChanges.push(...snapshot.tierChanges);
      this.committed = false;
      throw err;
    }
  }

  get rolledBack(): boolean {
    return !this.committed;
  }

  seedCustomer(shopifyId: number, tier: string, spend: number): string {
    const cust: CustomerStore = {
      id: this.nextId("cust"),
      shopify_customer_id: shopifyId,
      email: null,
      tier,
      lifetime_spend_gbp: spend,
    };
    this.customers.push(cust);
    return cust.id;
  }

  private nextId(prefix: string): string {
    this.seq += 1;
    return `${prefix}-${String(this.seq).padStart(6, "0")}`;
  }

  private rows<R extends QueryResultRow>(rows: unknown[]): QueryResult<R> {
    return {
      rows: rows as R[],
      rowCount: rows.length,
      command: "SELECT",
      oid: 0,
      fields: [],
    };
  }
}

function makeJob(overrides: Partial<WebhookJob> = {}): WebhookJob {
  return {
    webhookId: "wh-tier-1",
    topic: ORDERS_PAID_TOPIC,
    shopDomain: "athoor-loyalty-staging.myshopify.com",
    payload: {
      id: 7_095_742_234_823,
      customer: { id: 9_038_603_256_007, email: "buyer@example.com" },
      current_subtotal_price: "949.95",
    },
    ...overrides,
  };
}

describe("earnOrder: promotion writes tier history (Req 17.8, task 46)", () => {
  it("writes exactly one row for the Bronze → Gold jump the genuine order made", async () => {
    const db = new FakeDb();
    const repo = new LedgerRepository();
    const customerId = db.seedCustomer(9_038_603_256_007, "bronze", 0);

    const outcome = await earnOrder(
      repo,
      { shopifyCustomerId: 9_038_603_256_007, shopifyOrderId: 7_095_742_234_823, eligibleTotal: 949.95 },
      db,
    );

    expect(outcome.status).toBe("earned");
    if (outcome.status !== "earned") return;
    expect(outcome.tierAtTime).toBe("bronze");
    expect(outcome.tier).toBe("gold");
    expect(outcome.tierChanged).toBe(true);

    // ONE row for a two-threshold jump, not one per threshold.
    expect(db.tierChanges).toEqual([
      { customer_id: customerId, from_tier: "bronze", to_tier: "gold", reason: "paid_order" },
    ]);
  });

  it("writes the history row after the tier UPDATE, inside the same unit of work", async () => {
    const db = new FakeDb();
    db.seedCustomer(500, "bronze", 0);

    await db.transaction((tx) =>
      earnOrder(
        new LedgerRepository(),
        { shopifyCustomerId: 500, shopifyOrderId: 900, eligibleTotal: 400 },
        tx,
      ),
    );

    const updateAt = db.statements.findIndex((s) => s.startsWith("UPDATE customers"));
    const insertAt = db.statements.findIndex((s) => s.includes("INSERT INTO tier_change_history"));
    expect(updateAt).toBeGreaterThanOrEqual(0);
    expect(insertAt).toBeGreaterThan(updateAt);
  });

  it("records each successive promotion as its own row", async () => {
    const db = new FakeDb();
    const repo = new LedgerRepository();
    const customerId = db.seedCustomer(600, "bronze", 0);

    // £400 → silver, then a further £400 (total £800) → gold.
    await earnOrder(repo, { shopifyCustomerId: 600, shopifyOrderId: 1, eligibleTotal: 400 }, db);
    await earnOrder(repo, { shopifyCustomerId: 600, shopifyOrderId: 2, eligibleTotal: 400 }, db);

    expect(db.tierChanges).toEqual([
      { customer_id: customerId, from_tier: "bronze", to_tier: "silver", reason: "paid_order" },
      { customer_id: customerId, from_tier: "silver", to_tier: "gold", reason: "paid_order" },
    ]);
  });
});

describe("earnOrder: no history without a real change (Req 17.9, task 46)", () => {
  it("writes nothing when the order stays inside the same tier", async () => {
    const db = new FakeDb();
    db.seedCustomer(700, "bronze", 0);

    const outcome = await earnOrder(
      new LedgerRepository(),
      { shopifyCustomerId: 700, shopifyOrderId: 10, eligibleTotal: 50 },
      db,
    );

    expect(outcome.status).toBe("earned");
    if (outcome.status !== "earned") return;
    expect(outcome.tier).toBe("bronze");
    expect(outcome.tierChanged).toBe(false);
    expect(db.tierChanges).toEqual([]);
  });

  it("writes nothing for a retained higher tier whose spend maps lower", async () => {
    // A retained Gold member spending £10 keeps Gold (Property 11): no change.
    const db = new FakeDb();
    db.seedCustomer(800, "gold", 800);

    const outcome = await earnOrder(
      new LedgerRepository(),
      { shopifyCustomerId: 800, shopifyOrderId: 11, eligibleTotal: 10 },
      db,
    );

    if (outcome.status !== "earned") throw new Error("expected earned");
    expect(outcome.tier).toBe("gold");
    expect(outcome.tierChanged).toBe(false);
    expect(db.tierChanges).toEqual([]);
  });

  it("writes nothing when the order earns nothing (eligibleTotal <= 0)", async () => {
    const db = new FakeDb();
    db.seedCustomer(900, "bronze", 0);

    const outcome = await earnOrder(
      new LedgerRepository(),
      { shopifyCustomerId: 900, shopifyOrderId: 12, eligibleTotal: 0 },
      db,
    );

    expect(outcome.status).toBe("no_earning");
    expect(db.tierChanges).toEqual([]);
  });

  it("writes nothing for a top-tier member who cannot advance further", async () => {
    const db = new FakeDb();
    db.seedCustomer(950, "royal_vip", 2000);

    const outcome = await earnOrder(
      new LedgerRepository(),
      { shopifyCustomerId: 950, shopifyOrderId: 13, eligibleTotal: 500 },
      db,
    );

    if (outcome.status !== "earned") throw new Error("expected earned");
    expect(outcome.tierChanged).toBe(false);
    expect(db.tierChanges).toEqual([]);
  });
});

describe("tier history under replay (Req 2.8, task 46)", () => {
  it("a replayed order creates no second history row", async () => {
    const db = new FakeDb();
    const repo = new LedgerRepository();
    db.seedCustomer(9_038_603_256_007, "bronze", 0);
    const input = {
      shopifyCustomerId: 9_038_603_256_007,
      shopifyOrderId: 7_095_742_234_823,
      eligibleTotal: 949.95,
    };

    await earnOrder(repo, input, db);
    expect(db.tierChanges).toHaveLength(1);

    const replay = await earnOrder(repo, input, db);

    expect(replay.status).toBe("already_earned");
    expect(db.tierChanges).toHaveLength(1);
  });

  it("a redelivered webhook for the same order creates no second history row", async () => {
    const db = new FakeDb();
    const repo = new LedgerRepository();
    db.seedCustomer(9_038_603_256_007, "bronze", 0);
    const deps = { repo, transactor: db };

    await handleOrdersPaidJob(makeJob(), deps);
    expect(db.tierChanges).toHaveLength(1);

    // Same order, different webhook id — exactly what Shopify does on retry
    // once the receiver's own dedupe window no longer applies.
    await handleOrdersPaidJob(makeJob({ webhookId: "wh-tier-1-retry" }), deps);

    expect(db.tierChanges).toHaveLength(1);
    expect(db.tierChanges[0]).toMatchObject({ from_tier: "bronze", to_tier: "gold" });
  });

  it("a different order for the same customer records only its own change", async () => {
    const db = new FakeDb();
    const repo = new LedgerRepository();
    db.seedCustomer(9_038_603_256_007, "bronze", 0);

    // First order promotes to gold; a second, larger order promotes to royal_vip.
    await handleOrdersPaidJob(makeJob(), { repo, transactor: db });
    await handleOrdersPaidJob(
      makeJob({
        webhookId: "wh-tier-2",
        payload: {
          id: 7_095_742_234_824,
          customer: { id: 9_038_603_256_007 },
          current_subtotal_price: "600.00",
        },
      }),
      { repo, transactor: db },
    );

    expect(db.tierChanges.map((t) => `${t.from_tier}->${t.to_tier}`)).toEqual([
      "bronze->gold",
      "gold->royal_vip",
    ]);
  });
});

describe("tier history atomicity (task 46)", () => {
  it("rolls the history row back with the transaction when the write fails", async () => {
    const db = new FakeDb();
    db.seedCustomer(9_038_603_256_007, "bronze", 0);
    db.failOnTierHistory = true;

    await expect(
      db.transaction((tx) =>
        earnOrder(
          new LedgerRepository(),
          {
            shopifyCustomerId: 9_038_603_256_007,
            shopifyOrderId: 7_095_742_234_823,
            eligibleTotal: 949.95,
          },
          tx,
        ),
      ),
    ).rejects.toThrow("tier history write failed");

    // Nothing survives: no history row, and the earning was rolled back too, so
    // a failed history write can never leave a promotion half-recorded.
    expect(db.rolledBack).toBe(true);
    expect(db.tierChanges).toEqual([]);
    expect(db.ledger).toEqual([]);
    expect(db.lots).toEqual([]);
    expect(db.customers[0]!.tier).toBe("bronze");
    expect(db.customers[0]!.lifetime_spend_gbp).toBe(0);
  });

  it("leaves the ledger, lots and balances exactly as before the change (no drift)", async () => {
    const db = new FakeDb();
    db.seedCustomer(9_038_603_256_007, "bronze", 0);

    const outcome = await earnOrder(
      new LedgerRepository(),
      {
        shopifyCustomerId: 9_038_603_256_007,
        shopifyOrderId: 7_095_742_234_823,
        eligibleTotal: 949.95,
      },
      db,
    );

    if (outcome.status !== "earned") throw new Error("expected earned");
    // The genuine staging figures: 949 order points + 100 first purchase.
    expect(outcome.orderPoints).toBe(949);
    expect(outcome.firstPurchase).toBe(true);
    expect(db.ledger.map((r) => r.points)).toEqual([949, 100]);
    expect(db.lots.map((l) => l.original_points)).toEqual([949, 100]);
  });
});
