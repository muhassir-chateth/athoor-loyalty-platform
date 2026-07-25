/**
 * Off-ledger recently-viewed ingestion, listing, and retention pruning (task 14.3).
 *
 * Part of the Profile / Preferences Service (design.md "Component 9"). Recently-
 * viewed is deliberately kept **entirely off the ledger**: it is a high-write-
 * volume behavioural signal, so it lives in its own `customer_recently_viewed`
 * table (created by the task 14.1 migration) and is NEVER written to
 * `ledger_entries` and NEVER affects any customer's Balance or Spendable_Balance
 * (Requirement 17.3/17.5, Property 13). This module issues SQL exclusively
 * against `customer_recently_viewed`; it holds no reference to the ledger.
 *
 * Responsibilities (Requirements 17.5 & 11.10, assumption A10):
 *   - {@link RecentlyViewedStore.recordView}  ingest a product view, rate-limited/
 *     sampled and off-ledger, upserting `viewed_at` (design `recordView`).
 *   - {@link RecentlyViewedStore.listRecentlyViewed}  return the customer's recently-
 *     viewed products EXCLUDING any entry older than the 90-day retention window
 *     (A10) — most-recent-first.
 *   - {@link RecentlyViewedStore.prune}  delete entries older than the retention
 *     window so recently-viewed is pruned to A10's rolling window (Req 11.10).
 *
 * ── Rate-limit / sampling approach ───────────────────────────────────────────
 * A product view is an extremely chatty event (every page impression could fire
 * one), yet the only information the profile needs is "which products, and how
 * recently". Because the table upserts `viewed_at` on repeat views, two views of
 * the same product seconds apart carry no extra profile value — the second write
 * merely bumps a timestamp that is already fresh.
 *
 * So ingestion is throttled with a per-(customer, product) MINIMUM INTERVAL
 * (`minIntervalMs`, default 60s). The first view of a product is written; any
 * further view of the SAME product by the SAME customer within the interval is
 * SAMPLED OUT (dropped) and performs no DB write. This coalesces bursts into at
 * most one write per product per interval, bounding write volume while keeping
 * recency effectively fresh. The throttle state is an in-memory, best-effort LRU
 * map bounded by `maxTrackedKeys` (default 50k); when full, the oldest keys are
 * evicted (a dropped key just means the next view is written — correct, never
 * incorrect). The map is process-local, so ingestion stays fast and never
 * depends on the database to decide whether to sample. Throttling only ever
 * SKIPS writes; it can never corrupt or fabricate data.
 *
 * SAFETY: defining this module touches no live/production system. It issues SQL
 * only when a caller passes a real Pool/PoolClient at runtime; all behaviour is
 * unit-tested against an in-memory {@link Queryable} fake and an injected clock.
 */
import type { QueryResult, QueryResultRow } from "pg";

/**
 * Minimal DB surface this store needs. A `pg` Pool and PoolClient both satisfy
 * it, so ingestion/listing/pruning can run standalone or inside a caller's
 * transaction, and the logic is testable without a live database. Declared
 * locally so the profile store carries no dependency on the ledger module.
 */
export interface Queryable {
  query<R extends QueryResultRow = QueryResultRow>(
    queryText: string,
    values?: unknown[],
  ): Promise<QueryResult<R>>;
}

/** Injectable clock so retention windows and throttling are deterministic in tests. */
export type Clock = () => Date;

/** A recently-viewed entry, most-recent-first when listed. `productId` is the Shopify product id as a string (BIGINT). */
export interface RecentlyViewedEntry {
  productId: string;
  viewedAt: Date;
}

/** Tuning for retention and the ingestion rate-limit/sampling. */
export interface RecentlyViewedOptions {
  /** Rolling retention window in whole days (A10 default 90). Entries older than this are excluded and pruned. */
  retentionDays?: number;
  /**
   * Minimum interval, in milliseconds, between accepted writes for the same
   * (customer, product). Repeat views inside this window are sampled out
   * (dropped, no write). Default 60_000 (60s). Set to 0 to disable sampling.
   */
  minIntervalMs?: number;
  /** Upper bound on tracked throttle keys before oldest are evicted (default 50_000). */
  maxTrackedKeys?: number;
  /** Clock used for `viewed_at`, retention cutoffs, and throttle decisions (default `() => new Date()`). */
  now?: Clock;
}

