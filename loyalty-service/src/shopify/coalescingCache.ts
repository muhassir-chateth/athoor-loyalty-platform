/**
 * THE SHOPIFY READ CACHE — one TTL + hard timeout + in-flight coalescing
 * mechanism, shared rather than copied (spec task 8.1, design §7.6).
 *
 * ── WHY THIS FILE EXISTS ─────────────────────────────────────────────────────
 * Design §7.6 says the Orders read "reuses the caching shape already proven in
 * `CachingPurchaseHistorySource`: 60 s TTL, 2.5 s hard timeout, in-flight
 * coalescing keyed by customer, failures never cached."
 *
 * "Reuses the shape" can be honoured two ways. The cheap way is to copy those
 * forty lines into an orders source, and it is the wrong way: the four
 * properties above are not four independent settings, they are one interacting
 * mechanism. The subtle one is the interaction between coalescing and
 * failure-caching — `inFlight.delete()` must happen in `finally` so a rejection
 * clears the slot, while `cache.set()` must happen only on success. Copy that
 * and the copy is correct on the day it is written; six months later one side
 * gains an eviction bound or a jittered TTL and the other does not, and the two
 * "identical" caches quietly behave differently under load. That is exactly the
 * W1/W2 class of defect this codebase has already paid for twice.
 *
 * So the mechanism is extracted ONCE and both callers use it. There is now one
 * definition of "60 s TTL with a 2.5 s timeout that never caches a failure",
 * and a change to it changes both consumers or neither.
 *
 * ── WHAT IS SHARED, AND WHAT DELIBERATELY IS NOT ─────────────────────────────
 * Shared: the timing, the coalescing, the eviction bound, the never-cache-a-
 * failure rule.
 *
 * NOT shared: what a failure MEANS. The two consumers need opposite behaviour
 * and this is the whole reason {@link CoalescingTtlCache.read} REJECTS rather
 * than returning a fallback:
 *
 *   - `CachingPurchaseHistorySource` degrades to an empty purchase list, because
 *     Req 17.9 requires the profile to render with empty categories rather than
 *     fail. A recommendation is worth less than a page.
 *   - The Orders read must NOT degrade. An empty orders list is
 *     indistinguishable from "you have never bought anything", which is a lie
 *     told to a customer about their own money. §6.3 N1 gives it a distinct
 *     `502 upstream_unavailable` precisely so the client can show the
 *     Orders-specific degraded state instead of an empty state.
 *
 * A cache that swallowed failures could not serve the second consumer at all, so
 * the policy stays with the caller and only the mechanism is shared.
 *
 * ── SAFETY ───────────────────────────────────────────────────────────────────
 * Pure to import. It performs no I/O of its own — it invokes a loader the caller
 * supplies — issues no SQL, holds no credential, and logs nothing.
 */

/** How long a resolved value is reused (design §7.6). */
export const DEFAULT_SHOPIFY_READ_TTL_MS = 60_000;

/**
 * Hard ceiling on one resolution (design §7.6).
 *
 * 2.5 s sits inside the 3 s customer-read budget (Req 8.1) with enough margin
 * left to serialise a response, which is the reason for the specific number:
 * a timeout that fires after the budget has already been blown protects nothing.
 */
export const DEFAULT_SHOPIFY_READ_TIMEOUT_MS = 2_500;

/** Upper bound on cached keys before the oldest are evicted. */
export const DEFAULT_SHOPIFY_READ_MAX_ENTRIES = 500;

/**
 * Raised when one resolution exceeded {@link CoalescingCacheOptions.timeoutMs}.
 *
 * A NAMED TYPE rather than a bare `Error`, so a route boundary can map a slow
 * upstream to `502 upstream_unavailable` by TYPE instead of by matching on
 * message text — the latter being a check that breaks silently the moment the
 * wording changes.
 *
 * The message keeps the shipped `<label> exceeded <n>ms` wording so the
 * behaviour observable to the purchase-history degradation reporter is byte-for
 * byte what it was before the extraction.
 *
 * It carries NO key. The key is a customer id at every present call site, and an
 * error object that holds one tends to end up in a log line or a response body.
 */
export class ShopifyReadTimeoutError extends Error {
  readonly code = "shopify_read_timeout" as const;
  readonly timeoutMs: number;

  constructor(label: string, timeoutMs: number) {
    super(`${label} exceeded ${timeoutMs}ms`);
    this.name = "ShopifyReadTimeoutError";
    this.timeoutMs = timeoutMs;
  }
}

