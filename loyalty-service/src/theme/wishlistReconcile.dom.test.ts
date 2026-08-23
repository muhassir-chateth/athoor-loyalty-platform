// @vitest-environment jsdom
/**
 * Wishlist storage normalisation + handle resolution + reconciliation trigger —
 * behavioural jsdom tests (spec task 1.5, originally task 43).
 *
 * WHY THIS FILE WAS REWRITTEN
 * --------------------------
 * The previous version of this suite ENCODED BOTH PRODUCTION DEFECTS, which is
 * why CI stayed green while wishlist convergence was dead (design §8.1):
 *
 *   - it seeded `localStorage` with `JSON.stringify([...])` — a format NO
 *     production surface writes. `dt_wishlist.js` `setWishlist`,
 *     `templates/page.wishlist.liquid` and `snippets/athoor-wishlist-drawer.liquid`
 *     all store a COMMA-DELIMITED string of handles. Seeding JSON meant W1 (the
 *     `JSON.parse` that throws on `"a,b"`) could never be observed here;
 *   - it typed the captured body as `{ productIds: string[] }` and asserted
 *     `body.productIds`, with `fetch` stubbed — so the server's `zod` schema was
 *     never involved and W2 (the `{ productIds }` vs `{ deviceLocal }` mismatch)
 *     was equally invisible.
 *
 * Both are corrected. Seeding now uses the CSV format production writes, and the
 * captured body is typed with the SHARED {@link WishlistReconcileRequest} type
 * imported from the server-side contract module — so if either side renames the
 * field again, this file stops compiling.
 *
 * This suite still owns the CLIENT side. The genuine cross-boundary regression
 * test (client serialisation → real `zod` schema → real handler via
 * `app.inject`) is `src/profile/wishlistReconcileContract.boundary.test.ts`.
 *
 * WHAT IS UNDER TEST
 * ------------------
 *   1. `normaliseDeviceWishlist` — CSV, JSON array, empty, absent, malformed,
 *      whitespace, duplicates. Asserted BOTH directly against the shipped
 *      function (via the test hook) AND behaviourally, through the ordered set
 *      of `/products/{handle}.js` requests the real script actually issues.
 *   2. Handle → id translation via `/products/{handle}.js`, keeping the existing
 *      three-way `resolved` / `missing` / `environmental` classification intact.
 *   3. Exactly one `POST /v1/profile/wishlist/reconcile` per authenticated load,
 *      carrying `{ deviceLocal }` and only resolved numeric ids.
 *   4. `localStorage` is NEVER mutated — byte-identical before and after, in
 *      every scenario including a successful merge.
 *   5. The privacy-safe diagnostic taxonomy: failures are reported by stable
 *      code and counts, and NEVER carry a handle, an id or a payload.
 *
 * WHY JSDOM, NOT STAGING
 * ----------------------
 * The staging storefront is password-protected, so the reconcile endpoint cannot
 * be called from a browser session in CI. This file drives
 * `theme/assets/athoor-loyalty.js` read from disk, so a change to the shipped
 * script is caught here immediately.
 *
 * Validates: Requirements 7.1, 7.8, 17.2, 17.3, 17.4, 26.7
 */
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WishlistReconcileRequest } from "../profile/wishlistReconcileContract.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const THEME_DIR = join(__dirname, "..", "..", "..", "theme");
const SCRIPT_PATH = join(THEME_DIR, "assets", "athoor-loyalty.js");
const SCRIPT_SOURCE = readFileSync(SCRIPT_PATH, "utf8");

/** The storage key every production wishlist surface reads and writes. */
const STORAGE_KEY = "shopify-wishlist";

/**
 * Serialises handles the way production does — `array.join(',')`. Used instead of
 * `JSON.stringify` throughout, because seeding JSON is precisely what hid W1.
 */
function productionFormat(handles: string[]): string {
  return handles.join(",");
}

// ---------------------------------------------------------------------------
// DOM fixture
// ---------------------------------------------------------------------------

/** Minimal dashboard that satisfies the script's guard conditions. */
function fixture(): string {
  return `
<div class="loyalty-dashboard"
     data-loyalty-dashboard
     data-loyalty-customer="true"
     data-loyalty-proxy-base="/apps/loyalty">
  <script type="application/json" data-loyalty-config>
    {"proxyBase":"/apps/loyalty","loggedIn":true,"customerId":123,"currency":"GBP","timeoutMs":3000,"cacheAvailable":true}
  </script>
  <script type="application/json" data-loyalty-strings>{}</script>
  <div data-loyalty="error-state" hidden></div>
  <span data-loyalty="referral-code" data-loyalty-code-pending="true"></span>
  <button data-loyalty="referral-copy" disabled></button>
  <form data-loyalty="referral-claim" hidden novalidate>
    <input data-loyalty="referral-claim-input" />
    <button type="submit" data-loyalty="referral-claim-submit"></button>
    <p data-loyalty="referral-claim-status" role="status" aria-live="polite"></p>
  </form>
</div>`;
}

// ---------------------------------------------------------------------------
// Fetch-stub helpers — mirror the real storefront responses documented in
// docs/ops/wishlist-handle-resolution-evidence.md
// ---------------------------------------------------------------------------

