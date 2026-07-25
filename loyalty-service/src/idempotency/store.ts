/**
 * Idempotency store (task 6.1): the dedupe anchor for state-changing `/v1`
 * requests.
 *
 * Requirement 9.6 requires that a state-changing endpoint accept an idempotency
 * key of 1–128 characters and, within a **24-hour deduplication window**,
 * return the *stored result* for a repeated key without performing any
 * additional state change. Requirement 9.7 requires a missing or invalid key on
 * a state-changing request be rejected. This module owns:
 *
 *   1. Key validation (1–128 chars) — {@link isValidIdempotencyKey}.
 *   2. A small store that remembers the first response for a key and returns it
 *      for repeats inside the 24h window — {@link IdempotencyStore}.
 *
 * DB access is abstracted behind {@link Queryable} (satisfied by a `pg` Pool or
 * PoolClient) exactly as the ledger repository and the webhook event store do,
 * so the dedupe logic is testable without a live Postgres. An in-memory
 * implementation is the default used by `buildApp` and by tests, so the whole
 * `/v1` gateway runs with no live infrastructure.
 *
 * SCOPE: this is the *gateway-level* idempotency cache — it makes a sequential
 * client retry return the identical stored response. Money-movement endpoints
 * additionally enforce exactly-once semantics at the engine via a DB-level
 * `redemptions (customer_id, idempotency_key)` UNIQUE constraint (see
 * `redemption/redeem.ts`), which protects against *concurrent* duplicates.
 *
 * SAFETY: defining this module touches no live system. The Pg-backed store
 * issues SQL only when a caller passes a real Pool/PoolClient at runtime.
 */
import type { QueryResult, QueryResultRow } from "pg";

/** Minimum accepted idempotency-key length (Requirement 9.6). */
export const IDEMPOTENCY_KEY_MIN_LENGTH = 1 as const;

/** Maximum accepted idempotency-key length (Requirement 9.6). */
export const IDEMPOTENCY_KEY_MAX_LENGTH = 128 as const;

/** The deduplication window: a repeated key inside 24h returns the stored result (Requirement 9.6). */
export const IDEMPOTENCY_WINDOW_HOURS = 24 as const;

/** The window expressed in milliseconds, for expiry arithmetic. */
export const IDEMPOTENCY_WINDOW_MS = IDEMPOTENCY_WINDOW_HOURS * 60 * 60 * 1000;

/**
 * True iff `key` is a valid idempotency key: a non-blank string of 1–128
 * characters (Requirement 9.6). A missing, non-string, empty, whitespace-only,
 * or over-length value is invalid and must be rejected (Requirement 9.7).
 */
export function isValidIdempotencyKey(key: unknown): key is string {
  return (
    typeof key === "string" &&
    key.trim().length >= IDEMPOTENCY_KEY_MIN_LENGTH &&
    key.length <= IDEMPOTENCY_KEY_MAX_LENGTH
  );
}

/**
 * A stored response: exactly the bytes (and status/content-type) sent for the
 * first request under a given key, replayed verbatim for repeats. Storing the
 * already-serialized payload guarantees a repeat returns an identical result,
 * including the version identifier already embedded by the versioning plugin.
 */
export interface StoredResponse {
  statusCode: number;
  /** The serialized response body as sent to the client. */
  payload: string;
  /** The content-type to replay so the repeat is byte-for-byte identical. */
  contentType: string;
}

/**
 * The minimal database surface the Pg-backed store needs. A `pg` Pool and
 * PoolClient both satisfy this.
 */
export interface Queryable {
  query<R extends QueryResultRow = QueryResultRow>(
    queryText: string,
    values?: unknown[],
  ): Promise<QueryResult<R>>;
}

/**
 * Idempotency store contract.
 *
 * `get` returns the stored response for a key iff one was recorded within the
 * last {@link IDEMPOTENCY_WINDOW_HOURS} hours; entries older than the window are
 * treated as absent so a request after the window is processed fresh. `put`
 * records the first response for a key; a repeated `put` for a key that already
 * has a live entry MUST NOT overwrite it (first response wins), so the stored
 * result is stable across the window.
 */
