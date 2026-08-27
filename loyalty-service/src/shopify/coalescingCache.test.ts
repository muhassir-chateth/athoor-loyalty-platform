/**
 * Tests for the shared Shopify read cache (spec task 8.1, design §7.6).
 *
 * The four properties §7.6 names are tested as ONE mechanism, because that is
 * what they are: the interaction between coalescing and never-caching-a-failure
 * is the part a copy gets wrong. `purchaseHistory.test.ts` continues to test the
 * same properties THROUGH `CachingPurchaseHistorySource`, which is deliberate —
 * it proves the extraction changed no observable behaviour for the shipped
 * consumer rather than merely moving code.
 *
 * SAFETY: no network, no Postgres. The loader is a local function.
 */
import { describe, expect, it, vi } from "vitest";
import {
  CoalescingTtlCache,
  DEFAULT_SHOPIFY_READ_MAX_ENTRIES,
  DEFAULT_SHOPIFY_READ_TIMEOUT_MS,
  DEFAULT_SHOPIFY_READ_TTL_MS,
  ShopifyReadTimeoutError,
} from "./coalescingCache.js";

describe("the defaults are the ones design §7.6 names", () => {
  it("is 60 s TTL and a 2.5 s hard timeout", () => {
    // Not a tautology: §7.6 states both numbers, and the 2.5 s exists to sit
    // inside the 3 s customer-read budget (Req 8.1). A change to either is a
    // change to a documented promise, so it has to break a test.
    expect(DEFAULT_SHOPIFY_READ_TTL_MS).toBe(60_000);
    expect(DEFAULT_SHOPIFY_READ_TIMEOUT_MS).toBe(2_500);
    expect(DEFAULT_SHOPIFY_READ_MAX_ENTRIES).toBe(500);
  });
});

describe("TTL", () => {
  it("reuses a resolved value within the TTL and re-reads after it", async () => {
    let calls = 0;
    let nowMs = 1_000;
    const cache = new CoalescingTtlCache<number>({ ttlMs: 1_000, now: () => nowMs });
    const load = async () => {
      calls += 1;
      return calls;
    };

    expect(await cache.read("k", load)).toBe(1);
    expect(await cache.read("k", load)).toBe(1);
    expect(calls).toBe(1);

    nowMs += 1_001;
    expect(await cache.read("k", load)).toBe(2);
    expect(calls).toBe(2);
  });

  it("keys separately, so one key never serves another's value", async () => {
    const cache = new CoalescingTtlCache<string>();
    expect(await cache.read("a", async () => "value-a")).toBe("value-a");
    expect(await cache.read("b", async () => "value-b")).toBe("value-b");
  });

  it("dates an entry from when the read STARTED, not when it finished", async () => {
    // A slow read must not extend its own freshness: the data it holds was
    // fetched as of the start of the read.
    let nowMs = 0;
    const cache = new CoalescingTtlCache<number>({ ttlMs: 100, now: () => nowMs });
    let calls = 0;
    await cache.read("k", async () => {
      nowMs = 90; // the read itself took 90ms
      calls += 1;
      return calls;
    });
    nowMs = 100; // 100ms after the read STARTED — expired
    await cache.read("k", async () => {
      calls += 1;
      return calls;
    });
    expect(calls).toBe(2);
  });
});

describe("in-flight coalescing (§7.6 — two consumers, one Shopify read)", () => {
  it("collapses concurrent reads of the same key into ONE underlying call", async () => {
    let calls = 0;
    let release: (value: number) => void = () => {};
    const cache = new CoalescingTtlCache<number>();
    const load = () => {
      calls += 1;
      return new Promise<number>((resolve) => {
        release = resolve;
      });
    };

    const first = cache.read("k", load);
    const second = cache.read("k", load);
    release(7);

    expect(await first).toBe(7);
    expect(await second).toBe(7);
    expect(calls).toBe(1);
  });

  it("does not coalesce across different keys", async () => {
    let calls = 0;
    const cache = new CoalescingTtlCache<number>();
    const load = async () => {
      calls += 1;
      return calls;
    };
    await Promise.all([cache.read("a", load), cache.read("b", load)]);
    expect(calls).toBe(2);
  });
});

