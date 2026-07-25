/**
 * Per-customer redemption rate limiting (task 6.5, Requirement 11.12).
 *
 * Requirement 11.12: "WHILE a customer has issued more than 10 requests to
 * `/v1/redeem` within a 60-second window, THE Loyalty_Service SHALL reject
 * further redemption requests from that customer until the window elapses."
 *
 * This module implements the design's "Rate-limit as a safety valve" —
 * per-customer request throttling on `/v1/redeem` to blunt abuse (design.md →
 * Security). It is a REUSABLE Fastify `preHandler` factory, not baked into a
 * single route, so it can guard the redemption route today and any future
 * abuse-prone endpoint tomorrow.
 *
 * KEYING: the limiter counts per LOCAL customer, keyed on
 * `req.authCtx.customerId`, which the `/v1` auth preHandler (task 6.2) resolves
 * BEFORE any route-level preHandler runs. Because a route-level preHandler runs
 * after the scope-level auth/idempotency hooks, `req.authCtx` is always
 * populated when the limiter executes; a request that failed auth was already
 * rejected and never reaches here. (Defensively, a missing identity is rejected
 * 401 rather than counted, so an unkeyable request can never bypass the gate.)
 *
 * ALGORITHM — sliding-window log (documented choice): for each customer we keep
 * the timestamps of their recent redemption requests. On each request we drop
 * timestamps older than the window, then:
 *   - if the number of remaining (in-window) requests is already at the limit
 *     (10), the new request would make it MORE THAN 10 in the window, so it is
 *     rejected with HTTP 429 and NOT recorded (Req 11.12);
 *   - otherwise the request is recorded and allowed.
 * A sliding-window log (rather than a fixed calendar window) is used so the
 * limit reflects the true trailing 60 seconds and "resets" precisely as the
 * oldest request ages out — a burst at the end of one fixed window plus a burst
 * at the start of the next cannot slip 20 requests through in ~60s.
 *
 * CLOCK: time is read through an injectable {@link Clock} so tests advance time
 * deterministically (allow 10, reject the 11th, then allow again once the
 * window elapses) without real waits and without touching any live system.
 *
 * STATE: counters live in an in-memory {@link RateLimiterStore}. This is a
 * best-effort, per-instance safety valve (matching the design's intent to
 * "blunt abuse"), not a ledger-grade guarantee; exactly-once redemption is
 * enforced separately at the engine via the `redemptions (customer_id,
 * idempotency_key)` UNIQUE constraint (see `redemption/redeem.ts`).
 *
 * SCOPE (task 6.5 only): this module implements the limiter and exposes a
 * factory to attach it to the redeem route. It does NOT implement the full
 * `/v1/redeem` HTTP handler (covered elsewhere) — it only guards that path.
 *
 * SAFETY: defining this module touches no live/production system. It holds
 * state purely in process memory and calls no database or Shopify API.
 */
import type { FastifyReply, FastifyRequest, preHandlerAsyncHookHandler } from "fastify";

/**
 * Maximum redemption requests permitted per customer within the window before
 * further requests are rejected (Req 11.12: "more than 10 ... within a
 * 60-second window"). The 10th request is allowed; the 11th is rejected.
 */
export const REDEEM_RATE_LIMIT_MAX_REQUESTS = 10 as const;

/** The rolling window over which requests are counted (Req 11.12: 60 seconds). */
export const REDEEM_RATE_LIMIT_WINDOW_MS = 60_000 as const;

/** The client-facing error code returned when the limit is exceeded. */
export const RATE_LIMIT_EXCEEDED_ERROR = "rate_limit_exceeded" as const;

/**
 * A monotonic-ish source of the current epoch time in milliseconds. Injected so
 * tests advance time deterministically. Production uses {@link systemClock}.
 */
export interface Clock {
  now(): number;
}

/** The default clock: wall-clock epoch milliseconds. */
export const systemClock: Clock = {
  now: () => Date.now(),
};

/** The outcome of a limiter check for a single request. */
export interface RateLimitDecision {
  /** True iff the request is within the limit and was recorded. */
  allowed: boolean;
  /** In-window request count AFTER this decision (recorded requests only). */
  count: number;
  /**
   * Milliseconds until at least one slot frees up (the oldest in-window request
   * ages out). Zero when the request was allowed. Used to build `Retry-After`.
   */
  retryAfterMs: number;
}

/**
 * The counter store contract. `hit` records-or-rejects a request for `key` at
 * time `nowMs` and returns the {@link RateLimitDecision}. Kept behind an
 * interface so an alternative (e.g. Redis-backed) store can replace the
 * in-memory default without changing the preHandler.
 */
export interface RateLimiterStore {
  hit(key: string, nowMs: number): RateLimitDecision;
}

/**
 * In-memory sliding-window-log store. Holds, per key, the sorted timestamps of
 * the requests currently inside the window; entries older than the window are
 * pruned on access so memory stays bounded by the per-window request count.
 *
 * Node's single-threaded event loop makes each `hit` atomic with respect to
 * other JS turns, so no locking is needed.
 */
export class InMemorySlidingWindowStore implements RateLimiterStore {
  private readonly hitsByKey = new Map<string, number[]>();

