/**
 * Webhook processing-outcome traceability (task 23, Req 12.1/12.3/13.8).
 *
 * WHAT WAS WRONG: `webhook_events` recorded RECEIPT but never OUTCOME. Every row
 * stayed at `status = 'received'` with a NULL `processed_at` even after the
 * worker had successfully dispatched it — staging showed 8 of 8 rows in that
 * state. The column already permitted `received | processed | failed`, so the
 * state was modelled but never advanced, leaving no way to tell "handled" from
 * "failed" from "still queued" when investigating.
 *
 * These tests pin the transitions and, importantly, the guards: a success is
 * never overwritten, a processed webhook is never downgraded to failed, and a
 * failure to write the status never disturbs the already-committed ledger work
 * or pg-boss's retry behaviour.
 */
import { describe, expect, it } from "vitest";
import type { QueryResult, QueryResultRow } from "pg";
import {
  InMemoryWebhookEventStore,
  PgWebhookEventStore,
  WEBHOOK_STATUS_FAILED,
  WEBHOOK_STATUS_PROCESSED,
  WEBHOOK_STATUS_RECEIVED,
  type Queryable,
  type WebhookEventOutcomeRecorder,
} from "./eventStore.js";
import { dispatchWithOutcome } from "../worker.js";
import { LedgerRepository } from "../ledger/repository.js";
import type { WebhookJob } from "./enqueue.js";

const WEBHOOK_ID = "abc-123";

/** Models `webhook_events` rows and the guarded UPDATEs the store issues. */
class FakeDb implements Queryable {
  status = WEBHOOK_STATUS_RECEIVED;
  processedAtWrites = 0;
  readonly statements: string[] = [];

  async query<R extends QueryResultRow = QueryResultRow>(
    text: string,
  ): Promise<QueryResult<R>> {
    this.statements.push(text.trim());
    const ok = (rows: QueryResultRow[]): QueryResult<R> => ({
      rows: rows as R[],
      rowCount: rows.length,
      command: "UPDATE",
      oid: 0,
      fields: [],
    });

    if (text.includes("status = 'processed'")) {
      // WHERE status <> 'processed'
      if (this.status === WEBHOOK_STATUS_PROCESSED) {
        return ok([]);
      }
      this.status = WEBHOOK_STATUS_PROCESSED;
      this.processedAtWrites += 1;
      return ok([{ id: "row-1" }]);
    }
    if (text.includes("status = 'failed'")) {
      // WHERE status = 'received'
      if (this.status !== WEBHOOK_STATUS_RECEIVED) {
        return ok([]);
      }
      this.status = WEBHOOK_STATUS_FAILED;
      return ok([{ id: "row-1" }]);
    }
    throw new Error(`Unexpected query: ${text}`);
  }
}

describe("PgWebhookEventStore outcome transitions (task 23)", () => {
  it("marks a dispatched webhook processed and stamps processed_at", async () => {
    const db = new FakeDb();
    await new PgWebhookEventStore(db).markProcessed(WEBHOOK_ID);

    expect(db.status).toBe(WEBHOOK_STATUS_PROCESSED);
    expect(db.processedAtWrites).toBe(1);
    expect(db.statements.some((s) => s.includes("processed_at = now()"))).toBe(true);
  });

  it("is idempotent: re-marking processed does not re-stamp processed_at", async () => {
    const db = new FakeDb();
    const store = new PgWebhookEventStore(db);

    await store.markProcessed(WEBHOOK_ID);
    await store.markProcessed(WEBHOOK_ID);

    expect(db.processedAtWrites).toBe(1);
  });

  it("marks a failed dispatch failed", async () => {
    const db = new FakeDb();
    await new PgWebhookEventStore(db).markFailed(WEBHOOK_ID);
    expect(db.status).toBe(WEBHOOK_STATUS_FAILED);
  });

  it("never downgrades an already-processed webhook to failed", async () => {
    const db = new FakeDb();
    const store = new PgWebhookEventStore(db);

    await store.markProcessed(WEBHOOK_ID);
    await store.markFailed(WEBHOOK_ID);

    expect(db.status).toBe(WEBHOOK_STATUS_PROCESSED);
  });

  it("allows failed → processed when a queue retry finally succeeds", async () => {
    const db = new FakeDb();
    const store = new PgWebhookEventStore(db);

    await store.markFailed(WEBHOOK_ID);
    expect(db.status).toBe(WEBHOOK_STATUS_FAILED);

    await store.markProcessed(WEBHOOK_ID);
    expect(db.status).toBe(WEBHOOK_STATUS_PROCESSED);
  });
});