describe("a failure is never cached", () => {
  it("rejects rather than substituting a value, so the caller owns the policy", async () => {
    const cache = new CoalescingTtlCache<number>();
    await expect(
      cache.read("k", async () => {
        throw new Error("Shopify unavailable");
      }),
    ).rejects.toThrow("Shopify unavailable");
  });

  it("retries on the next read instead of pinning the failure for the TTL", async () => {
    let calls = 0;
    const cache = new CoalescingTtlCache<number>();
    const load = async () => {
      calls += 1;
      if (calls === 1) throw new Error("transient");
      return calls;
    };
    await expect(cache.read("k", load)).rejects.toThrow("transient");
    expect(await cache.read("k", load)).toBe(2);
  });

  it("holds nothing after a failure", async () => {
    const cache = new CoalescingTtlCache<number>();
    await expect(
      cache.read("k", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow();
    expect(cache.size).toBe(0);
  });

  it("shares one rejection with every coalesced caller", async () => {
    let calls = 0;
    const cache = new CoalescingTtlCache<number>();
    const load = () => {
      calls += 1;
      return Promise.reject(new Error("shared failure"));
    };
    const results = await Promise.allSettled([cache.read("k", load), cache.read("k", load)]);
    expect(results.every((r) => r.status === "rejected")).toBe(true);
    expect(calls).toBe(1);
  });

  it("reports a coalesced failure ONCE, not once per caller", async () => {
    // The reason `onFailure` belongs to the mechanism: a caller-side catch runs
    // per caller and would report one upstream failure N times.
    const onFailure = vi.fn();
    const cache = new CoalescingTtlCache<number>({ onFailure });
    const load = () => Promise.reject(new Error("one failure"));
    await Promise.allSettled([cache.read("k", load), cache.read("k", load)]);
    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(onFailure.mock.calls[0]?.[1]).toBe("k");
  });
});

describe("the hard timeout", () => {
  it("rejects with a typed error a caller can map to 502 without matching on text", async () => {
    const cache = new CoalescingTtlCache<number>({ timeoutMs: 5 });
    const pending = cache.read("k", () => new Promise<number>(() => {}));
    await expect(pending).rejects.toBeInstanceOf(ShopifyReadTimeoutError);
  });

  it("names the kind of read and the budget, and carries no key", async () => {
    const cache = new CoalescingTtlCache<number>({ timeoutMs: 5, label: "orders list read" });
    await cache.read("customer-1", () => new Promise<number>(() => {})).catch((err: unknown) => {
      const error = err as ShopifyReadTimeoutError;
      expect(error.message).toBe("orders list read exceeded 5ms");
      expect(error.timeoutMs).toBe(5);
      // §24.3 forbids logging a customer id, and an error message is a log line
      // waiting to happen.
      expect(error.message).not.toContain("customer-1");
    });
  });

  it("does not cache a timed-out read", async () => {
    let calls = 0;
    const cache = new CoalescingTtlCache<number>({ timeoutMs: 5 });
    await cache
      .read("k", () => {
        calls += 1;
        return new Promise<number>(() => {});
      })
      .catch(() => undefined);
    expect(await cache.read("k", async () => 42)).toBe(42);
    expect(calls).toBe(1);
    expect(cache.size).toBe(1);
  });
});

describe("the cache is bounded", () => {
  it("evicts oldest-first so it cannot grow without bound", async () => {
    let calls = 0;
    const cache = new CoalescingTtlCache<number>({ maxEntries: 2 });
    const load = async () => {
      calls += 1;
      return calls;
    };
    for (const key of ["a", "b", "c", "a"]) {
      await cache.read(key, load);
    }
    // `a` was evicted when `c` arrived, so the fourth read called through.
    expect(calls).toBe(4);
    expect(cache.size).toBe(2);
  });
});