type FetchHandler = (url: string, init?: RequestInit) => Promise<Response>;

/** A fully resolved, non-redirected product.js response with a numeric id. */
function productResponse(id: number, handle: string): Response {
  const body = JSON.stringify({ id, handle, title: "Test Product" });
  return {
    ok: true,
    status: 200,
    redirected: false,
    url: `/products/${handle}.js`,
    headers: { get: (h: string) => (h === "content-type" ? "text/javascript; charset=utf-8" : null) },
    text: () => Promise.resolve(body),
  } as unknown as Response;
}

/** 404 with empty body — identical for nonexistent / archived / draft. */
function notFoundResponse(handle: string): Response {
  return {
    ok: false,
    status: 404,
    redirected: false,
    url: `/products/${handle}.js`,
    headers: { get: () => "text/javascript; charset=utf-8" },
    text: () => Promise.resolve(""),
  } as unknown as Response;
}

/** Password-gate redirect: 200 after redirect to /password, HTML body. */
function passwordGateResponse(_handle: string): Response {
  return {
    ok: true,
    status: 200,
    redirected: true,
    url: `https://athoor-loyalty-staging.myshopify.com/password`,
    headers: { get: (h: string) => (h === "content-type" ? "text/html; charset=utf-8" : null) },
    text: () => Promise.resolve("<!DOCTYPE html><html><body>Password</body></html>"),
  } as unknown as Response;
}

/** 5xx / 429 server error. */
function serverErrorResponse(status: number, handle: string): Response {
  return {
    ok: false,
    status,
    redirected: false,
    url: `/products/${handle}.js`,
    headers: { get: () => null },
    text: () => Promise.resolve(""),
  } as unknown as Response;
}

/** 200 response whose body is HTML (soft-404 themed page). */
function htmlBodyResponse(handle: string): Response {
  return {
    ok: true,
    status: 200,
    redirected: false,
    url: `/products/${handle}.js`,
    headers: { get: (h: string) => (h === "content-type" ? "text/html; charset=utf-8" : null) },
    text: () => Promise.resolve("<!DOCTYPE html><html></html>"),
  } as unknown as Response;
}

/** 200 response with completely empty body. */
function emptyBodyResponse(handle: string): Response {
  return {
    ok: true,
    status: 200,
    redirected: false,
    url: `/products/${handle}.js`,
    headers: { get: (h: string) => (h === "content-type" ? "text/javascript" : null) },
    text: () => Promise.resolve(""),
  } as unknown as Response;
}

/** 200 response whose body is malformed JSON. */
function malformedJsonResponse(handle: string): Response {
  return {
    ok: true,
    status: 200,
    redirected: false,
    url: `/products/${handle}.js`,
    headers: { get: (h: string) => (h === "content-type" ? "text/javascript" : null) },
    text: () => Promise.resolve("{not json"),
  } as unknown as Response;
}

/** 200 JSON body but no `id` field. */
function missingIdResponse(handle: string): Response {
  return {
    ok: true,
    status: 200,
    redirected: false,
    url: `/products/${handle}.js`,
    headers: { get: (h: string) => (h === "content-type" ? "text/javascript" : null) },
    text: () => Promise.resolve(JSON.stringify({ title: "Oops" })),
  } as unknown as Response;
}

/** A JSON error response for the reconcile POST, so `postJson` can read `error`. */
function reconcileErrorResponse(status: number, errorCode: string): Response {
  return {
    ok: false,
    status,
    json: () => Promise.resolve({ error: errorCode, message: "nope" }),
  } as unknown as Response;
}

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

/**
 * The captured reconcile POST. `body` uses the SHARED contract type, so a
 * client/server field divergence becomes a compile error here.
 */
type ReconcileCall = { url: string; body: WishlistReconcileRequest; init: RequestInit };

/** Diagnostic lines the script emitted via console.warn. */
type DiagLine = { code: string; section: string } & Record<string, unknown>;

/** The test-only hook surface the shipped script populates when it is present. */
interface TestHooks {
  normaliseDeviceWishlist?: (raw: unknown) => string[];
  classifyReconcileFailure?: (err: unknown) => string;
  WISHLIST_DIAG?: Record<string, string>;
}

interface BootOpts {
  /** Handles to seed, serialised in the PRODUCTION comma-delimited format. */
  wishlist?: string[];
  /** Raw `shopify-wishlist` value, seeded verbatim. Use for malformed/legacy cases. */
  wishlistRaw?: string;
  /** Override the handle-resolution fetch stub. */
  fetchStub?: FetchHandler;
  /** Override the reconcile POST response. Default: 200. */
  reconcileResponse?: Response;
  /** Reject the reconcile POST with this error (network failure / timeout). */
  reconcileReject?: Error;
}

interface BootResult {
  reconcileCalls: ReconcileCall[];
  /** Every `/products/{handle}.js` URL requested, in request order. */
  resolutionRequests: string[];
  /** The handles requested, in order — the observable output of the normaliser. */
  requestedHandles: string[];
  diagnostics: DiagLine[];
  hooks: TestHooks;
}

/**
 * Sets up localStorage, installs the test hook and the fetch stub, renders the
 * fixture, and executes the SHIPPED script. Returns everything observable.
 */
