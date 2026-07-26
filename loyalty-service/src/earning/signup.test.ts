/**
 * Unit tests for signup earning (task 4.1).
 *
 * No live/production database is touched. A fake {@link Queryable} backed by a
 * tiny in-memory store routes the three statements the flow issues — the
 * customer upsert, the `earn_signup` idempotency guard, and the ledger append
 * (via {@link LedgerRepository}) — so the signup contract is verified without
 * any Postgres or Shopify Admin API:
 *
 *   - awards exactly one +50 `earn_signup` on a verified new signup (Req 2.1);
 *   - a replayed / duplicate already-earned signup creates nothing (Req 2.8);
 *   - only the target customer's balance is affected (Req 2.11);
 *   - the earning runs only from the verified/deduped job path, and never for a
 *     non-`customers/create` topic (Req 2.7 surface).
 */
import { describe, expect, it } from "vitest";
import type { QueryResult, QueryResultRow } from "pg";
import { LedgerRepository, type Queryable } from "../ledger/repository.js";
import type { WebhookJob } from "../webhooks/enqueue.js";
import {
  CUSTOMERS_CREATE_TOPIC,
  handleCustomersCreateJob,
  InvalidCustomersCreatePayloadError,
  SIGNUP_POINTS,
  SIGNUP_REASON,
  earnSignup,
  type Transactor,
} from "./signup.js";

interface LedgerRowStore {
  id: string;
  customer_id: string;
  entry_type: string;
  points: number;
  reason: string;
  source_event_id: string | null;
}

/**
 * An in-memory fake Postgres that understands exactly the three statements the
 * signup flow issues. It keeps a customers map (shopify id → uuid) and a ledger
 * array so idempotency and per-customer isolation behave realistically.
 */
class FakeDb implements Queryable, Transactor {
  readonly customersByShopifyId = new Map<number, string>();
  readonly ledger: LedgerRowStore[] = [];
  /** Point_Lots backing each credit (Property 17). */
  readonly lots: Array<{
    customer_id: string;
    ledger_entry_id: string;
    points: number;
    earned_at: Date;
    expires_at: Date | null;
  }> = [];
  private seq = 0;

  async query<R extends QueryResultRow = QueryResultRow>(
    queryText: string,
    values: unknown[] = [],
  ): Promise<QueryResult<R>> {
    if (queryText.includes("INSERT INTO customers")) {
      return this.upsertCustomer<R>(values);
    }
    if (queryText.includes("FROM ledger_entries") && queryText.includes("earn_signup")) {
      return this.guardSignup<R>(values);
    }
    if (queryText.includes("INSERT INTO ledger_entries")) {
      return this.appendLedger<R>(values);
    }
    if (queryText.includes("INSERT INTO point_lots")) {
      const [customer_id, ledger_entry_id, points, earned_at, expires_at] = values as [
        string,
        string,
        number,
        Date,
        Date | null,
      ];
      this.lots.push({ customer_id, ledger_entry_id, points, earned_at, expires_at });
      return { rows: [], rowCount: 0, command: "INSERT", oid: 0, fields: [] } as QueryResult<R>;
    }
    throw new Error(`Unexpected query in FakeDb: ${queryText}`);
  }

  // Transactor: run the unit of work directly on this fake (no real BEGIN).
  async transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
    return fn(this);
  }

  private nextId(prefix: string): string {
    this.seq += 1;
    return `${prefix}-${String(this.seq).padStart(12, "0")}`;
  }

  private upsertCustomer<R extends QueryResultRow>(values: unknown[]): QueryResult<R> {
    const shopifyId = values[0] as number;
    let id = this.customersByShopifyId.get(shopifyId);
    if (!id) {
      id = this.nextId("cust");
      this.customersByShopifyId.set(shopifyId, id);
    }
    return this.result<R>([{ id } as unknown as R]);
  }

  private guardSignup<R extends QueryResultRow>(values: unknown[]): QueryResult<R> {
    const customerId = values[0] as string;
    const exists = this.ledger.some(
      (row) => row.customer_id === customerId && row.entry_type === "earn_signup",
    );
    return this.result<R>(exists ? ([{ "?column?": 1 } as unknown as R]) : []);
  }

  private appendLedger<R extends QueryResultRow>(values: unknown[]): QueryResult<R> {
    const [customerId, entryType, points, reason, , , , sourceEventId] = values;
    const row: LedgerRowStore = {
      id: this.nextId("ledg"),
      customer_id: customerId as string,
      entry_type: entryType as string,
      points: points as number,
      reason: reason as string,
      source_event_id: (sourceEventId as string | null) ?? null,
    };
    this.ledger.push(row);
    const returned = {
      id: row.id,
      customer_id: row.customer_id,
      entry_type: row.entry_type,
      points: String(row.points), // pg returns BIGINT as string
      reason: row.reason,
      order_reference: null,
      point_lot_id: null,
      redemption_id: null,
      source_event_id: row.source_event_id,
      created_at: new Date("2025-01-01T00:00:00.000Z"),
    };
    return this.result<R>([returned as unknown as R]);
  }

  private result<R extends QueryResultRow>(rows: R[]): QueryResult<R> {
    return { rows, rowCount: rows.length, command: "SELECT", oid: 0, fields: [] };
  }

  signupEntriesFor(customerId: string): LedgerRowStore[] {
    return this.ledger.filter(
      (row) => row.customer_id === customerId && row.entry_type === "earn_signup",
    );
  }
}

