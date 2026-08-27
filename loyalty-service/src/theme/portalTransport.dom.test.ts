// @vitest-environment jsdom
/**
 * Spec task 18.9 — the transport and state unit tests.
 * Validates Requirements 15.5, 15.6, 15.9, 16.6, 16.7, 8.9, 1.8, 1.6, 1.7.
 *
 * ── WHY THESE ARE UNIT TESTS AND NOT AN INTEGRATION TEST ────────────────────
 * Every behaviour here is a decision the transport makes BEFORE or AFTER the
 * network: which budget applies, whether to retry, which key to reuse, what to
 * report when the body will not parse. An integration test against a real service
 * exercises none of those deliberately — you cannot ask a live endpoint to time
 * out at 8 s on demand — so the network is the seam and `fetch` is stubbed.
 *
 * The tests run against the SOURCE, not the built bundle (design §16.7), so a
 * failure names a line of TypeScript.
 *
 * SAFETY: no network — `fetch` is replaced throughout. No database.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cacheKeyFor,
  currentSessionRef,
  isLoyaltyWarm,
  newIdempotencyKey,
  proxyFetch,
  resetTransportSessionState,
} from "../../../theme-src/portal/transport/proxyClient.js";
import * as cache from "../../../theme-src/portal/state/requestCache.js";
import * as draft from "../../../theme-src/portal/state/draft.js";

/* ========================================================================== *
 * Harness
 * ========================================================================== */

interface StubCall {
  readonly url: string;
  readonly init: RequestInit;
}

let calls: StubCall[] = [];

/** A `Response`-shaped stub. Only the members the transport reads are present. */
function response(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  const lower: Record<string, string> = {};
  for (const key of Object.keys(headers)) lower[key.toLowerCase()] = headers[key] as string;
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => lower[name.toLowerCase()] ?? null },
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