/** Default rolling retention window (assumption A10). */
export const DEFAULT_RETENTION_DAYS = 90;
/** Default minimum interval between accepted writes for the same (customer, product). */
export const DEFAULT_MIN_INTERVAL_MS = 60_000;
/** Default cap on in-memory throttle keys. */
export const DEFAULT_MAX_TRACKED_KEYS = 50_000;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Stable machine-readable error codes surfaced to callers. */
export const RECENTLY_VIEWED_ERROR_CODES = {
  invalidInput: "recently_viewed_invalid_input",
} as const;

/** Thrown when a customer id or product id is missing or malformed. */
export class RecentlyViewedValidationError extends Error {
  readonly code = RECENTLY_VIEWED_ERROR_CODES.invalidInput;
  constructor(message: string) {
    super(message);
    this.name = "RecentlyViewedValidationError";
  }
}

const UPSERT_VIEW_SQL = `
  INSERT INTO customer_recently_viewed (customer_id, shopify_product_id, viewed_at)
  VALUES ($1, $2, $3)
  ON CONFLICT (customer_id, shopify_product_id)
  DO UPDATE SET viewed_at = EXCLUDED.viewed_at
`;

const LIST_SQL = `
  SELECT shopify_product_id::text AS product_id, viewed_at
  FROM customer_recently_viewed
  WHERE customer_id = $1
    AND viewed_at > $2
  ORDER BY viewed_at DESC, shopify_product_id DESC
`;

const PRUNE_CUSTOMER_SQL = `
  DELETE FROM customer_recently_viewed
  WHERE customer_id = $2
    AND viewed_at <= $1
`;

const PRUNE_ALL_SQL = `
  DELETE FROM customer_recently_viewed
  WHERE viewed_at <= $1
`;

function assertCustomerId(customerId: string): void {
  if (typeof customerId !== "string" || customerId.trim() === "") {
    throw new RecentlyViewedValidationError("A recently-viewed operation requires a customer id.");
  }
}

/**
 * Validates and normalises a Shopify product id. Accepts a positive integer
 * string (BIGINT); rejects empty, non-numeric, zero, or negative values. Kept
 * as a string so the full BIGINT range survives without float precision loss.
 */
function normaliseProductId(productId: string): string {
  if (typeof productId !== "string" || productId.trim() === "") {
    throw new RecentlyViewedValidationError("recordView requires a product id.");
  }
  const trimmed = productId.trim();
  if (!/^\d+$/.test(trimmed) || /^0+$/.test(trimmed)) {
    throw new RecentlyViewedValidationError(
      `A product id must be a positive integer (Shopify product id); received '${productId}'.`,
    );
  }
  return trimmed;
}

/**
 * Off-ledger recently-viewed store. Owns ingestion (rate-limited/sampled),
 * retention-windowed listing, and pruning for `customer_recently_viewed`.
 *
 * Construct with a `pg` Pool for standalone use, or pass a PoolClient to any
 * method's `executor` argument to run inside a caller's transaction. All time-
 * dependent behaviour uses the injected `now` clock.
 */
export class RecentlyViewedStore {
  private readonly retentionDays: number;
  private readonly minIntervalMs: number;
  private readonly maxTrackedKeys: number;
  private readonly now: Clock;
  private readonly pool: Queryable;

  /**
   * In-memory, best-effort throttle state: (customer:product) -> epoch ms of the
   * last ACCEPTED write. Insertion order gives cheap LRU eviction via Map.
   */
  private readonly lastAccepted = new Map<string, number>();

  constructor(pool: Queryable, options: RecentlyViewedOptions = {}) {
    this.pool = pool;
    const retentionDays = options.retentionDays ?? DEFAULT_RETENTION_DAYS;
    if (!Number.isInteger(retentionDays) || retentionDays <= 0) {
      throw new RecentlyViewedValidationError(
        `retentionDays must be a positive whole number of days; received ${String(retentionDays)}.`,
      );
    }
    const minIntervalMs = options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
    if (!Number.isInteger(minIntervalMs) || minIntervalMs < 0) {
      throw new RecentlyViewedValidationError(
        `minIntervalMs must be a non-negative integer; received ${String(minIntervalMs)}.`,
      );
    }
    const maxTrackedKeys = options.maxTrackedKeys ?? DEFAULT_MAX_TRACKED_KEYS;
    if (!Number.isInteger(maxTrackedKeys) || maxTrackedKeys <= 0) {
      throw new RecentlyViewedValidationError(
        `maxTrackedKeys must be a positive integer; received ${String(maxTrackedKeys)}.`,
      );
    }
    this.retentionDays = retentionDays;
    this.minIntervalMs = minIntervalMs;
    this.maxTrackedKeys = maxTrackedKeys;
    this.now = options.now ?? (() => new Date());
  }

