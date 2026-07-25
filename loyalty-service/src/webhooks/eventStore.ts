/**
 * Webhook event store (task 3.2): the durable dedupe anchor for inbound
 * Shopify webhooks.
 *
 * Every verified webhook's `X-Shopify-Webhook-Id` is persisted to
 * `webhook_events` BEFORE the event is handed off to the Loyalty Engine
 * (Requirement 12.1). The `shopify_webhook_id UNIQUE` constraint from the
 * ledger-core migration is the race arbiter: a repeated OR concurrent duplicate
 * loses the insert atomically and is treated as a 200 no-op that changes no
 * balance (Requirements 12.2, 12.4; design "Duplicate-event protection";
 * Property 6).
 *
 * DB access is abstracted behind {@link Queryable} (satisfied by a `pg` Pool or
 * PoolClient) exactly as the ledger repository does, so the dedupe logic is
 * testable without a live Postgres. An in-memory implementation is provided for
 * tests and as the default in `buildApp`.
 *
 * SAFETY: defining this module touches no live system. The Pg-backed store
 * issues SQL only when a caller passes a real Pool/PoolClient at runtime.
 */
import type { QueryResult, QueryResultRow } from "pg";

/**
 * How long a recorded webhook id must be retained (Requirement 12.1: at least
 * 30 days). A scheduled cleanup job may prune rows OLDER than this window; rows
 * within the window are always retained so replays inside Shopify's retry
 * horizon are still deduplicated.
 */
export const WEBHOOK_EVENT_RETENTION_DAYS = 30;

/**
 * The minimal database surface the store needs. A `pg` Pool and PoolClient both
 * satisfy this, letting a record participate in a caller's transaction.
 */
export interface Queryable {
  query<R extends QueryResultRow = QueryResultRow>(
    queryText: string,
    values?: unknown[],
  ): Promise<QueryResult<R>>;
}

/** The identifying facts persisted for every inbound webhook. */
export interface WebhookEventRecord {
  /** X-Shopify-Webhook-Id — the idempotency anchor (unique). */
  shopifyWebhookId: string;
  /** X-Shopify-Topic, e.g. "orders/paid". */
  topic: string;
  /** A hash of the raw body, retained for audit (not the raw PII payload). */
  payloadHash: string;
}

/**
 * Durable dedupe store contract.
 *
 * `recordIfNew` is the single atomic gate: it returns `true` only for the
 * caller that first records a given id, and `false` for every repeated or
 * concurrent duplicate. Callers hand off to the engine iff it returns `true`.
 */
export interface WebhookEventStore {
  /**
   * Atomically record the webhook id if it has not been seen.
   * @returns `true` when this call is the first to record the id (proceed to
   *          hand off); `false` when the id was already recorded (no-op).
   */
  recordIfNew(record: WebhookEventRecord): Promise<boolean>;
}

const INSERT_SQL = `
  INSERT INTO webhook_events (shopify_webhook_id, topic, payload_hash)
  VALUES ($1, $2, $3)
  ON CONFLICT (shopify_webhook_id) DO NOTHING
  RETURNING id
`;

const DELETE_OLDER_THAN_SQL = `
  DELETE FROM webhook_events
  WHERE received_at < $1
`;

/**
 * Postgres-backed dedupe store.
 *
 * Uses a single `INSERT ... ON CONFLICT (shopify_webhook_id) DO NOTHING`
 * statement so the UNIQUE constraint decides the winner in one atomic round
 * trip — no read-then-write race. When two verified copies of the same webhook
 * arrive concurrently, exactly one INSERT returns a row (that caller hands off);
 * the other conflicts, returns no row, and is a no-op (Requirements 12.2, 12.4).
 */
export class PgWebhookEventStore implements WebhookEventStore {
  constructor(private readonly db: Queryable) {}

  async recordIfNew(record: WebhookEventRecord): Promise<boolean> {
    const result = await this.db.query(INSERT_SQL, [
      record.shopifyWebhookId,
      record.topic,
      record.payloadHash,
    ]);
    // rowCount === 1 → we inserted (won the race). rowCount === 0 → duplicate.
    return (result.rowCount ?? 0) > 0;
  }

  /**
   * Cleanup helper for the retention policy (Requirement 12.1). Deletes rows
   * received before `olderThan`; callers pass a cutoff no more recent than
   * `WEBHOOK_EVENT_RETENTION_DAYS` ago so at least 30 days are always retained.
   * Intended to be wired to the daily scheduler; not invoked at import/startup.
   */
  async deleteReceivedBefore(olderThan: Date): Promise<number> {
    const result = await this.db.query(DELETE_OLDER_THAN_SQL, [olderThan.toISOString()]);
    return result.rowCount ?? 0;
  }
}

/**
 * Computes the retention cutoff: the timestamp before which recorded webhook
 * ids may be pruned while still retaining at least 30 days (Requirement 12.1).
 */
export function retentionCutoff(asOf: Date = new Date()): Date {
  return new Date(asOf.getTime() - WEBHOOK_EVENT_RETENTION_DAYS * 24 * 60 * 60 * 1000);
}

/**
 * In-memory dedupe store — the default when no Pg store is injected and the
 * store used by tests so they run without a live Postgres.
 *
 * Node's single-threaded event loop makes the check-and-add below atomic with
 * respect to other JS turns, which is exactly the concurrency semantics of the
 * Pg `ON CONFLICT` gate: interleaved `recordIfNew` calls for the same id yield
 * `true` exactly once (Requirements 12.2, 12.4; Property 6).
 */
export class InMemoryWebhookEventStore implements WebhookEventStore {
  private readonly seen = new Set<string>();

  async recordIfNew(record: WebhookEventRecord): Promise<boolean> {
    if (this.seen.has(record.shopifyWebhookId)) {
      return false;
    }
    this.seen.add(record.shopifyWebhookId);
    return true;
  }

  /** Test/introspection helper: has this id been recorded? */
  has(shopifyWebhookId: string): boolean {
    return this.seen.has(shopifyWebhookId);
  }

  /** Test/introspection helper: number of distinct ids recorded. */
  get size(): number {
    return this.seen.size;
  }
}
