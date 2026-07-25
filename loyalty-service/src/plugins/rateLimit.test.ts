/**
 * Behavioural + unit tests for per-customer redemption rate limiting
 * (task 6.5, Requirement 11.12).
 *
 * The limiter is exercised two ways:
 *   1. Directly against the {@link InMemorySlidingWindowStore} (pure, no HTTP)
 *      to nail the window arithmetic with a deterministic clock.
 *   2. Through a real Fastify instance with the {@link createRedemptionRateLimiter}
 *      preHandler attached to a side-effecting POST route, keyed off an
 *      injected `req.authCtx` (as the /v1 auth layer would populate it), to
 *      assert the 11th request is rejected 429 without running the handler,
 *      that the window resets, and that customers are isolated.
 *
 * A fake clock advances time with no real waits and touches no live system.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import {
  createRedemptionRateLimiter,
  InMemorySlidingWindowStore,
  REDEEM_RATE_LIMIT_MAX_REQUESTS,
  REDEEM_RATE_LIMIT_WINDOW_MS,
  type Clock,
} from "./rateLimit.js";

/** A hand-cranked clock so tests move time deterministically. */
class FakeClock implements Clock {
  constructor(private ms: number = 0) {}
  now(): number {
    return this.ms;
  }
  advance(deltaMs: number): void {
    this.ms += deltaMs;
  }
  set(ms: number): void {
    this.ms = ms;
  }
}

/**
 * Builds an app whose POST /redeem increments a counter, guarded by the
 * limiter. `req.authCtx.customerId` is seeded from an `x-customer` header to
 * stand in for the /v1 auth preHandler.
 */
function buildApp(clock: Clock): { app: FastifyInstance; getCount: () => number } {
  const app = Fastify({ logger: false });
  let count = 0;

  app.register(async (scope) => {
    // Stand-in for the auth preHandler (task 6.2): resolve identity first.
    scope.addHook("preHandler", async (req: FastifyRequest) => {
      const header = req.headers["x-customer"];
      const customerId = Array.isArray(header) ? header[0] : header;
      if (customerId) {
        req.authCtx = { customerId, source: "app_proxy", channel: "web" };
      }
    });

    scope.post(
      "/redeem",
      { preHandler: [createRedemptionRateLimiter({ clock })] },
      async () => {
        count += 1;
        return { count };
      },
    );
  });

  return { app, getCount: () => count };
}

async function redeemAs(app: FastifyInstance, customerId: string) {
  return app.inject({ method: "POST", url: "/redeem", headers: { "x-customer": customerId } });
}

describe("InMemorySlidingWindowStore (Req 11.12)", () => {
  it("allows exactly the max requests, then rejects the next", () => {
    const store = new InMemorySlidingWindowStore(10, 60_000);
    for (let i = 1; i <= 10; i += 1) {
      const d = store.hit("c1", 1000);
      expect(d.allowed).toBe(true);
      expect(d.count).toBe(i);
    }
    const eleventh = store.hit("c1", 1000);
    expect(eleventh.allowed).toBe(false);
    expect(eleventh.count).toBe(10);
    expect(eleventh.retryAfterMs).toBe(60_000);
  });

  it("frees a slot once the oldest request ages out of the window", () => {
    const store = new InMemorySlidingWindowStore(10, 60_000);
    // 10 requests at t=1000ms fill the window.
    for (let i = 0; i < 10; i += 1) {
      store.hit("c1", 1000);
    }
    // Still blocked just before the first request ages out.
    expect(store.hit("c1", 60_999).allowed).toBe(false);
    // At t=61_001ms the t=1000 request is older than 60s → one slot frees up.
    const afterReset = store.hit("c1", 61_001);
    expect(afterReset.allowed).toBe(true);
  });

  it("does not record a rejected request (blocked clients cannot push the reset out)", () => {
    const store = new InMemorySlidingWindowStore(2, 60_000);
    store.hit("c1", 0); // t=0
    store.hit("c1", 100); // t=100 → window now full (2)
    // Repeatedly blocked at t=200; these must NOT be recorded.
    expect(store.hit("c1", 200).allowed).toBe(false);
    expect(store.hit("c1", 200).allowed).toBe(false);
    // Once t=0 ages out (>60s), a slot frees regardless of the blocked hits.
    expect(store.hit("c1", 60_050).allowed).toBe(true);
  });

  it("keeps counts isolated per customer key", () => {
    const store = new InMemorySlidingWindowStore(1, 60_000);
    expect(store.hit("a", 0).allowed).toBe(true);
    expect(store.hit("a", 0).allowed).toBe(false); // a is now blocked
    expect(store.hit("b", 0).allowed).toBe(true); // b is unaffected
  });
});