/** Options for {@link CoalescingTtlCache}. */
export interface CoalescingCacheOptions {
  /** How long a resolved value is reused, in ms. Default {@link DEFAULT_SHOPIFY_READ_TTL_MS}. */
  ttlMs?: number;
  /** Hard timeout for one resolution, in ms. Default {@link DEFAULT_SHOPIFY_READ_TIMEOUT_MS}. */
  timeoutMs?: number;
  /** Upper bound on cached keys before the oldest are evicted. Default {@link DEFAULT_SHOPIFY_READ_MAX_ENTRIES}. */
  maxEntries?: number;
  /** Injected clock, so TTL expiry is testable without waiting. */
  now?: () => number;
  /**
   * Prefix for a timeout message, e.g. `"purchase-history read"`. Describes the
   * KIND of read only — never an id, because this string reaches an error
   * message and errors get logged.
   */
  label?: string;
  /**
   * Invoked EXACTLY ONCE PER UNDERLYING READ that failed — including a timeout,
   * which the cache raises itself and a caller-side `catch` therefore cannot
   * attribute to the loader.
   *
   * WHY THIS BELONGS TO THE MECHANISM RATHER THAN THE CALLER. Coalescing means N
   * callers can share one failed read. A caller-side `catch` runs N times and
   * reports the same single upstream failure N times, which makes a log read as
   * though the upstream failed repeatedly. Reporting from inside the shared read
   * is the only place that can count once, so the hook lives here.
   *
   * The read still REJECTS after this runs; the hook observes, it does not
   * recover. That keeps "a failure is never cached" true — a hook that could
   * substitute a value would let a fallback be cached as if it were real data.
   */
  onFailure?: (err: unknown, key: string) => void;
}

/**
 * A keyed TTL cache that collapses concurrent reads of the same key into one
 * underlying call and never caches a failure.
 *
 * ── THE THREE PROPERTIES, AND WHY EACH IS LOAD-BEARING ───────────────────────
 *
 * 1. TTL. Two portal sections may want the same Shopify page within one visit
 *    (§7.6: Overview shows the most recent order, Orders shows the list). On a
 *    free tier the second read costs Admin API budget for no new information.
 *
 * 2. IN-FLIGHT COALESCING. A TTL cache alone does not help two SIMULTANEOUS
 *    askers: both miss, both call through, and the second write merely overwrites
 *    the first. Joining the promise already in flight is what turns "one request
 *    per section" into "one Shopify read".
 *
 * 3. FAILURES ARE NEVER CACHED. If a transient failure were stored, one bad
 *    moment would pin the failure for the whole TTL — turning a blip into a
 *    minute of degradation. The in-flight slot is cleared in `finally`, so the
 *    NEXT caller retries; the value cache is written only on success.
 *
 * A rejection IS shared with everyone who joined the same in-flight read, which
 * is deliberate: one failed read should produce one diagnosis, not one per
 * consumer.
 */
export class CoalescingTtlCache<T> {
  private readonly ttlMs: number;
  private readonly timeoutMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;
  private readonly label: string;
  private readonly onFailure?: (err: unknown, key: string) => void;
  private readonly cache = new Map<string, { at: number; value: T }>();
  private readonly inFlight = new Map<string, Promise<T>>();

  constructor(options: CoalescingCacheOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_SHOPIFY_READ_TTL_MS;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_SHOPIFY_READ_TIMEOUT_MS;
    this.maxEntries = options.maxEntries ?? DEFAULT_SHOPIFY_READ_MAX_ENTRIES;
    this.now = options.now ?? (() => Date.now());
    this.label = options.label ?? "shopify read";
    if (options.onFailure) this.onFailure = options.onFailure;
  }

  /**
   * Returns the cached value for `key` when it is still fresh, otherwise runs
   * `load` under the hard timeout and caches the result.
   *
   * @throws {ShopifyReadTimeoutError} the load exceeded the timeout
   * @throws unknown whatever `load` rejected with, unchanged — so a caller can
   *   classify the upstream failure rather than receive a flattened one
   */
  async read(key: string, load: () => Promise<T>): Promise<T> {
    const nowMs = this.now();
    const hit = this.cache.get(key);
    if (hit && nowMs - hit.at < this.ttlMs) {
      return hit.value;
    }

    // A concurrent asker joins the read already in flight rather than starting a
    // second one.
    const existing = this.inFlight.get(key);
    if (existing) {
      return existing;
    }

    const read = this.loadWithTimeout(key, nowMs, load).finally(() => {
      // Cleared on settle EITHER WAY. Together with "cache only on success"
      // below, this is what makes a failure un-cached rather than sticky.
      this.inFlight.delete(key);
    });
    this.inFlight.set(key, read);
    return read;
  }

  /** Test/diagnostic helper: how many resolved values are held. */
  get size(): number {
    return this.cache.size;
  }

  private async loadWithTimeout(
    key: string,
    nowMs: number,
    load: () => Promise<T>,
  ): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const value = await Promise.race([
        load(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new ShopifyReadTimeoutError(this.label, this.timeoutMs)),
            this.timeoutMs,
          );
        }),
      ]);
      // ONLY on success. The timestamp is the one taken when the read STARTED,
      // not when it finished, so a slow read does not extend its own freshness
      // past the point where the data it holds is stale.
      this.cache.set(key, { at: nowMs, value });
      this.evictIfNeeded();
      return value;
    } catch (err) {
      // Reported here — inside the shared read — so N coalesced callers produce
      // ONE report, and then rethrown so nothing is cached.
      this.onFailure?.(err, key);
      throw err;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Bounds the cache, evicting insertion-order-oldest first.
   *
   * `Map` preserves insertion order and a re-read of a fresh key does not
   * re-insert, so this is oldest-write eviction rather than true LRU. That is
   * adequate and honest: entries live at most one TTL anyway, so recency and
   * write-age barely diverge over a 60 s window.
   */
  private evictIfNeeded(): void {
    while (this.cache.size > this.maxEntries) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }
}
