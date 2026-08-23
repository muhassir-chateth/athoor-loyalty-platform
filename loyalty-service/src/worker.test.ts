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
import { MIGRATION_ENTRY_TYPE } from "./migration/m1Backfill.js";
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
      const inserted = id === undefined;
      if (!id) {
        id = this.nextId("cust");
        this.customersByShopifyId.set(shopifyId, id);
      }
      // Only the enrollment upsert asks for the xmax-derived `inserted` flag; the
      // signup module's upsert returns the id alone.
      return this.result<R>([(queryText.includes("xmax") ? { id, inserted } : { id }) as unknown as R]);
    }
    // MUST be matched BEFORE the signup guard below. `customers/create` is now
    // dispatched through the shared enrollment service, which first runs a
    // population-classification read. That query ALSO contains "FROM
    // ledger_entries" and "earn_signup", so without this branch it would fall
    // into the guard branch and receive the guard's row shape — leaving
    // `has_migration_state` and `has_signup_award` undefined, i.e. silently
    // reporting "not migrated, never awarded" for every customer. The tests would
    // still pass, because `earnSignup`'s own guard catches a replay downstream,
    // and the Layer 2 migration veto would be entirely untested. Only the
    // classification query aggregates with bool_or, so that is the discriminator.
    if (queryText.includes("bool_or")) {
      const customerId = values[0] as string;
      const relevant = this.ledger.filter(
        (row) =>
          row.customer_id === customerId &&
          (row.entry_type === MIGRATION_ENTRY_TYPE || row.entry_type === "earn_signup"),
      );
      // bool_or over an empty set yields NULL in Postgres, which the service
      // reads as false — modelled faithfully rather than as `false`.
      const row =
        relevant.length === 0
          ? { has_migration_state: null, has_signup_award: null }
          : {
              has_migration_state: relevant.some((r) => r.entry_type === MIGRATION_ENTRY_TYPE),
              has_signup_award: relevant.some((r) => r.entry_type === "earn_signup"),
            };
      return this.result<R>([row as unknown as R]);
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

describe("dispatchWebhookJob: the migration veto reaches the webhook path", () => {
  /**
   * The reason `customers/create` is dispatched through the shared enrollment
   * service rather than calling the signup earning directly. Before that change
   * the webhook path had no notion of migrated state, so a `customers/create`
   * arriving for a customer whose opening balance came from the M0→M1 migration
   * would have credited a fresh +50 on top of it.
   *
   * This test would pass vacuously if the FakeDb did not model the
   * classification query — see the `bool_or` branch above.
   */
  it("does NOT award a second +50 to a migrated customer, and enqueues nothing", async () => {
    const db = new FakeDb();
    const repo = new LedgerRepository(db);
    const enqueuer = new RecordingEnqueuer();

    // Seed the customer exactly as the M1 backfill leaves them: a local row plus a
    // `migration` ledger entry carrying their imported opening balance.
    const migratedId = "cust-migrated-4995";
    db.customersByShopifyId.set(1001, migratedId);
    db.ledger.push({ customer_id: migratedId, entry_type: MIGRATION_ENTRY_TYPE, points: 84 });

    await dispatchWebhookJob(signupJob(), { repo, transactor: db, metafieldEnqueuer: enqueuer });

    // No signup entry was appended: the ledger still holds only the migration row.
    expect(db.ledger).toHaveLength(1);
    expect(db.ledger[0]!.entry_type).toBe(MIGRATION_ENTRY_TYPE);
    expect(db.ledger.some((r) => r.entry_type === "earn_signup")).toBe(false);
    // Their balance is untouched, so there is nothing to refresh.
    expect(enqueuer.jobs).toHaveLength(0);
  });

  it("still awards a genuinely new customer, so the veto is not over-broad", async () => {
    const db = new FakeDb();
    const repo = new LedgerRepository(db);
    const enqueuer = new RecordingEnqueuer();

    await dispatchWebhookJob(signupJob({ payload: { id: 2002 } }), {
      repo,
      transactor: db,
      metafieldEnqueuer: enqueuer,
    });

    expect(db.ledger).toHaveLength(1);
    expect(db.ledger[0]!.entry_type).toBe("earn_signup");
    expect(db.ledger[0]!.points).toBe(50);
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
