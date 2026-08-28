// @vitest-environment jsdom
/**
 * Spec task 20.4 — the cart boundary.
 *
 * Validates Requirements 6.6, 6.7, 14.2, 16.3, 16.5.
 *
 * ── WHY THE CART GETS ITS OWN TEST FILE ──────────────────────────────────────
 * `/cart/add.js` is the only place the portal mutates anything outside its own API,
 * and it has no idempotency key — Shopify's endpoint has no notion of one. So the
 * duplicate-submission guard is not a nicety, it is the only thing standing between
 * a double tap and a customer discovering doubled quantities at checkout. That
 * deserves assertions of its own rather than being incidental to a section test.
 *
 * SAFETY: `fetch` is stubbed throughout. No network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  addToCart,
  isAdding,
  resetCart,
} from "../../../theme-src/portal/transport/cartClient.js";

interface Call {
  readonly url: string;
  readonly init: RequestInit;
}

let calls: Call[] = [];

function stub(answer: { status: number } | "network" | "hang" | { defer: true }): {
  resolve: () => void;
} {
  // The deferred is created HERE, not inside the mock: `stub()` returns before
  // `fetch` is ever called, so a resolver assigned inside the mock would still be
  // undefined at the call site and the promise would never settle.
  let release: () => void = () => undefined;
  const deferred = new Promise<Response>((res) => {
    release = () =>
      res({ ok: true, status: 200, json: () => Promise.resolve({}) } as unknown as Response);
  });
  globalThis.fetch = vi.fn((url: unknown, init?: unknown) => {
    calls.push({ url: String(url), init: (init ?? {}) as RequestInit });
    if (answer === "network") return Promise.reject(new TypeError("Failed to fetch"));
    if (answer === "hang") {
      return new Promise<Response>((_res, rej) => {
        (init as RequestInit | undefined)?.signal?.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          rej(error);
        });
      });
    }
    if (typeof answer === "object" && "defer" in answer) {
      return deferred;
    }
    const status = (answer as { status: number }).status;
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve({ description: "Amber Nuit — only 0 left in stock" }),
    } as unknown as Response);
  }) as unknown as typeof fetch;
  return { resolve: () => release() };
}

const LINE = { variantId: "9001", quantity: 1 };

beforeEach(() => {
  calls = [];
  resetCart();
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("the cart request", () => {
  it("posts to /cart/add.js and nowhere else (task 20.4)", async () => {
    stub({ status: 200 });
    await addToCart("reorder:1", [LINE]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("/cart/add.js");
    // Relative and same-origin: the cart belongs to the storefront session, and our
    // own service has no business writing it (§6.3 N3).
    expect(calls[0]?.url).not.toMatch(/^https?:/);
    expect(calls[0]?.url).not.toContain("onrender.com");
    expect(calls[0]?.url).not.toContain("/apps/loyalty");
  });

  it("sends Shopify's expected shape, with NUMERIC variant ids", async () => {
    stub({ status: 200 });
    await addToCart("reorder:1", [
      { variantId: "9001", quantity: 2 },
      // A GID, because the Admin API uses that shape everywhere else.
      { variantId: "gid://shopify/ProductVariant/9002", quantity: 1 },
    ]);
    const body = JSON.parse(String(calls[0]?.init.body)) as { items: { id: number; quantity: number }[] };
    expect(body.items).toEqual([
      { id: 9001, quantity: 2 },
      { id: 9002, quantity: 1 },
    ]);
    expect((calls[0]?.init.headers as Record<string, string>)["content-type"]).toBe("application/json");
  });

  it("fails closed on a variant reference with no digits", async () => {
    stub({ status: 422 });
    const result = await addToCart("reorder:1", [{ variantId: "not-an-id", quantity: 1 }]);
    const body = JSON.parse(String(calls[0]?.init.body)) as { items: { id: number }[] };
    // `0` is rejected by Shopify — a guess would be worse than a refusal.
    expect(body.items[0]?.id).toBe(0);
    expect(result.ok).toBe(false);
  });

  it("sends no customer identity of our own", async () => {
    stub({ status: 200 });
    await addToCart("reorder:1", [LINE]);
    const serialised = JSON.stringify(calls[0]).toLowerCase();
    for (const forbidden of ["authorization", "customer_id", "customerid", "email", "logged_in", "shpat_"]) {
      expect(serialised, `sent ${forbidden}`).not.toContain(forbidden);
    }
    // Shopify identifies the cart by its own session cookie, which is why this is
    // required and is not a credential of ours.
    expect(calls[0]?.init.credentials).toBe("same-origin");
  });
});

describe("the duplicate-submission guard (Requirement 16.5)", () => {
  it("refuses a second call with the same key while the first is outstanding", async () => {
    const { resolve } = stub({ defer: true });
    const first = addToCart("reorder:1", [LINE]);
    expect(isAdding("reorder:1")).toBe(true);

    const second = await addToCart("reorder:1", [LINE]);
    // Refused, not queued: queueing would preserve the duplicate, only later.
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe("cart_unavailable");
    expect(calls).toHaveLength(1);

    resolve();
    await first;
    expect(isAdding("reorder:1")).toBe(false);
  });

  it("does NOT block a different intent", async () => {
    const { resolve } = stub({ defer: true });
    const first = addToCart("reorder:1", [LINE]);
    // Buy Again on another line must not be blocked by a Reorder in flight.
    expect(isAdding("buy-again:1:222")).toBe(false);
    resolve();
    await first;
  });

  it("releases the guard after a failure, so a retry is possible", async () => {
    stub("network");
    const result = await addToCart("reorder:1", [LINE]);
    expect(result.ok).toBe(false);
    expect(isAdding("reorder:1")).toBe(false);

    stub({ status: 200 });
    const second = await addToCart("reorder:1", [LINE]);
    expect(second.ok).toBe(true);
  });
});

describe("failures never carry upstream text (design E.1 rule 2)", () => {
  it("maps a 422 to `unavailable` and drops Shopify's description", async () => {
    stub({ status: 422 });
    const result = await addToCart("reorder:1", [LINE]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("unavailable");
    // Shopify's 422 names the product and the available quantity. `ui/copy.ts` owns
    // the wording, so that text must not travel.
    expect(JSON.stringify(result)).not.toContain("only 0 left");
    expect(JSON.stringify(result)).not.toContain("Amber Nuit");
  });

  it("distinguishes a network failure from a timeout", async () => {
    stub("network");
    const network = await addToCart("a", [LINE]);
    expect(network.ok).toBe(false);
    if (!network.ok) expect(network.reason).toBe("network_unavailable");

    vi.useFakeTimers();
    stub("hang");
    const pending = addToCart("b", [LINE]);
    await vi.advanceTimersByTimeAsync(8_000);
    const timedOut = await pending;
    expect(timedOut.ok).toBe(false);
    if (!timedOut.ok) expect(timedOut.reason).toBe("request_timeout");
    vi.useRealTimers();
  });

  it("maps any other non-2xx to `cart_unavailable`", async () => {
    stub({ status: 500 });
    const result = await addToCart("reorder:1", [LINE]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("cart_unavailable");
  });

  it("refuses an empty line list without calling Shopify at all", async () => {
    stub({ status: 200 });
    const result = await addToCart("reorder:1", []);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("nothing_to_add");
    // There was nothing purchasable in the plan; the caller states the reasons.
    expect(calls).toHaveLength(0);
  });

  it("the cart gets no cold-start allowance — 8 s, not 60", async () => {
    vi.useFakeTimers();
    stub("hang");
    const pending = addToCart("reorder:1", [LINE]);
    await vi.advanceTimersByTimeAsync(7_999);
    // Still outstanding.
    expect(isAdding("reorder:1")).toBe(true);
    await vi.advanceTimersByTimeAsync(2);
    const result = await pending;
    expect(result.ok).toBe(false);
    vi.useRealTimers();
  });
});
