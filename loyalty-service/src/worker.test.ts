/**
 * Unit tests for the webhook-processing dispatch + the metafield-cache
 * enqueue-on-balance-change glue (final wiring wave).
 *
 * No live/production infrastructure is touched. A tiny in-memory fake
 * {@link Queryable}/{@link Transactor} drives the signup earning handler to its
 * `earned` / `already_earned` outcomes (reusing the same statement-routing
 * approach as `earning/signup.test.ts`), and a recording enqueuer captures the
 * metafield-cache jobs {@link dispatchWebhookJob} schedules.
 *
 * What is verified:
 *   - a BALANCE-AFFECTING outcome (a fresh signup earning) enqueues exactly one
 *     metafield-cache refresh for the affected LOCAL customer id (Req 13.1);
 *   - a replayed / duplicate signup (`already_earned`) changes no balance and
 *     enqueues NOTHING (so the cache is never needlessly rewritten);
 *   - when NO enqueuer is wired (Admin token absent), dispatch still processes
 *     the event and simply performs no enqueue (fail-safe boot);
 *   - a topic the engine does not act on is a safe no-op: no ledger change and
 *     no enqueue.
 */
import { describe, expect, it } from "vitest";
import type { QueryResult, QueryResultRow } from "pg";
import { LedgerRepository, type Queryable } from "./ledger/repository.js";
import type { WebhookJob } from "./webhooks/enqueue.js";
import { CUSTOMERS_CREATE_TOPIC } from "./earning/signup.js";
import type {
  MetafieldCacheEnqueuer,
  MetafieldCacheJob,
} from "./shopify/metafieldCache.js";
import { dispatchWebhookJob, type Transactor } from "./worker.js";

/** Records every metafield-cache refresh dispatch asks to enqueue. */
class RecordingEnqueuer implements MetafieldCacheEnqueuer {
  readonly jobs: MetafieldCacheJob[] = [];
  async enqueueMetafieldCache(job: MetafieldCacheJob): Promise<void> {
    this.jobs.push({ ...job });
  }
}

/**
 * In-memory Postgres understanding exactly the three statements the signup flow
 * issues — the customer upsert, the `earn_signup` idempotency guard, and the
 * ledger append — so the dispatch outcome (earned vs already_earned) is
 * realistic without any live database.
 */
class FakeDb implements Queryable, Transactor {
  readonly customersByShopifyId = new Map<number, string>();
  readonly ledger: Array<{ customer_id: string; entry_type: string; points: number }> = [];
  /** Point_Lots backing each credit (Property 17). */
  readonly lots: Array<{ customer_id: string; ledger_entry_id: string; points: number }> = [];
  private seq = 0;

  async query<R extends QueryResultRow = QueryResultRow>(
    queryText: string,
    values: unknown[] = [],
  ): Promise<QueryResult<R>> {
    if (queryText.includes("INSERT INTO customers")) {
      const shopifyId = values[0] as number;
      let id = this.customersByShopifyId.get(shopifyId);
      if (!id) {
        id = this.nextId("cust");
        this.customersByShopifyId.set(shopifyId, id);
      }
      return this.result<R>([{ id } as unknown as R]);
    }
    if (queryText.includes("FROM ledger_entries") && queryText.includes("earn_signup")) {
      const customerId = values[0] as string;
      const exists = this.ledger.some(
        (row) => row.customer_id === customerId && row.entry_type === "earn_signup",
      );
      return this.result<R>(exists ? [{ "?column?": 1 } as unknown as R] : []);
    }
    if (queryText.includes("INSERT INTO ledger_entries")) {
      const [customerId, entryType, points] = values;
      this.ledger.push({
        customer_id: customerId as string,
        entry_type: entryType as string,
        points: points as number,
      });
      const returned = {
        id: this.nextId("ledg"),
        customer_id: customerId as string,
        entry_type: entryType as string,
        points: String(points), // pg returns BIGINT as string
        reason: values[3] as string,
        order_reference: null,
        point_lot_id: null,
        redemption_id: null,
        source_event_id: (values[7] as string | null) ?? null,
        created_at: new Date("2025-01-01T00:00:00.000Z"),
      };
      return this.result<R>([returned as unknown as R]);
    }
    if (queryText.includes("INSERT INTO point_lots")) {
      const [customer_id, ledger_entry_id, points] = values as [string, string, number];
      this.lots.push({ customer_id, ledger_entry_id, points });
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
}

function signupJob(overrides: Partial<WebhookJob> = {}): WebhookJob {
  return {
    webhookId: "wh-1",
    topic: CUSTOMERS_CREATE_TOPIC,
    shopDomain: "myathoorlondon.myshopify.com",
    payload: { id: 1001, email: "new@example.com" },
    ...overrides,
  };
}

describe("dispatchWebhookJob: enqueues a metafield-cache refresh on a balance change (Req 13.1)", () => {
  it("enqueues exactly one refresh for the affected customer on a fresh signup earning", async () => {
    const db = new FakeDb();
    const repo = new LedgerRepository(db);
    const enqueuer = new RecordingEnqueuer();

    await dispatchWebhookJob(signupJob(), { repo, transactor: db, metafieldEnqueuer: enqueuer });

    // The signup earned +50, so the customer's display cache must be refreshed.
    expect(db.ledger).toHaveLength(1);
    expect(enqueuer.jobs).toHaveLength(1);
    // The enqueue targets the resolved LOCAL customer id (customers.id).
    const enrolledId = db.customersByShopifyId.get(1001);
    expect(enqueuer.jobs[0]!.customerId).toBe(enrolledId);
  });

  it("does NOT enqueue on a replayed signup (already_earned — no balance change)", async () => {
    const db = new FakeDb();
    const repo = new LedgerRepository(db);
    const enqueuer = new RecordingEnqueuer();

    await dispatchWebhookJob(signupJob(), { repo, transactor: db, metafieldEnqueuer: enqueuer });
    // Reprocess the same webhook: the idempotency guard yields already_earned.
    await dispatchWebhookJob(signupJob(), { repo, transactor: db, metafieldEnqueuer: enqueuer });

    // Still exactly one earning and exactly one enqueue (the first, earned run).
    expect(db.ledger).toHaveLength(1);
    expect(enqueuer.jobs).toHaveLength(1);
  });
});

describe("dispatchWebhookJob: fail-safe when no enqueuer is wired", () => {
  it("processes the earning and performs no enqueue when metafieldEnqueuer is absent", async () => {
    const db = new FakeDb();
    const repo = new LedgerRepository(db);

    // No metafieldEnqueuer (models the Admin-token-absent boot).
    await expect(
      dispatchWebhookJob(signupJob(), { repo, transactor: db }),
    ).resolves.toBeUndefined();

    // The ledger append still happened; there is simply no cache refresh.
    expect(db.ledger).toHaveLength(1);
  });
});

describe("dispatchWebhookJob: a topic the engine does not act on is a safe no-op", () => {
  it("neither writes the ledger nor enqueues a refresh for an unknown topic", async () => {
    const db = new FakeDb();
    const repo = new LedgerRepository(db);
    const enqueuer = new RecordingEnqueuer();

    await dispatchWebhookJob(
      signupJob({ topic: "fulfillments/create", payload: { id: 9 } }),
      { repo, transactor: db, metafieldEnqueuer: enqueuer },
    );

    expect(db.ledger).toHaveLength(0);
    expect(enqueuer.jobs).toHaveLength(0);
  });
});