  constructor(
    private readonly maxRequests: number = REDEEM_RATE_LIMIT_MAX_REQUESTS,
    private readonly windowMs: number = REDEEM_RATE_LIMIT_WINDOW_MS,
  ) {}

  hit(key: string, nowMs: number): RateLimitDecision {
    const windowStart = nowMs - this.windowMs;
    const existing = this.hitsByKey.get(key) ?? [];

    // Drop timestamps that have aged out of the trailing window.
    const inWindow = existing.filter((ts) => ts > windowStart);

    if (inWindow.length >= this.maxRequests) {
      // Already at the limit → this request would exceed it. Reject WITHOUT
      // recording it, so a blocked client cannot push the reset further out by
      // hammering the endpoint (Req 11.12). Retry-After is the time until the
      // oldest in-window request ages out and frees a slot.
      const oldest = inWindow[0] ?? nowMs;
      const retryAfterMs = Math.max(0, oldest + this.windowMs - nowMs);
      this.hitsByKey.set(key, inWindow);
      return { allowed: false, count: inWindow.length, retryAfterMs };
    }

    // Within the limit → record this request and allow it.
    inWindow.push(nowMs);
    this.hitsByKey.set(key, inWindow);
    return { allowed: true, count: inWindow.length, retryAfterMs: 0 };
  }

  /** Test/introspection helper: number of keys currently tracked. */
  get size(): number {
    return this.hitsByKey.size;
  }
}

/** Options accepted by {@link createRedemptionRateLimiter}. */
export interface RedemptionRateLimiterOptions {
  /** Max requests per window (defaults to {@link REDEEM_RATE_LIMIT_MAX_REQUESTS}). */
  maxRequests?: number;
  /** Window length in ms (defaults to {@link REDEEM_RATE_LIMIT_WINDOW_MS}). */
  windowMs?: number;
  /** Time source (defaults to {@link systemClock}); inject a fake clock in tests. */
  clock?: Clock;
  /**
   * Counter store (defaults to an {@link InMemorySlidingWindowStore} built from
   * the effective max/window). Inject to share/inspect state in tests.
   */
  store?: RateLimiterStore;
  /**
   * Extracts the per-customer key from a request. Defaults to
   * `req.authCtx.customerId`; returns `null` when identity is absent so the
   * limiter can fail closed rather than count an unkeyable request.
   */
  keyFor?: (req: FastifyRequest) => string | null;
}

/** Default key extractor: the local customer id resolved by the auth layer. */
function defaultKeyFor(req: FastifyRequest): string | null {
  return req.authCtx?.customerId ?? null;
}

/**
 * Builds a reusable Fastify `preHandler` that enforces per-customer redemption
 * rate limiting (Req 11.12). Attach it to the redeem route:
 *
 *   app.post("/redeem", { preHandler: [createRedemptionRateLimiter()] }, handler)
 *
 * Behaviour:
 *   - resolves the customer key (default `req.authCtx.customerId`); a missing
 *     identity is rejected 401 (defensive — auth normally rejects first) so an
 *     unkeyable request is never silently allowed;
 *   - records the request in the sliding window and, if it would exceed the
 *     limit, rejects it with HTTP 429 `rate_limit_exceeded`, a `Retry-After`
 *     header (seconds), and a clear message — the downstream handler never runs
 *     so no redemption is attempted (Req 11.12);
 *   - otherwise attaches nothing and lets the request proceed.
 *
 * The limiter is per-customer (Req 11.12): one customer hitting the limit never
 * affects another, because the store is keyed by customer id.
 */
export function createRedemptionRateLimiter(
  opts: RedemptionRateLimiterOptions = {},
): preHandlerAsyncHookHandler {
  const maxRequests = opts.maxRequests ?? REDEEM_RATE_LIMIT_MAX_REQUESTS;
  const windowMs = opts.windowMs ?? REDEEM_RATE_LIMIT_WINDOW_MS;
  const clock = opts.clock ?? systemClock;
  const store = opts.store ?? new InMemorySlidingWindowStore(maxRequests, windowMs);
  const keyFor = opts.keyFor ?? defaultKeyFor;

  return async function redemptionRateLimit(
    req: FastifyRequest,
    reply: FastifyReply,
  ): Promise<FastifyReply | void> {
    const key = keyFor(req);
    if (!key) {
      // No resolvable customer identity → cannot key the limit. Fail closed so
      // an unauthenticated/unresolved request can never bypass the gate. The
      // auth preHandler normally rejects such a request before this runs.
      reply.code(401).send({
        error: "identity_resolution_failed",
        message: "Could not resolve the request to a loyalty customer identity.",
      });
      return reply;
    }

    const decision = store.hit(key, clock.now());
    if (!decision.allowed) {
      const retryAfterSeconds = Math.max(1, Math.ceil(decision.retryAfterMs / 1000));
      reply.header("retry-after", String(retryAfterSeconds));
      reply.code(429).send({
        error: RATE_LIMIT_EXCEEDED_ERROR,
        message:
          `Too many redemption requests: at most ${maxRequests} are permitted per ` +
          `${Math.round(windowMs / 1000)}-second window. Please retry in ` +
          `${retryAfterSeconds}s.`,
        retryAfterSeconds,
      });
      return reply;
    }

    // Within the limit → let the redemption handler run.
  };
}