  /** The retention cutoff instant: entries with `viewed_at <= cutoff` are excluded/pruned. */
  private retentionCutoff(nowMs: number): Date {
    return new Date(nowMs - this.retentionDays * MS_PER_DAY);
  }

  /**
   * Decides whether a view for `(customerId, productId)` should be written now
   * or sampled out, updating throttle state when accepted. Pure w.r.t. the DB —
   * touches only the in-memory LRU map. Returns true iff the caller should write.
   */
  private shouldRecord(customerId: string, productId: string, nowMs: number): boolean {
    if (this.minIntervalMs === 0) {
      return true;
    }
    const key = `${customerId}:${productId}`;
    const previous = this.lastAccepted.get(key);
    if (previous !== undefined && nowMs - previous < this.minIntervalMs) {
      // Repeat view inside the minimum interval — sample it out (no write).
      return false;
    }
    // Accept: record acceptance time as the most-recently-used key.
    this.lastAccepted.delete(key);
    this.lastAccepted.set(key, nowMs);
    this.evictIfNeeded();
    return true;
  }

  /** Bounds the throttle map by evicting the oldest (least-recently-accepted) keys. */
  private evictIfNeeded(): void {
    while (this.lastAccepted.size > this.maxTrackedKeys) {
      const oldest = this.lastAccepted.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.lastAccepted.delete(oldest);
    }
  }

  /**
   * Ingests a product view for a customer (design `recordView`; Req 17.5).
   *
   * Off-ledger by construction: writes only to `customer_recently_viewed` and
   * never to `ledger_entries`, so it can never change a Balance (Property 13).
   * Rate-limited/sampled: repeat views of the same product within
   * `minIntervalMs` are dropped (see the module header for the approach). An
   * accepted view UPSERTs `viewed_at` to now, so a re-view simply refreshes
   * recency rather than inserting a duplicate row.
   *
   * Resolves with no value regardless of whether the view was written or
   * sampled, matching the `ProfileService.recordView` contract.
   *
   * @param customerId the viewing customer's local id.
   * @param productId  the Shopify product id (positive integer string).
   * @param executor   optional Pool/PoolClient to run within (defaults to the store's pool).
   */
  async recordView(
    customerId: string,
    productId: string,
    executor: Queryable = this.pool,
  ): Promise<void> {
    assertCustomerId(customerId);
    const normalisedProductId = normaliseProductId(productId);
    const now = this.now();
    const nowMs = now.getTime();

    if (!this.shouldRecord(customerId, normalisedProductId, nowMs)) {
      return; // sampled out — deliberately no DB write
    }

    await executor.query(UPSERT_VIEW_SQL, [customerId, normalisedProductId, now]);
  }

  /**
   * Returns a customer's recently-viewed products, most-recent-first, EXCLUDING
   * any entry older than the retention window (A10; Req 17.5). Returns an empty
   * array when the customer has no in-window entries (Req 17.9 — empty, not an
   * error). This is a read helper consumed by the Fragrance_Profile composition
   * (task 14.5); it performs no writes and never prunes.
   *
   * @param customerId the customer whose recently-viewed to read.
   * @param executor   optional Pool/PoolClient to run within.
   */
  async listRecentlyViewed(
    customerId: string,
    executor: Queryable = this.pool,
  ): Promise<RecentlyViewedEntry[]> {
    assertCustomerId(customerId);
    const cutoff = this.retentionCutoff(this.now().getTime());
    const result = await executor.query<{ product_id: string; viewed_at: Date }>(LIST_SQL, [
      customerId,
      cutoff,
    ]);
    return result.rows.map((row) => ({ productId: row.product_id, viewedAt: row.viewed_at }));
  }

  /**
   * Prunes recently-viewed entries older than the retention window (Req 11.10;
   * A10). Deletes every row whose `viewed_at <= now - retentionDays`. When
   * `customerId` is provided the prune is scoped to that customer; otherwise it
   * prunes across all customers (for a scheduled retention sweep). Returns the
   * number of rows deleted.
   *
   * @param customerId optional customer to scope the prune to.
   * @param executor   optional Pool/PoolClient to run within.
   */
  async prune(customerId?: string, executor: Queryable = this.pool): Promise<number> {
    const cutoff = this.retentionCutoff(this.now().getTime());
    if (customerId !== undefined) {
      assertCustomerId(customerId);
      const result = await executor.query(PRUNE_CUSTOMER_SQL, [cutoff, customerId]);
      return result.rowCount ?? 0;
    }
    const result = await executor.query(PRUNE_ALL_SQL, [cutoff]);
    return result.rowCount ?? 0;
  }
}