async function boot(opts: BootOpts = {}): Promise<BootResult> {
  const reconcileCalls: ReconcileCall[] = [];
  const resolutionRequests: string[] = [];
  const diagnostics: DiagLine[] = [];

  if (opts.wishlistRaw !== undefined) {
    localStorage.setItem(STORAGE_KEY, opts.wishlistRaw);
  } else if (opts.wishlist !== undefined) {
    localStorage.setItem(STORAGE_KEY, productionFormat(opts.wishlist));
  }

  // Installed BEFORE the script runs — the script only populates it if present.
  const hooks: TestHooks = {};
  (window as unknown as { __athoorLoyaltyTestHooks: TestHooks }).__athoorLoyaltyTestHooks = hooks;

  vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
    const payload = args[1];
    if (payload && typeof payload === "object" && "code" in (payload as object)) {
      diagnostics.push(payload as DiagLine);
    }
  });

  const fetchHandler: FetchHandler = opts.fetchStub ?? (() => Promise.reject(new TypeError("unexpected fetch")));

  const fetchMock = vi.fn((url: string, init: RequestInit = {}) => {
    if (
      url.includes("/v1/profile/wishlist/reconcile") &&
      (init.method ?? "GET").toUpperCase() === "POST"
    ) {
      const body = JSON.parse(init.body as string) as WishlistReconcileRequest;
      reconcileCalls.push({ url, body, init });
      if (opts.reconcileReject) return Promise.reject(opts.reconcileReject);
      if (opts.reconcileResponse) return Promise.resolve(opts.reconcileResponse);
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ wishlist: body.deviceLocal }),
      } as unknown as Response);
    }

    // Dashboard reads required for the script to run normally.
    if (url.includes("/v1/balance")) {
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ spendableBalance: 0, tier: "bronze" }) } as unknown as Response);
    }
    if (url.includes("/v1/history")) {
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ entries: [] }) } as unknown as Response);
    }
    if (url.includes("/v1/referral") && (init.method ?? "GET").toUpperCase() === "GET") {
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ referralCode: "X", wasReferred: true }) } as unknown as Response);
    }
    if (url.includes("/v1/profile/visit")) {
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ firstVisit: false }) } as unknown as Response);
    }

    if (url.startsWith("/products/")) resolutionRequests.push(url);
    return fetchHandler(url, init);
  });

  (window as unknown as { fetch: unknown }).fetch = fetchMock;
  document.body.innerHTML = fixture();
  new Function(SCRIPT_SOURCE)();
  await flush();

  const requestedHandles = resolutionRequests.map((u) =>
    decodeURIComponent(u.replace(/^\/products\//, "").replace(/\.js$/, "")),
  );

  return { reconcileCalls, resolutionRequests, requestedHandles, diagnostics, hooks };
}

/** Drain the microtask / macrotask queues so all fetch chains settle. */
async function flush(times = 12): Promise<void> {
  for (let i = 0; i < times; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

/** Resolves the named handles to the given ids; everything else 404s. */
function resolveOnly(map: Record<string, number>): FetchHandler {
  return (url) => {
    for (const [handle, id] of Object.entries(map)) {
      if (url === `/products/${encodeURIComponent(handle)}.js`) {
        return Promise.resolve(productResponse(id, handle));
      }
    }
    const handle = url.replace(/^\/products\//, "").replace(/\.js$/, "");
    return Promise.resolve(notFoundResponse(handle));
  };
}

beforeEach(() => {
  localStorage.clear();
  document.body.innerHTML = "";
});

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = "";
  localStorage.clear();
  delete (window as unknown as { __athoorLoyaltyTestHooks?: TestHooks }).__athoorLoyaltyTestHooks;
});

// ---------------------------------------------------------------------------
// 1. Storage normalisation — W1
// ---------------------------------------------------------------------------

describe("W1 — storage normalisation, direct against the shipped function", () => {
  /** The shipped `normaliseDeviceWishlist`, obtained via the test hook. */
  async function normaliser(): Promise<(raw: unknown) => string[]> {
    const { hooks } = await boot({});
    expect(hooks.normaliseDeviceWishlist, "test hook was not populated by the shipped script").toBeTypeOf(
      "function",
    );
    return hooks.normaliseDeviceWishlist!;
  }

  it("parses the comma-delimited format every production surface writes", async () => {
    const normalise = await normaliser();
    expect(normalise("oud-royale,amber-nuit")).toEqual(["oud-royale", "amber-nuit"]);
    expect(normalise("single-handle")).toEqual(["single-handle"]);
  });

  it("parses a JSON array too (backward compatibility for a stray legacy value)", async () => {
    const normalise = await normaliser();
    expect(normalise(JSON.stringify(["oud-royale", "amber-nuit"]))).toEqual([
      "oud-royale",
      "amber-nuit",
    ]);
  });

  it("returns [] for an empty string, whitespace, a missing value and a non-string", async () => {
    const normalise = await normaliser();
    expect(normalise("")).toEqual([]);
    expect(normalise("   ")).toEqual([]);
    expect(normalise(null)).toEqual([]);
    expect(normalise(undefined)).toEqual([]);
    expect(normalise(42)).toEqual([]);
    expect(normalise(["already", "an", "array"])).toEqual([]);
  });

  it("never throws on malformed JSON-like input, and recovers what it can", async () => {
    const normalise = await normaliser();
    // The exact case that made W1 fatal in reverse: looks like JSON, is not.
    expect(() => normalise("[oops")).not.toThrow();
    expect(normalise("[oops")).toEqual(["[oops"]);
    expect(() => normalise("{not json")).not.toThrow();
    expect(normalise('{"handle":"oops"}')).toEqual(['{"handle":"oops"}']);
    expect(normalise("[")).toEqual(["["]);
  });

  it("trims surrounding and interior whitespace and drops empty segments", async () => {
    const normalise = await normaliser();
    expect(normalise("  oud-royale , amber-nuit  ")).toEqual(["oud-royale", "amber-nuit"]);
    expect(normalise(",,oud-royale,,,amber-nuit,")).toEqual(["oud-royale", "amber-nuit"]);
    expect(normalise(",,,")).toEqual([]);
  });

  it("deduplicates while preserving first-occurrence order (stable and deterministic)", async () => {
    const normalise = await normaliser();
    expect(normalise("b,a,b,c,a")).toEqual(["b", "a", "c"]);
    expect(normalise(" dup , dup ")).toEqual(["dup"]);
    expect(normalise(JSON.stringify(["z", "y", "z"]))).toEqual(["z", "y"]);
    // Determinism: the same input yields the identical array every time.
    expect(normalise("b,a,c")).toEqual(normalise("b,a,c"));
  });

  it("skips non-string entries inside a JSON array rather than coercing them", async () => {
    const normalise = await normaliser();
    // `null` must not become the string "null" and trigger /products/null.js.
    expect(normalise(JSON.stringify(["good", null, "also-good"]))).toEqual(["good", "also-good"]);
    expect(normalise(JSON.stringify([{ handle: "x" }, "kept"]))).toEqual(["kept"]);
  });
});

describe("W1 — storage normalisation, observed through the real client path", () => {
  it("issues one resolution request per canonical handle for the production CSV format", async () => {
    const { requestedHandles } = await boot({
      wishlistRaw: "oud-royale,amber-nuit",
      fetchStub: resolveOnly({ "oud-royale": 111, "amber-nuit": 222 }),
    });
    expect(requestedHandles).toEqual(["oud-royale", "amber-nuit"]);
  });

  it("reconciles CSV handles — the format W1 could never get past JSON.parse", async () => {
    const { reconcileCalls } = await boot({
      wishlistRaw: "oud-royale,amber-nuit",
      fetchStub: resolveOnly({ "oud-royale": 111, "amber-nuit": 222 }),
    });
    expect(reconcileCalls).toHaveLength(1);
    expect(reconcileCalls[0]!.body.deviceLocal).toEqual(["111", "222"]);
  });

  it("still reconciles a legacy JSON-array value", async () => {
    const { reconcileCalls } = await boot({
      wishlistRaw: JSON.stringify(["legacy-a", "legacy-b"]),
      fetchStub: resolveOnly({ "legacy-a": 301, "legacy-b": 302 }),
    });
    expect(reconcileCalls).toHaveLength(1);
    expect(reconcileCalls[0]!.body.deviceLocal).toEqual(["301", "302"]);
  });

  it("requests each duplicate handle only once and sends one id", async () => {
    const { requestedHandles, reconcileCalls } = await boot({
      wishlistRaw: "dup,dup,dup",
      fetchStub: resolveOnly({ dup: 77 }),
    });
    expect(requestedHandles).toEqual(["dup"]);
    expect(reconcileCalls[0]!.body.deviceLocal).toEqual(["77"]);
  });

  it("ignores whitespace and empty segments when building the request set", async () => {
    const { requestedHandles, reconcileCalls } = await boot({
      wishlistRaw: " , oud-royale , , amber-nuit ,",
      fetchStub: resolveOnly({ "oud-royale": 401, "amber-nuit": 402 }),
    });
    expect(requestedHandles).toEqual(["oud-royale", "amber-nuit"]);
    expect(reconcileCalls[0]!.body.deviceLocal).toEqual(["401", "402"]);
  });

  it("issues no resolution request and no POST for an empty string", async () => {
    const { requestedHandles, reconcileCalls } = await boot({ wishlistRaw: "" });
    expect(requestedHandles).toEqual([]);
    expect(reconcileCalls).toHaveLength(0);
  });

  it("issues no resolution request and no POST when the key is absent", async () => {
    const { requestedHandles, reconcileCalls } = await boot({});
    expect(requestedHandles).toEqual([]);
    expect(reconcileCalls).toHaveLength(0);
  });

  it("does not throw on malformed JSON-like input, and never crashes the dashboard", async () => {
    const { reconcileCalls } = await boot({
      wishlistRaw: "[oops",
      fetchStub: () => Promise.resolve(notFoundResponse("x")),
    });
    // "[oops" is treated as a single handle, resolves 404, so nothing is sent.
    expect(reconcileCalls).toHaveLength(0);
    expect(document.querySelector("[data-loyalty-dashboard]")).not.toBeNull();
  });

  it("sends one valid handle when the list mixes a valid and an unresolvable one", async () => {
    const { reconcileCalls } = await boot({
      wishlist: ["live-handle", "dead-handle"],
      fetchStub: resolveOnly({ "live-handle": 9999 }),
    });
    expect(reconcileCalls).toHaveLength(1);
    expect(reconcileCalls[0]!.body.deviceLocal).toEqual(["9999"]);
  });
});

// ---------------------------------------------------------------------------
// 2. localStorage is NEVER mutated — read-only reconciliation
// ---------------------------------------------------------------------------

describe("localStorage contract: reconciliation is read-only", () => {
  it("leaves storage byte-identical after a SUCCESSFUL merge", async () => {
    const original = productionFormat(["snowboard-handle"]);
    const { reconcileCalls } = await boot({
      wishlistRaw: original,
      fetchStub: resolveOnly({ "snowboard-handle": 8888001 }),
    });
    // The merge really did happen...
    expect(reconcileCalls).toHaveLength(1);
    // ...and storage is untouched all the same. Deliberate deviation from design
    // §8.4 rule 3 per owner instruction; clearing awaits a separate migration.
    expect(localStorage.getItem(STORAGE_KEY)).toBe(original);
  });

  it("leaves storage byte-identical when every handle resolved", async () => {
    const original = productionFormat(["a-handle", "b-handle"]);
    await boot({ wishlistRaw: original, fetchStub: resolveOnly({ "a-handle": 1, "b-handle": 2 }) });
    expect(localStorage.getItem(STORAGE_KEY)).toBe(original);
  });

  it("leaves storage byte-identical when handles are missing (404)", async () => {
    const original = productionFormat(["gone-handle"]);
    await boot({ wishlistRaw: original, fetchStub: resolveOnly({}) });
    expect(localStorage.getItem(STORAGE_KEY)).toBe(original);
  });

  it("leaves storage byte-identical on an environmental failure (password gate)", async () => {
    const original = productionFormat(["some-handle"]);
    await boot({
      wishlistRaw: original,
      fetchStub: () => Promise.resolve(passwordGateResponse("some-handle")),
    });
    expect(localStorage.getItem(STORAGE_KEY)).toBe(original);
  });

  it("leaves storage byte-identical on a network error", async () => {
    const original = productionFormat(["net-error-handle"]);
    await boot({ wishlistRaw: original, fetchStub: () => Promise.reject(new TypeError("Failed to fetch")) });
    expect(localStorage.getItem(STORAGE_KEY)).toBe(original);
  });

  it("leaves storage byte-identical for a mixed bag of outcomes", async () => {
    const original = productionFormat(["resolved-h", "missing-h", "env-h"]);
    await boot({
      wishlistRaw: original,
      fetchStub: (url) => {
        if (url.includes("/products/resolved-h.js")) return Promise.resolve(productResponse(111, "resolved-h"));
        if (url.includes("/products/missing-h.js")) return Promise.resolve(notFoundResponse("missing-h"));
        if (url.includes("/products/env-h.js")) return Promise.resolve(passwordGateResponse("env-h"));
        return Promise.reject(new TypeError("unexpected: " + url));
      },
    });
    expect(localStorage.getItem(STORAGE_KEY)).toBe(original);
  });

  it("does not NORMALISE storage in place — a messy value stays messy", async () => {
    const messy = " ,oud-royale, ,oud-royale,amber-nuit,";
    await boot({ wishlistRaw: messy, fetchStub: resolveOnly({ "oud-royale": 1, "amber-nuit": 2 }) });
    expect(localStorage.getItem(STORAGE_KEY)).toBe(messy);
  });

  it("leaves storage byte-identical when the value is malformed", async () => {
    const original = "[oops";
    await boot({ wishlistRaw: original, fetchStub: resolveOnly({}) });
    expect(localStorage.getItem(STORAGE_KEY)).toBe(original);
  });

  it("leaves the key absent when it was absent", async () => {
    await boot({});
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("writes no other storage key either", async () => {
    await boot({ wishlist: ["h"], fetchStub: resolveOnly({ h: 1 }) });
    expect(localStorage.length).toBe(1);
    expect(localStorage.key(0)).toBe(STORAGE_KEY);
  });
});

// ---------------------------------------------------------------------------
// 3. Handle resolution outcomes — the three-way classification is unchanged
// ---------------------------------------------------------------------------

describe("handle resolution: resolved outcome", () => {
  it("extracts the numeric id from a 200 product.js response", async () => {
    const { reconcileCalls } = await boot({
      wishlist: ["athoor-oud"],
      fetchStub: resolveOnly({ "athoor-oud": 7654321 }),
    });
    expect(reconcileCalls).toHaveLength(1);
    expect(reconcileCalls[0]!.body.deviceLocal).toEqual(["7654321"]);
  });

  it("resolves multiple handles and sends all numeric ids", async () => {
    const { reconcileCalls } = await boot({
      wishlist: ["handle-a", "handle-b"],
      fetchStub: resolveOnly({ "handle-a": 1001, "handle-b": 1002 }),
    });
    expect(reconcileCalls).toHaveLength(1);
    expect([...reconcileCalls[0]!.body.deviceLocal].sort()).toEqual(["1001", "1002"]);
  });
});

describe("handle resolution: missing outcome (404)", () => {
  it("does NOT include a 404 handle in the reconcile payload", async () => {
    const { reconcileCalls } = await boot({ wishlist: ["dead-handle"], fetchStub: resolveOnly({}) });
    expect(reconcileCalls).toHaveLength(0);
  });

  it("excludes only missing handles, includes the resolved ones", async () => {
    const { reconcileCalls } = await boot({
      wishlist: ["live-handle", "dead-handle"],
      fetchStub: resolveOnly({ "live-handle": 9999 }),
    });
    expect(reconcileCalls).toHaveLength(1);
    expect(reconcileCalls[0]!.body.deviceLocal).toEqual(["9999"]);
  });
});

describe("handle resolution: environmental outcome — excluded, never pruned", () => {
  const cases: Array<[string, (handle: string) => Response | Promise<Response>]> = [
    ["password-gate redirect", (h) => passwordGateResponse(h)],
    ["5xx server error", (h) => serverErrorResponse(503, h)],
    ["429 rate limit", (h) => serverErrorResponse(429, h)],
    ["HTML content-type body", (h) => htmlBodyResponse(h)],
    ["empty body on a 200", (h) => emptyBodyResponse(h)],
    ["malformed JSON body", (h) => malformedJsonResponse(h)],
    ["JSON body with no id", (h) => missingIdResponse(h)],
  ];

  for (const [label, responder] of cases) {
    it(`${label} is environmental — handle excluded, no POST, storage intact`, async () => {
      const original = productionFormat(["env-handle"]);
      const { reconcileCalls } = await boot({
        wishlistRaw: original,
        fetchStub: (url) => Promise.resolve(responder(url.replace(/^\/products\//, "").replace(/\.js$/, "")) as Response),
      });
      expect(reconcileCalls).toHaveLength(0);
      expect(localStorage.getItem(STORAGE_KEY)).toBe(original);
    });
  }

  it("network failure (TypeError) is environmental — handle excluded", async () => {
    const { reconcileCalls } = await boot({
      wishlist: ["timeout-handle"],
      fetchStub: () => Promise.reject(new TypeError("Failed to fetch")),
    });
    expect(reconcileCalls).toHaveLength(0);
  });

  it("an environmental failure never causes a FALSE PRUNE of a sibling resolved handle", async () => {
    const original = productionFormat(["good", "env"]);
    const { reconcileCalls } = await boot({
      wishlistRaw: original,
      fetchStub: (url) =>
        url.includes("/products/good.js")
          ? Promise.resolve(productResponse(42, "good"))
          : Promise.resolve(passwordGateResponse("env")),
    });
    // The resolved one is merged; the ambiguous one is neither sent nor lost.
    expect(reconcileCalls[0]!.body.deviceLocal).toEqual(["42"]);
    expect(localStorage.getItem(STORAGE_KEY)).toBe(original);
  });
});

// ---------------------------------------------------------------------------
// 4. Reconcile request contract — W2
// ---------------------------------------------------------------------------

describe("W2 — the reconcile request carries the contract the server accepts", () => {
  it("sends `deviceLocal`, and does NOT send the rejected `productIds` key", async () => {
    const { reconcileCalls } = await boot({ wishlist: ["oud"], fetchStub: resolveOnly({ oud: 55555 }) });

    expect(reconcileCalls).toHaveLength(1);
    const raw = JSON.parse(reconcileCalls[0]!.init.body as string) as Record<string, unknown>;
    expect(Object.keys(raw)).toEqual(["deviceLocal"]);
    expect(raw).not.toHaveProperty("productIds");
    expect(raw.deviceLocal).toEqual(["55555"]);
  });

  it("POST goes to the proxy-relative reconcile endpoint", async () => {
    const { reconcileCalls } = await boot({ wishlist: ["oud"], fetchStub: resolveOnly({ oud: 55555 }) });
    expect(reconcileCalls[0]!.url).toBe("/apps/loyalty/v1/profile/wishlist/reconcile");
  });

  it("carries Idempotency-Key prefixed with 'wl-reconcile-' so a retry is safe", async () => {
    const { reconcileCalls } = await boot({ wishlist: ["h"], fetchStub: resolveOnly({ h: 1 }) });
    const headers = reconcileCalls[0]!.init.headers as Record<string, string>;
    expect(headers["Idempotency-Key"]).toMatch(/^wl-reconcile-/);
  });

  it("carries Content-Type: application/json", async () => {
    const { reconcileCalls } = await boot({ wishlist: ["h"], fetchStub: resolveOnly({ h: 1 }) });
    const headers = reconcileCalls[0]!.init.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
  });

  it("sends only numeric string ids — never a raw handle", async () => {
    const { reconcileCalls } = await boot({
      wishlist: ["my-handle"],
      fetchStub: resolveOnly({ "my-handle": 2138000 }),
    });
    const ids = reconcileCalls[0]!.body.deviceLocal;
    expect(ids).toHaveLength(1);
    expect(ids[0]).toMatch(/^\d+$/);
    expect(ids[0]).toBe("2138000");
  });

  it("carries no customer identifier of any kind — ownership is server-side only", async () => {
    const { reconcileCalls } = await boot({ wishlist: ["h"], fetchStub: resolveOnly({ h: 1 }) });
    const raw = JSON.parse(reconcileCalls[0]!.init.body as string) as Record<string, unknown>;
    expect(Object.keys(raw)).toEqual(["deviceLocal"]);
    for (const forbidden of ["customerId", "customer_id", "loggedInCustomerId", "shopifyCustomerId"]) {
      expect(raw).not.toHaveProperty(forbidden);
    }
    expect(reconcileCalls[0]!.url).not.toContain("customer");
  });
});

describe("reconcile request: exactly one POST per authenticated load", () => {
  it("fires exactly one POST regardless of how many handles resolve", async () => {
    const { reconcileCalls } = await boot({
      wishlist: ["h1", "h2", "h3"],
      fetchStub: resolveOnly({ h1: 101, h2: 102, h3: 103 }),
    });
    expect(reconcileCalls).toHaveLength(1);
  });

  it("fires exactly one POST when the list contains duplicates", async () => {
    const { reconcileCalls } = await boot({ wishlistRaw: "dup,dup", fetchStub: resolveOnly({ dup: 77 }) });
    expect(reconcileCalls).toHaveLength(1);
    // Duplicates collapsed before sending, so no duplicate server record is possible.
    expect(reconcileCalls[0]!.body.deviceLocal).toEqual(["77"]);
  });

  it("fires NO POST when the wishlist is empty", async () => {
    expect((await boot({ wishlistRaw: "" })).reconcileCalls).toHaveLength(0);
  });

  it("fires NO POST when there is no shopify-wishlist entry", async () => {
    expect((await boot({})).reconcileCalls).toHaveLength(0);
  });

  it("fires NO POST when all handles are missing (404)", async () => {
    const { reconcileCalls } = await boot({ wishlist: ["gone1", "gone2"], fetchStub: resolveOnly({}) });
    expect(reconcileCalls).toHaveLength(0);
  });

  it("fires NO POST when all handles are environmental", async () => {
    const { reconcileCalls } = await boot({
      wishlist: ["env1"],
      fetchStub: () => Promise.reject(new TypeError("Failed to fetch")),
    });
    expect(reconcileCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 5. Diagnostics — no longer swallowed, and privacy-safe
// ---------------------------------------------------------------------------

describe("diagnostics: failures are reported by stable code, never swallowed", () => {
  const codeOf = (d: DiagLine[]) => d.map((line) => line.code);

  it("reports nothing at all on a clean, fully-resolved merge", async () => {
    const { diagnostics } = await boot({ wishlist: ["h"], fetchStub: resolveOnly({ h: 1 }) });
    expect(diagnostics).toEqual([]);
  });

  it("reports a malformed local wishlist", async () => {
    const { diagnostics } = await boot({ wishlistRaw: ",,, ," });
    expect(codeOf(diagnostics)).toContain("wishlist_local_malformed");
  });

  it("reports nothing for an absent or empty key — that is normal, not a failure", async () => {
    expect((await boot({})).diagnostics).toEqual([]);
    expect((await boot({ wishlistRaw: "" })).diagnostics).toEqual([]);
  });

  it("reports product resolution failure with missing/environmental COUNTS", async () => {
    const { diagnostics } = await boot({
      wishlist: ["good", "dead", "env"],
      fetchStub: (url) => {
        if (url.includes("/products/good.js")) return Promise.resolve(productResponse(42, "good"));
        if (url.includes("/products/dead.js")) return Promise.resolve(notFoundResponse("dead"));
        return Promise.resolve(passwordGateResponse("env"));
      },
    });
    const line = diagnostics.find((d) => d.code === "wishlist_resolution_failed");
    expect(line).toBeDefined();
    expect(line).toMatchObject({ requested: 3, resolved: 1, missing: 1, environmental: 1 });
  });

  it("reports a validation failure (400) rather than swallowing it — the W2 signal", async () => {
    const { diagnostics } = await boot({
      wishlist: ["h"],
      fetchStub: resolveOnly({ h: 1 }),
      reconcileResponse: reconcileErrorResponse(400, "invalid_request"),
    });
    expect(codeOf(diagnostics)).toContain("wishlist_validation_rejected");
  });

  it("reports an authentication failure (401 and 403)", async () => {
    for (const status of [401, 403]) {
      const { diagnostics } = await boot({
        wishlist: ["h"],
        fetchStub: resolveOnly({ h: 1 }),
        reconcileResponse: reconcileErrorResponse(status, "identity_resolution_failed"),
      });
      expect(codeOf(diagnostics)).toContain("wishlist_auth_failed");
      localStorage.clear();
    }
  });

  it("reports a reconciliation API failure for a non-2xx that is not 400/401/403", async () => {
    const { diagnostics } = await boot({
      wishlist: ["h"],
      fetchStub: resolveOnly({ h: 1 }),
      reconcileResponse: reconcileErrorResponse(503, "upstream_unavailable"),
    });
    expect(codeOf(diagnostics)).toContain("wishlist_reconcile_api_failed");
  });

  it("reports a network failure / timeout", async () => {
    const { diagnostics } = await boot({
      wishlist: ["h"],
      fetchStub: resolveOnly({ h: 1 }),
      reconcileReject: new TypeError("Failed to fetch"),
    });
    expect(codeOf(diagnostics)).toContain("wishlist_network_failed");
  });

  it("classifies every taxonomy branch (direct, against the shipped classifier)", async () => {
    const { hooks } = await boot({});
    const classify = hooks.classifyReconcileFailure!;
    expect(classify(Object.assign(new Error("x"), { status: 400 }))).toBe("wishlist_validation_rejected");
    expect(classify(Object.assign(new Error("x"), { status: 422 }))).toBe("wishlist_validation_rejected");
    expect(classify(Object.assign(new Error("x"), { status: 401 }))).toBe("wishlist_auth_failed");
    expect(classify(Object.assign(new Error("x"), { status: 403 }))).toBe("wishlist_auth_failed");
    expect(classify(Object.assign(new Error("x"), { status: 500 }))).toBe("wishlist_reconcile_api_failed");
    expect(classify(Object.assign(new Error("x"), { status: 429 }))).toBe("wishlist_reconcile_api_failed");
    expect(classify(new TypeError("Failed to fetch"))).toBe("wishlist_network_failed");
    expect(classify(undefined)).toBe("wishlist_network_failed");
  });
});

describe("diagnostics: privacy — counts and codes only (design §24.3)", () => {
  it("leaks no handle, id, title, code, token, signature or payload in any line", async () => {
    const { diagnostics } = await boot({
      wishlistRaw: "secret-oud-handle,dead-handle,env-handle",
      fetchStub: (url) => {
        if (url.includes("/products/secret-oud-handle.js")) {
          return Promise.resolve(productResponse(2138000, "secret-oud-handle"));
        }
        if (url.includes("/products/dead-handle.js")) return Promise.resolve(notFoundResponse("dead-handle"));
        return Promise.resolve(passwordGateResponse("env-handle"));
      },
      reconcileResponse: reconcileErrorResponse(400, "invalid_request"),
    });

    expect(diagnostics.length).toBeGreaterThan(0);
    const serialised = JSON.stringify(diagnostics);
    for (const forbidden of ["secret-oud-handle", "dead-handle", "env-handle", "2138000", "Test Product"]) {
      expect(serialised).not.toContain(forbidden);
    }
  });

  it("every diagnostic value other than the code and section is a number", async () => {
    const { diagnostics } = await boot({
      wishlist: ["good", "dead"],
      fetchStub: resolveOnly({ good: 42 }),
      reconcileResponse: reconcileErrorResponse(503, "upstream_unavailable"),
    });

    expect(diagnostics.length).toBeGreaterThan(0);
    for (const line of diagnostics) {
      expect(typeof line.code).toBe("string");
      expect(line.section).toBe("wishlist_reconcile");
      for (const [key, value] of Object.entries(line)) {
        if (key === "code" || key === "section") continue;
        expect(typeof value, `${key} must be a count`).toBe("number");
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 6. Resilience
// ---------------------------------------------------------------------------

describe("resilience", () => {
  it("a failing reconcile POST does not throw or crash the dashboard", async () => {
    const original = productionFormat(["crash-test"]);
    const { reconcileCalls, diagnostics } = await boot({
      wishlistRaw: original,
      fetchStub: resolveOnly({ "crash-test": 999 }),
      reconcileResponse: reconcileErrorResponse(503, "upstream_unavailable"),
    });

    expect(reconcileCalls).toHaveLength(1);
    expect(document.querySelector("[data-loyalty-dashboard]")).not.toBeNull();
    expect(localStorage.getItem(STORAGE_KEY)).toBe(original);
    // Degraded silently for the customer, but recorded for us.
    expect(diagnostics.map((d) => d.code)).toContain("wishlist_reconcile_api_failed");
  });

  it("executing the shipped script never throws, whatever the stored value", async () => {
    for (const raw of ["", "   ", "a,b", "[oops", '{"a":1}', JSON.stringify([1, 2]), ",,,"]) {
      localStorage.clear();
      localStorage.setItem(STORAGE_KEY, raw);
      const hooks: TestHooks = {};
      (window as unknown as { __athoorLoyaltyTestHooks: TestHooks }).__athoorLoyaltyTestHooks = hooks;
      (window as unknown as { fetch: unknown }).fetch = vi.fn(() =>
        Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) } as unknown as Response),
      );
      document.body.innerHTML = fixture();
      expect(() => new Function(SCRIPT_SOURCE)(), `raw=${JSON.stringify(raw)}`).not.toThrow();
      await flush(3);
    }
  });

  it("adds no test-only surface when the harness hook is absent", async () => {
    localStorage.setItem(STORAGE_KEY, "h");
    (window as unknown as { fetch: unknown }).fetch = vi.fn(() =>
      Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) } as unknown as Response),
    );
    document.body.innerHTML = fixture();
    expect(() => new Function(SCRIPT_SOURCE)()).not.toThrow();
    await flush(3);
    expect(
      (window as unknown as { __athoorLoyaltyTestHooks?: TestHooks }).__athoorLoyaltyTestHooks,
    ).toBeUndefined();
  });
});