export interface IdempotencyStore {
  get(key: string, now?: Date): Promise<StoredResponse | null>;
  put(key: string, response: StoredResponse, now?: Date): Promise<void>;
}

/**
 * In-memory idempotency store — the default when no Pg store is injected and
 * the store used by tests so they run without a live Postgres.
 *
 * Node's single-threaded event loop makes each get/put atomic with respect to
 * other JS turns. First-write-wins is enforced explicitly so a stored result is
 * stable for the whole window.
 */
export class InMemoryIdempotencyStore implements IdempotencyStore {
  private readonly entries = new Map<string, { response: StoredResponse; storedAtMs: number }>();

  async get(key: string, now: Date = new Date()): Promise<StoredResponse | null> {
    const entry = this.entries.get(key);
    if (!entry) {
      return null;
    }
    if (now.getTime() - entry.storedAtMs > IDEMPOTENCY_WINDOW_MS) {
      // Outside the 24h window: treat as absent and evict lazily.
      this.entries.delete(key);
      return null;
    }
    return entry.response;
  }

  async put(key: string, response: StoredResponse, now: Date = new Date()): Promise<void> {
    const existing = this.entries.get(key);
    if (existing && now.getTime() - existing.storedAtMs <= IDEMPOTENCY_WINDOW_MS) {
      // A live entry already exists: first response wins (Requirement 9.6 —
      // "return the stored result"), so do not overwrite it.
      return;
    }
    this.entries.set(key, { response, storedAtMs: now.getTime() });
  }

  /** Test/introspection helper: number of distinct live+stale keys held. */
  get size(): number {
    return this.entries.size;
  }
}

/**
 * SQL for the Pg-backed store. Expects an `idempotency_keys` table:
 *
 *   CREATE TABLE idempotency_keys (
 *     key          TEXT PRIMARY KEY,
 *     status_code  INT  NOT NULL,
 *     payload      TEXT NOT NULL,
 *     content_type TEXT NOT NULL,
 *     created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
 *   );
 *
 * created at deploy time via a migration. `ON CONFLICT (key) DO NOTHING` makes
 * the first write win; the windowed SELECT enforces the 24h horizon in SQL.
 */
const INSERT_SQL = `
  INSERT INTO idempotency_keys (key, status_code, payload, content_type)
  VALUES ($1, $2, $3, $4)
  ON CONFLICT (key) DO NOTHING
`;

const SELECT_WITHIN_WINDOW_SQL = `
  SELECT status_code, payload, content_type
  FROM idempotency_keys
  WHERE key = $1 AND created_at > $2
  LIMIT 1
`;

interface IdempotencyRow {
  status_code: number;
  payload: string;
  content_type: string;
}

/**
 * Postgres-backed idempotency store.
 *
 * SAFETY: issues SQL only when a caller passes a real Pool/PoolClient at
 * runtime; construction alone touches nothing. Not used by tests or local runs
 * — the in-memory store is the default so no live Postgres is required.
 */
export class PgIdempotencyStore implements IdempotencyStore {
  constructor(private readonly db: Queryable) {}

  async get(key: string, now: Date = new Date()): Promise<StoredResponse | null> {
    const cutoff = new Date(now.getTime() - IDEMPOTENCY_WINDOW_MS).toISOString();
    const result = await this.db.query<IdempotencyRow>(SELECT_WITHIN_WINDOW_SQL, [key, cutoff]);
    const row = result.rows[0];
    if (!row) {
      return null;
    }
    return {
      statusCode: row.status_code,
      payload: row.payload,
      contentType: row.content_type,
    };
  }

  async put(key: string, response: StoredResponse): Promise<void> {
    await this.db.query(INSERT_SQL, [
      key,
      response.statusCode,
      response.payload,
      response.contentType,
    ]);
  }
}