function makeJob(overrides: Partial<WebhookJob> = {}): WebhookJob {
  return {
    webhookId: "wh-1",
    topic: CUSTOMERS_CREATE_TOPIC,
    shopDomain: "myathoorlondon.myshopify.com",
    payload: { id: 1001, email: "new@example.com" },
    ...overrides,
  };
}

describe("earnSignup: awards exactly one +50 signup earning (Req 2.1)", () => {
  it("appends a single earn_signup of exactly 50 points for the new customer", async () => {
    const db = new FakeDb();
    const repo = new LedgerRepository(db);

    const outcome = await earnSignup(
      repo,
      { shopifyCustomerId: 1001, email: "new@example.com", sourceEventId: "wh-1" },
      db,
    );

    expect(outcome.status).toBe("earned");
    if (outcome.status !== "earned") return;
    expect(outcome.entry.entryType).toBe("earn_signup");
    expect(outcome.entry.points).toBe(SIGNUP_POINTS);
    expect(outcome.entry.points).toBe(50);
    expect(outcome.entry.reason).toBe(SIGNUP_REASON);
    expect(outcome.entry.sourceEventId).toBe("wh-1");

    expect(db.signupEntriesFor(outcome.customerId)).toHaveLength(1);
    expect(db.ledger).toHaveLength(1);
  });

  it("enrols the customer (upserts a customers row) keyed by shopify id", async () => {
    const db = new FakeDb();
    const repo = new LedgerRepository(db);

    await earnSignup(repo, { shopifyCustomerId: 2002 }, db);

    expect(db.customersByShopifyId.has(2002)).toBe(true);
  });
});

describe("earnSignup: duplicate/replayed signup creates nothing (Req 2.8)", () => {
  it("does not append a second earn_signup for an already-earned customer", async () => {
    const db = new FakeDb();
    const repo = new LedgerRepository(db);

    const first = await earnSignup(repo, { shopifyCustomerId: 1001 }, db);
    expect(first.status).toBe("earned");

    const second = await earnSignup(repo, { shopifyCustomerId: 1001 }, db);
    expect(second.status).toBe("already_earned");

    // Exactly one signup entry survives; balance unchanged (Req 2.8).
    if (first.status === "earned") {
      expect(db.signupEntriesFor(first.customerId)).toHaveLength(1);
    }
    expect(db.ledger).toHaveLength(1);
  });

  it("is idempotent across a replay under a different webhook id", async () => {
    const db = new FakeDb();
    const repo = new LedgerRepository(db);

    await earnSignup(repo, { shopifyCustomerId: 1001, sourceEventId: "wh-1" }, db);
    const replay = await earnSignup(repo, { shopifyCustomerId: 1001, sourceEventId: "wh-2" }, db);

    expect(replay.status).toBe("already_earned");
    expect(db.ledger).toHaveLength(1);
  });
});

describe("earnSignup: affects only the target customer (Req 2.11)", () => {
  it("credits only the signing-up customer, leaving others untouched", async () => {
    const db = new FakeDb();
    const repo = new LedgerRepository(db);

    const a = await earnSignup(repo, { shopifyCustomerId: 1001 }, db);
    const b = await earnSignup(repo, { shopifyCustomerId: 2002 }, db);

    expect(a.status).toBe("earned");
    expect(b.status).toBe("earned");
    if (a.status !== "earned" || b.status !== "earned") return;

    expect(a.customerId).not.toBe(b.customerId);
    expect(db.signupEntriesFor(a.customerId)).toHaveLength(1);
    expect(db.signupEntriesFor(b.customerId)).toHaveLength(1);

    // Each customer has exactly their own +50; no cross-customer effect.
    const total = db.ledger.reduce((sum, row) => sum + row.points, 0);
    expect(total).toBe(100);
  });
});

describe("handleCustomersCreateJob: verified/deduped path only (Req 2.7 surface)", () => {
  it("earns +50 from a customers/create job", async () => {
    const db = new FakeDb();
    const repo = new LedgerRepository(db);

    const outcome = await handleCustomersCreateJob(makeJob(), { repo, transactor: db });

    expect(outcome).not.toBeNull();
    expect(outcome?.status).toBe("earned");
    expect(db.ledger).toHaveLength(1);
    expect(db.ledger[0]!.points).toBe(50);
    // Traceability: the webhook id is recorded on the entry.
    expect(db.ledger[0]!.source_event_id).toBe("wh-1");
  });

  it("ignores jobs for other topics (no earning created)", async () => {
    const db = new FakeDb();
    const repo = new LedgerRepository(db);

    const outcome = await handleCustomersCreateJob(
      makeJob({ topic: "orders/paid", payload: { id: 555 } }),
      { repo, transactor: db },
    );

    expect(outcome).toBeNull();
    expect(db.ledger).toHaveLength(0);
  });

  it("does not double-credit when the same customers/create job is reprocessed", async () => {
    const db = new FakeDb();
    const repo = new LedgerRepository(db);

    await handleCustomersCreateJob(makeJob(), { repo, transactor: db });
    const again = await handleCustomersCreateJob(makeJob(), { repo, transactor: db });

    expect(again?.status).toBe("already_earned");
    expect(db.ledger).toHaveLength(1);
  });

  it("rejects a payload with no usable customer id, creating no earning", async () => {
    const db = new FakeDb();
    const repo = new LedgerRepository(db);

    await expect(
      handleCustomersCreateJob(makeJob({ payload: { email: "x@example.com" } }), {
        repo,
        transactor: db,
      }),
    ).rejects.toBeInstanceOf(InvalidCustomersCreatePayloadError);

    expect(db.ledger).toHaveLength(0);
  });
});