/** A stub that answers each call from a queue, repeating the last entry. */
function queueFetch(...answers: (Response | "network" | "hang")[]): void {
  let index = 0;
  globalThis.fetch = vi.fn((url: unknown, init?: unknown) => {
    calls.push({ url: String(url), init: (init ?? {}) as RequestInit });
    const answer = answers[Math.min(index, answers.length - 1)];
    index += 1;
    if (answer === "network") return Promise.reject(new TypeError("Failed to fetch"));
    if (answer === "hang") {
      return new Promise<Response>((_resolve, reject) => {
        const signal = (init as RequestInit | undefined)?.signal;
        signal?.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        });
      });
    }
    return Promise.resolve(answer as Response);
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  calls = [];
  resetTransportSessionState();
  cache.clear();
  cache.setCacheClock(() => Date.now());
  draft.clearAll();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/* ========================================================================== *
 * The request shape (Requirements 1.6, 1.7, 1.8)
 * ========================================================================== */

describe("the request the transport builds", () => {
  it("uses a RELATIVE App Proxy path and never an absolute origin (Req 1.7)", async () => {
    queueFetch(response(200, { spendableBalance: 10 }));
    await proxyFetch({ method: "GET", path: "/balance" });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("/apps/loyalty/v1/balance");
    // The Render origin must never appear: a request there would carry no App
    // Proxy signature and could not be authenticated at all.
    expect(calls[0]?.url).not.toMatch(/^https?:/);
    expect(calls[0]?.url).not.toContain("onrender.com");
  });

  it("sends NO customer identity of any kind (§3.2, Req 1.2)", async () => {
    queueFetch(response(200, {}));
    await proxyFetch({ method: "GET", path: "/profile" });

    const headers = (calls[0]?.init.headers ?? {}) as Record<string, string>;
    const serialised = JSON.stringify(calls[0]).toLowerCase();
    for (const forbidden of ["authorization", "x-customer", "customer_id", "customerid", "email", "shpat_"]) {
      expect(serialised, `sent ${forbidden}`).not.toContain(forbidden);
    }
    // Only the three headers a read is allowed to carry.
    expect(Object.keys(headers).sort()).toEqual(["accept", "x-athoor-session-ref"]);
  });

  it("sends application/json and an Idempotency-Key on a write — never form-encoded (§5.3)", async () => {
    queueFetch(response(200, { ok: true }));
    await proxyFetch({ method: "PUT", path: "/profile/birthday", body: { month: 6, day: 10 } });

    const headers = (calls[0]?.init.headers ?? {}) as Record<string, string>;
    expect(headers["content-type"]).toBe("application/json");
    expect(typeof headers["idempotency-key"]).toBe("string");
    expect((headers["idempotency-key"] ?? "").length).toBeGreaterThan(8);
    // The CSRF property: a cross-site form can produce neither of the above.
    expect(JSON.stringify(headers)).not.toContain("x-www-form-urlencoded");
    expect(JSON.stringify(headers)).not.toContain("multipart");
    expect(calls[0]?.init.body).toBe('{"month":6,"day":10}');
  });

  it("sorts query keys so one resource has one cache key (§16.5)", () => {
    const a = cacheKeyFor({ method: "GET", path: "/orders", query: { page: 1, pageSize: 20 } });
    const b = cacheKeyFor({ method: "GET", path: "/orders", query: { pageSize: 20, page: 1 } });
    expect(a).toBe(b);
    expect(a).toBe("GET /orders?page=1&pageSize=20");
  });

  it("the session reference is non-identifying and never stored (§24.2)", () => {
    const ref = currentSessionRef();
    expect(ref).toMatch(/^[0-9a-f]{16}$/);
    // Nothing about the customer, and no client storage.
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
  });

  it("mints a distinct Idempotency-Key per intent", () => {
    const keys = new Set<string>();
    for (let i = 0; i < 200; i += 1) keys.add(newIdempotencyKey());
    expect(keys.size).toBe(200);
    for (const key of keys) expect(key.length).toBeLessThanOrEqual(128);
  });
});

/* ========================================================================== *
 * Result, never a throw (Requirement 15.8)
 * ========================================================================== */

describe("failures become results, not exceptions", () => {
  it("returns ok:false for every non-2xx rather than throwing", async () => {
    // Fake timers because 502 and 503 are retryable: with real ones this test
    // would spend 4 s per status waiting out the 1 s + 3 s backoff.
    vi.useFakeTimers();
    for (const status of [400, 401, 403, 404, 409, 429, 500, 502, 503]) {
      calls = [];
      resetTransportSessionState();
      queueFetch(response(status, { error: "invalid_request", message: "ignored" }));
      const pending = proxyFetch({ method: "GET", path: "/balance" });
      await vi.advanceTimersByTimeAsync(5_000);
      const result = await pending;
      expect(result.ok, `status ${status} threw or succeeded`).toBe(false);
    }
  });

  it("takes the identifier from the body and NEVER the message (E.1 rule 3)", async () => {
    queueFetch(
      response(409, {
        error: "birthday_change_locked",
        message: "You can change this from 2027-03-04.",
        allowedFrom: "2027-03-04",
      }),
    );
    const result = await proxyFetch({ method: "PUT", path: "/profile/birthday", body: {} });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("birthday_change_locked");
    expect(result.error.allowedFrom).toBe("2027-03-04");
    // The service's sentence must not be anywhere in the failure — the client owns
    // the wording, keyed on the identifier.
    expect(JSON.stringify(result.error)).not.toContain("You can change this");
  });

  it("degrades an UNKNOWN future identifier safely", async () => {
    // A code the service gains after this asset ships.
    queueFetch(response(418, { error: "teapot_unavailable", message: "internal detail" }));
    const result = await proxyFetch({ method: "GET", path: "/balance" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("teapot_unavailable");
    expect(result.error.retryable).toBe(false);
    expect(JSON.stringify(result.error)).not.toContain("internal detail");
  });

  it("handles internal_error — the code task 16 made the service emit", async () => {
    queueFetch(response(500, { error: "internal_error", message: "The request could not be completed." }));
    const result = await proxyFetch({ method: "GET", path: "/balance" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("internal_error");
    // A 500 is worth retrying only if it is one of the two "no answer" statuses;
    // 500 itself is an answer, so no automatic retry and no retry control.
    expect(result.error.retryable).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it("fails safely when the body is not JSON at all", async () => {
    // 500 rather than 502: both exercise the `status >= 500` fallback, and 500 is
    // not retryable, so the test does not spend 4 s waiting out a backoff.
    const broken = {
      ok: false,
      status: 500,
      headers: { get: () => null },
      json: () => Promise.reject(new SyntaxError("Unexpected token < in JSON")),
    } as unknown as Response;
    globalThis.fetch = vi.fn(() => Promise.resolve(broken)) as unknown as typeof fetch;

    const result = await proxyFetch({ method: "GET", path: "/balance" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // Falls back to the status mapping, and the parse error's text never appears.
    expect(result.error.code).toBe("upstream_unavailable");
    expect(JSON.stringify(result.error)).not.toContain("Unexpected token");
    expect(JSON.stringify(result.error)).not.toContain("SyntaxError");
  });

  it("reports a network failure and a timeout as DIFFERENT identifiers", async () => {
    vi.useFakeTimers();
    queueFetch("network");
    const networkPending = proxyFetch({ method: "GET", path: "/catalog/products", target: "shopify" });
    await vi.advanceTimersByTimeAsync(5_000);
    const failed = await networkPending;
    expect(failed.ok).toBe(false);
    if (!failed.ok) expect(failed.error.code).toBe("network_unavailable");

    queueFetch("hang");
    const pending = proxyFetch({ method: "GET", path: "/catalog/products", target: "shopify" });
    await vi.advanceTimersByTimeAsync(8_000);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(8_000);
    await vi.advanceTimersByTimeAsync(3_000);
    await vi.advanceTimersByTimeAsync(8_000);
    const timedOut = await pending;
    expect(timedOut.ok).toBe(false);
    if (!timedOut.ok) expect(timedOut.error.code).toBe("request_timeout");
  });

  it("surfaces x-request-id for §22.9's reference", async () => {
    queueFetch(response(200, { ok: true }, { "x-request-id": "req-abcdef123456" }));
    const result = await proxyFetch({ method: "GET", path: "/balance" });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.requestId).toBe("req-abcdef123456");
  });
});

/* ========================================================================== *
 * Budgets and the cold-start switch (§22.3)
 * ========================================================================== */

describe("timeout budgets", () => {
  it("gives the FIRST loyalty read 60 s, not 8 s (Req 15.9)", async () => {
    vi.useFakeTimers();
    queueFetch("hang");
    const pending = proxyFetch({ method: "GET", path: "/balance" });

    await vi.advanceTimersByTimeAsync(8_000);
    // Still outstanding: the cold-start budget has not elapsed.
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(52_000);
    // Now aborted, and the first automatic retry begins after 1 s.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls.length).toBeGreaterThan(1);

    await vi.advanceTimersByTimeAsync(60_000);
    await vi.advanceTimersByTimeAsync(3_000);
    await vi.advanceTimersByTimeAsync(60_000);
    const result = await pending;
    expect(result.ok).toBe(false);
  });

  it("gives a SHOPIFY read 8 s even when it is the first read (§22.3)", async () => {
    vi.useFakeTimers();
    queueFetch("hang");
    const pending = proxyFetch({ method: "GET", path: "/orders", target: "shopify" });
    await vi.advanceTimersByTimeAsync(8_000);
    // Aborted at 8 s: the cold-start allowance is for our own service only.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(8_000);
    await vi.advanceTimersByTimeAsync(3_000);
    await vi.advanceTimersByTimeAsync(8_000);
    await pending;
  });

  it("drops to 8 s once any loyalty response has arrived", async () => {
    queueFetch(response(500, { error: "internal_error" }));
    expect(isLoyaltyWarm()).toBe(false);
    await proxyFetch({ method: "GET", path: "/balance" });
    // ANY status proves the container is awake (§22.3).
    expect(isLoyaltyWarm()).toBe(true);

    vi.useFakeTimers();
    calls = [];
    queueFetch("hang");
    const pending = proxyFetch({ method: "GET", path: "/history" });
    await vi.advanceTimersByTimeAsync(8_000);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(8_000);
    await vi.advanceTimersByTimeAsync(3_000);
    await vi.advanceTimersByTimeAsync(8_000);
    await pending;
  });

  it("a TIMEOUT does not mark the service warm — a timeout is not a response", async () => {
    vi.useFakeTimers();
    queueFetch("hang");
    const pending = proxyFetch({ method: "GET", path: "/balance" });
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.advanceTimersByTimeAsync(3_000);
    await vi.advanceTimersByTimeAsync(60_000);
    await pending;
    expect(isLoyaltyWarm()).toBe(false);
  });

  it('announces "waking" after 3 s, and only on the cold-start budget', async () => {
    vi.useFakeTimers();
    queueFetch("hang");
    const waking = vi.fn();
    const pending = proxyFetch({ method: "GET", path: "/balance", onWaking: waking });
    await vi.advanceTimersByTimeAsync(2_999);
    expect(waking).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2);
    expect(waking).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(200_000);
    await pending;

    // Warm now, so the same call must NOT announce waking.
    calls = [];
    queueFetch(response(200, {}));
    const second = vi.fn();
    await proxyFetch({ method: "GET", path: "/balance", onWaking: second });
    expect(second).not.toHaveBeenCalled();
  });
});

/* ========================================================================== *
 * Retry policy (§22.4)
 * ========================================================================== */

describe("retry policy", () => {
  it("retries a read at most twice, after 1 s then 3 s", async () => {
    vi.useFakeTimers();
    queueFetch(response(503, { error: "service_unavailable" }));
    const pending = proxyFetch({ method: "GET", path: "/balance" });

    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(2_999);
    expect(calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toHaveLength(3);

    const result = await pending;
    expect(result.ok).toBe(false);
    // Three attempts total: the original plus two retries, and no more.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls).toHaveLength(3);
  });

  it("retries a read on 502 and on a network failure", async () => {
    for (const answer of [response(502, {}), "network" as const]) {
      vi.useFakeTimers();
      calls = [];
      resetTransportSessionState();
      queueFetch(answer);
      const pending = proxyFetch({ method: "GET", path: "/balance" });
      await vi.advanceTimersByTimeAsync(1_000);
      await vi.advanceTimersByTimeAsync(3_000);
      await pending;
      expect(calls.length).toBe(3);
      vi.useRealTimers();
    }
  });

  it("NEVER retries a determinate answer — 400/401/403/404/409/429", async () => {
    for (const status of [400, 401, 403, 404, 409, 429]) {
      vi.useFakeTimers();
      calls = [];
      resetTransportSessionState();
      queueFetch(response(status, { error: "conflict" }));
      const pending = proxyFetch({ method: "GET", path: "/balance" });
      await vi.advanceTimersByTimeAsync(30_000);
      await pending;
      expect(calls.length, `status ${status} was retried`).toBe(1);
      vi.useRealTimers();
    }
  });

  it("never retries a WRITE on a 502 — only where there was no answer (§22.4)", async () => {
    vi.useFakeTimers();
    queueFetch(response(502, { error: "upstream_unavailable" }));
    const pending = proxyFetch({ method: "POST", path: "/redeem", body: { rewardId: "reward_5" } });
    await vi.advanceTimersByTimeAsync(30_000);
    const result = await pending;
    expect(result.ok).toBe(false);
    // A 502 on a write is an answer we cannot interpret as "nothing happened", so
    // repeating it could double-spend. The customer is told instead.
    expect(calls).toHaveLength(1);
  });

  it("retries a write on a network failure with the SAME Idempotency-Key (Req 8.9)", async () => {
    vi.useFakeTimers();
    queueFetch("network");
    const pending = proxyFetch({ method: "POST", path: "/redeem", body: { rewardId: "reward_5" } });
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(3_000);
    await pending;

    expect(calls).toHaveLength(3);
    const keys = calls.map((call) => ((call.init.headers ?? {}) as Record<string, string>)["idempotency-key"]);
    expect(new Set(keys).size, "a retry minted a new key").toBe(1);
    expect(keys[0]).toBeTruthy();
  });

  it("a FRESH submission after a reported failure mints a NEW key (§22.4)", async () => {
    queueFetch(response(500, { error: "internal_error" }));
    await proxyFetch({ method: "POST", path: "/redeem", body: { rewardId: "reward_5" } });
    const first = ((calls[0]?.init.headers ?? {}) as Record<string, string>)["idempotency-key"];

    calls = [];
    queueFetch(response(200, { ok: true }));
    await proxyFetch({ method: "POST", path: "/redeem", body: { rewardId: "reward_5" } });
    const second = ((calls[0]?.init.headers ?? {}) as Record<string, string>)["idempotency-key"];

    expect(first).toBeTruthy();
    expect(second).toBeTruthy();
    expect(second).not.toBe(first);
  });

  it("honours a caller-supplied key, which is how a retried intent replays", async () => {
    queueFetch(response(200, { ok: true }));
    await proxyFetch({
      method: "POST",
      path: "/redeem",
      body: {},
      idempotencyKey: "intent-fixed-key",
    });
    const headers = (calls[0]?.init.headers ?? {}) as Record<string, string>;
    expect(headers["idempotency-key"]).toBe("intent-fixed-key");
  });
});

/* ========================================================================== *
 * The cache (§16.5) and drafts (§16.3)
 * ========================================================================== */

describe("request cache", () => {
  it("coalesces concurrent reads of one resource into ONE request (Req 18.8)", async () => {
    queueFetch(response(200, { spendableBalance: 120 }));
    const [a, b, c] = await Promise.all([
      cache.read({ method: "GET", path: "/balance" }),
      cache.read({ method: "GET", path: "/balance" }),
      cache.read({ method: "GET", path: "/balance" }),
    ]);
    expect(calls).toHaveLength(1);
    expect(a.ok && b.ok && c.ok).toBe(true);
  });

  it("serves the balance from the 60 s snapshot, then reads through (Req 18.9)", async () => {
    let clock = 1_000_000;
    cache.setCacheClock(() => clock);
    queueFetch(response(200, { spendableBalance: 1 }));

    await cache.read({ method: "GET", path: "/balance" });
    expect(calls).toHaveLength(1);

    clock += 59_000;
    await cache.read({ method: "GET", path: "/balance" });
    expect(calls, "read through inside the window").toHaveLength(1);

    clock += 2_000;
    await cache.read({ method: "GET", path: "/balance" });
    expect(calls, "did not read through after the window").toHaveLength(2);
  });

  it("caches ONLY the balance — orders and wishlist read through", async () => {
    queueFetch(response(200, { orders: [] }));
    await cache.read({ method: "GET", path: "/orders" });
    await cache.read({ method: "GET", path: "/orders" });
    await cache.read({ method: "GET", path: "/profile/wishlist" });
    await cache.read({ method: "GET", path: "/profile/wishlist" });
    // A cached wishlist would show a customer the item they just removed.
    expect(calls).toHaveLength(4);
  });

  it("invalidates the balance immediately after a redemption (§5.2, §9.3)", async () => {
    let clock = 1_000_000;
    cache.setCacheClock(() => clock);
    queueFetch(response(200, { spendableBalance: 500 }));
    await cache.read({ method: "GET", path: "/balance" });
    expect(calls).toHaveLength(1);

    cache.invalidateBalance();
    await cache.read({ method: "GET", path: "/balance" });
    // The post-redemption balance must never be the pre-redemption one.
    expect(calls).toHaveLength(2);
  });

  it("never caches a failure, and never caches a 429", async () => {
    let clock = 1_000_000;
    cache.setCacheClock(() => clock);
    queueFetch(response(429, { error: "rate_limit_exceeded", retryAfterSeconds: 30 }));
    await cache.read({ method: "GET", path: "/balance" });
    await cache.read({ method: "GET", path: "/balance" });
    // Caching a 429 would keep answering from the cache after the wait elapsed —
    // the one moment a real request is wanted.
    expect(calls).toHaveLength(2);
    expect(cache.size()).toBe(0);
  });

  it("writes nothing to client storage (Req 1.8)", async () => {
    queueFetch(response(200, { spendableBalance: 7 }));
    await cache.read({ method: "GET", path: "/balance" });
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
  });
});

describe("draft input", () => {
  it("retains unsent input in memory and writes no storage (Req 16.6, 16.7, 1.8)", () => {
    draft.set("address", "address1", "12 Museum Street");
    draft.set("address", "city", "London");
    expect(draft.get("address")).toEqual({ address1: "12 Museum Street", city: "London" });
    expect(draft.has("address")).toBe(true);
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
  });

  it("returns a FRESH object so a caller cannot mutate the store", () => {
    draft.set("address", "city", "London");
    const first = draft.get("address");
    first.city = "Leeds";
    expect(draft.get("address").city).toBe("London");
  });

  it("stores an emptied field rather than dropping the key", () => {
    draft.set("address", "address2", "Flat 3");
    draft.set("address", "address2", "");
    // A customer who cleared a field has expressed something; dropping the key
    // would let a stale value be restored over a deliberate blank.
    expect(draft.get("address")).toEqual({ address2: "" });
  });

  it("clears one scope without touching another", () => {
    draft.set("address", "city", "London");
    draft.set("birthday", "month", "6");
    draft.clear("address");
    expect(draft.has("address")).toBe(false);
    expect(draft.get("birthday")).toEqual({ month: "6" });
  });

  it("a 401 mid-form leaves the draft intact and storage untouched (Req 16.7)", async () => {
    draft.set("address", "address1", "12 Museum Street");
    queueFetch(response(401, { error: "identity_resolution_failed", message: "ignored" }));

    const result = await proxyFetch({ method: "POST", path: "/profile/addresses", body: { address1: "x" } });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("identity_resolution_failed");
    // The whole point of the requirement: the typing survives the expired session.
    expect(draft.get("address")).toEqual({ address1: "12 Museum Street" });
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
  });
});