describe("redemption rate-limit preHandler (Req 11.12)", () => {
  let clock: FakeClock;
  let app: FastifyInstance;
  let getCount: () => number;

  beforeEach(async () => {
    clock = new FakeClock(1_000);
    const built = buildApp(clock);
    app = built.app;
    getCount = built.getCount;
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it("allows 10 requests within the window then rejects the 11th with 429", async () => {
    for (let i = 1; i <= REDEEM_RATE_LIMIT_MAX_REQUESTS; i += 1) {
      const res = await redeemAs(app, "cust-1");
      expect(res.statusCode).toBe(200); // handler ran (test counter route)
    }
    expect(getCount()).toBe(REDEEM_RATE_LIMIT_MAX_REQUESTS);

    const rejected = await redeemAs(app, "cust-1");
    expect(rejected.statusCode).toBe(429);
    expect(rejected.json()).toMatchObject({ error: "rate_limit_exceeded" });
    expect(rejected.headers["retry-after"]).toBeDefined();
    // The 11th handler never ran → no additional state change.
    expect(getCount()).toBe(REDEEM_RATE_LIMIT_MAX_REQUESTS);
  });

  it("allows requests again once the 60-second window elapses", async () => {
    for (let i = 0; i < REDEEM_RATE_LIMIT_MAX_REQUESTS; i += 1) {
      await redeemAs(app, "cust-1");
    }
    // 11th within the window is blocked.
    expect((await redeemAs(app, "cust-1")).statusCode).toBe(429);

    // Advance past the window so all prior requests age out.
    clock.advance(REDEEM_RATE_LIMIT_WINDOW_MS + 1);

    const afterReset = await redeemAs(app, "cust-1");
    expect(afterReset.statusCode).toBe(200);
    expect(getCount()).toBe(REDEEM_RATE_LIMIT_MAX_REQUESTS + 1);
  });

  it("isolates the limit per customer", async () => {
    // Exhaust cust-1's budget.
    for (let i = 0; i < REDEEM_RATE_LIMIT_MAX_REQUESTS; i += 1) {
      await redeemAs(app, "cust-1");
    }
    expect((await redeemAs(app, "cust-1")).statusCode).toBe(429);

    // cust-2 is entirely unaffected.
    const other = await redeemAs(app, "cust-2");
    expect(other.statusCode).toBe(200);
  });

  it("rejects a request with no resolved identity as 401 (fail closed)", async () => {
    const res = await app.inject({ method: "POST", url: "/redeem" });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: "identity_resolution_failed" });
    // The handler never ran.
    expect(getCount()).toBe(0);
  });

  it("reports a Retry-After close to the remaining window on rejection", async () => {
    for (let i = 0; i < REDEEM_RATE_LIMIT_MAX_REQUESTS; i += 1) {
      await redeemAs(app, "cust-1");
    }
    const rejected = await redeemAs(app, "cust-1");
    expect(rejected.statusCode).toBe(429);
    const retryAfter = Number(rejected.headers["retry-after"]);
    // Oldest request just happened → ~60s to free a slot.
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(60);
  });
});