describe("InMemoryWebhookEventStore mirrors the Pg guards (task 23)", () => {
  it("tracks received → processed", async () => {
    const store = new InMemoryWebhookEventStore();
    await store.recordIfNew({ shopifyWebhookId: WEBHOOK_ID, topic: "orders/paid", payloadHash: "h" });
    expect(store.statusOf(WEBHOOK_ID)).toBe(WEBHOOK_STATUS_RECEIVED);

    await store.markProcessed(WEBHOOK_ID);
    expect(store.statusOf(WEBHOOK_ID)).toBe(WEBHOOK_STATUS_PROCESSED);
  });

  it("never downgrades processed to failed", async () => {
    const store = new InMemoryWebhookEventStore();
    await store.recordIfNew({ shopifyWebhookId: WEBHOOK_ID, topic: "orders/paid", payloadHash: "h" });
    await store.markProcessed(WEBHOOK_ID);
    await store.markFailed(WEBHOOK_ID);

    expect(store.statusOf(WEBHOOK_ID)).toBe(WEBHOOK_STATUS_PROCESSED);
  });
});

/* ------------------------- worker integration ------------------------------ */

/** Minimal ledger fake: the dispatch path only needs the signup flow to run. */
class LedgerFakeDb {
  async query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values: unknown[] = [],
  ): Promise<QueryResult<R>> {
    const ok = (rows: QueryResultRow[]): QueryResult<R> => ({
      rows: rows as R[],
      rowCount: rows.length,
      command: "SELECT",
      oid: 0,
      fields: [],
    });
    if (text.includes("INSERT INTO customers")) return ok([{ id: "cust-1" }]);
    if (text.includes("FROM ledger_entries")) return ok([]);
    if (text.includes("INSERT INTO ledger_entries")) {
      return ok([
        {
          id: "ledg-1",
          customer_id: values[0] as string,
          entry_type: values[1] as string,
          points: String(values[2]),
          reason: values[3] as string,
          order_reference: null,
          point_lot_id: null,
          redemption_id: null,
          source_event_id: null,
          created_at: new Date("2026-06-01T00:00:00Z"),
        },
      ]);
    }
    if (text.includes("INSERT INTO point_lots")) return ok([]);
    throw new Error(`Unexpected ledger query: ${text}`);
  }
  async transaction<T>(fn: (tx: LedgerFakeDb) => Promise<T>): Promise<T> {
    return fn(this);
  }
}

class RecordingRecorder implements WebhookEventOutcomeRecorder {
  readonly calls: Array<{ id: string; outcome: "processed" | "failed" }> = [];
  constructor(private readonly throwOnWrite = false) {}
  async markProcessed(id: string): Promise<void> {
    if (this.throwOnWrite) throw new Error("status write failed");
    this.calls.push({ id, outcome: "processed" });
  }
  async markFailed(id: string): Promise<void> {
    if (this.throwOnWrite) throw new Error("status write failed");
    this.calls.push({ id, outcome: "failed" });
  }
}

const signupJob = (): WebhookJob =>
  ({
    webhookId: WEBHOOK_ID,
    topic: "customers/create",
    shopDomain: "athoor-loyalty-staging.myshopify.com",
    payload: { id: 9_900_000_000_123 },
  }) as unknown as WebhookJob;

describe("dispatchWithOutcome records the outcome (task 23)", () => {
  it("marks processed after a successful dispatch", async () => {
    const db = new LedgerFakeDb();
    const recorder = new RecordingRecorder();

    await dispatchWithOutcome(signupJob(), {
      repo: new LedgerRepository(db as never),
      transactor: db as never,
      outcomeRecorder: recorder,
    });

    expect(recorder.calls).toEqual([{ id: WEBHOOK_ID, outcome: "processed" }]);
  });

  it("marks failed and RE-THROWS so pg-boss retry behaviour is unchanged", async () => {
    const recorder = new RecordingRecorder();
    const exploding = {
      async query(): Promise<never> {
        throw new Error("database unavailable");
      },
      async transaction<T>(fn: (tx: unknown) => Promise<T>): Promise<T> {
        return fn(exploding);
      },
    };

    await expect(
      dispatchWithOutcome(signupJob(), {
        repo: new LedgerRepository(exploding as never),
        transactor: exploding as never,
        outcomeRecorder: recorder,
      }),
    ).rejects.toThrow(/database unavailable/);

    expect(recorder.calls).toEqual([{ id: WEBHOOK_ID, outcome: "failed" }]);
  });

  it("is non-fatal: a failing status write does not fail the committed work", async () => {
    const db = new LedgerFakeDb();
    // The recorder itself throws — the ledger append has already committed, so
    // this must not surface as a job failure and cause a needless retry.
    const recorder = new RecordingRecorder(true);

    await expect(
      dispatchWithOutcome(signupJob(), {
        repo: new LedgerRepository(db as never),
        transactor: db as never,
        outcomeRecorder: recorder,
      }),
    ).resolves.toBeUndefined();
  });

  it("dispatches normally when no recorder is wired", async () => {
    const db = new LedgerFakeDb();
    await expect(
      dispatchWithOutcome(signupJob(), {
        repo: new LedgerRepository(db as never),
        transactor: db as never,
      }),
    ).resolves.toBeUndefined();
  });
});
