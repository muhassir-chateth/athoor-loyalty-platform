/**
 * `state/requestCache.ts` — in-flight coalescing and the one TTL (spec task 18.2,
 * design §16.3, §16.5).
 *
 * Requirements 18.8, 18.9, 16.6, 16.7, 1.8.
 *
 * ── TWO MECHANISMS, BECAUSE TWO REQUIREMENTS ────────────────────────────────
 * Requirement 18.8 asks that one resource is requested once per page load;
 * Requirement 18.9 asks that the balance is not re-read every few seconds. Those
 * are different questions — "is this in flight?" and "is this recent enough?" —
 * and conflating them into one TTL cache would either serve a stale order list or
 * fail to deduplicate a concurrent read.
 *
 * ── WHY ONLY `GET /balance` HAS A TTL ───────────────────────────────────────
 * Balance, tier, progress, benefits and rewards are read by Overview, Rewards and
 * Activity, and they change only through the customer's own redemption or a
 * webhook. Orders and wishlist change through the customer's own action IN THE
 * SAME PAGE, so they must read through — a cached wishlist would show a customer
 * the item they just removed. Widening this TTL is therefore not a tuning knob; it
 * is a correctness change.
 *
 * ── A `Map`, NOT `sessionStorage` (Requirement 1.8) ─────────────────────────
 * `sessionStorage` would survive navigation, which sounds like a feature until a
 * tab open for an hour shows an hour-old balance — and it would put
 * customer-shaped data into client storage for no gain, since a full page load
 * re-renders anyway. This module performs ZERO storage writes, which is asserted
 * rather than promised.
 *
 * SAFETY: memory only. Everything here dies with the page.
 */
import { cacheKeyFor, proxyFetch } from "../transport/proxyClient.js";

/** §16.5 — the only cached resource, and its window. */
const BALANCE_KEY = "GET /balance";
const BALANCE_TTL_MS = 60_000;

/** Promises for requests currently in flight, keyed by resource identity. */
const inFlight = new Map<string, Promise<PortalResult<unknown>>>();

interface Snapshot {
  readonly at: number;
  readonly result: PortalResult<unknown>;
}

/** The balance snapshot. At most one entry, by construction. */
let balanceSnapshot: Snapshot | null = null;

/**
 * A clock seam so the TTL is testable without waiting a minute.
 *
 * Injected rather than mocked globally because a test that stubs `Date.now` for
 * the whole module graph also stubs it for the transport's timers, and a timer
 * that never advances is a hang rather than a failure.
 */
let now: () => number = () => Date.now();

/** Test seam only. */
export function setCacheClock(clock: () => number): void {
  now = clock;
}

/**
 * Read through the cache.
 *
 * Order of checks matters. The TTL snapshot is consulted BEFORE the in-flight map
 * so a fresh snapshot is served without waiting on a request that is already
 * running for someone else; then coalescing catches the concurrent case.
 */
export async function read<T>(spec: PortalRequestSpec): Promise<PortalResult<T>> {
  const key = cacheKeyFor(spec);
  const cacheable = key === BALANCE_KEY;

  if (cacheable && balanceSnapshot && now() - balanceSnapshot.at < BALANCE_TTL_MS) {
    return balanceSnapshot.result as PortalResult<T>;
  }

  const existing = inFlight.get(key);
  if (existing) return existing as Promise<PortalResult<T>>;

  const flight = proxyFetch<T>(spec)
    .then((result) => {
      // FAILURES ARE NEVER CACHED, and a 429 least of all (§16.5). Caching a
      // failure would make a transient outage look permanent for 60 s, and
      // caching a 429 would keep answering from the cache after the wait had
      // elapsed — the one moment a real request is wanted.
      if (cacheable && result.ok) {
        balanceSnapshot = { at: now(), result: result as PortalResult<unknown> };
      }
      return result as PortalResult<unknown>;
    })
    .finally(() => {
      // Cleared whatever happened, so a failed read is retryable immediately.
      inFlight.delete(key);
    });

  inFlight.set(key, flight);
  return flight as Promise<PortalResult<T>>;
}

/**
 * Drop the balance snapshot — called immediately after a successful redemption
 * (§5.2, §9.3, §16.5).
 *
 * Without this the post-redemption balance would be the pre-redemption one for up
 * to 60 s, which is the single most alarming thing the portal could show: a
 * customer who has just spent points seeing the old total cannot tell whether the
 * spend worked.
 */
export function invalidateBalance(): void {
  balanceSnapshot = null;
}

/** Drop everything — for a wholesale section retry, and for tests. */
export function clear(): void {
  balanceSnapshot = null;
  inFlight.clear();
}

/** How many entries are held. Carries no customer data; exists for the tests. */
export function size(): number {
  return inFlight.size + (balanceSnapshot ? 1 : 0);
}
