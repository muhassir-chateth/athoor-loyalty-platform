// @vitest-environment jsdom
/**
 * THE BOUNDARY-SPANNING WISHLIST RECONCILE CONTRACT TEST (spec task 1.6).
 *
 * WHY THIS FILE IS THE POINT OF THE EXERCISE
 * -----------------------------------------
 * Defects W1 and W2 both survived a green CI because the two sides of one
 * boundary were tested against two different contracts and the tests never met
 * (design §8.1):
 *
 *   - `src/theme/wishlistReconcile.dom.test.ts` stubbed `fetch`, so the server's
 *     `zod` schema was never involved — and it seeded `localStorage` with
 *     `JSON.stringify([...])`, a format no production surface writes;
 *   - `src/routes/profileWrites.test.ts` posted a hand-written
 *     `{ deviceLocal: [...] }` via `app.inject`, so the client was never involved.
 *
 * Each side passed against its own idea of the contract. Nothing checked that the
 * bytes one side SENDS are the bytes the other side ACCEPTS.
 *
 * This test closes that gap and nothing else. It has one assertion path:
 *
 *   1. the REAL shipped `theme/assets/athoor-loyalty.js` runs in jsdom against
 *      `localStorage` seeded in the COMMA-DELIMITED format production writes,
 *      resolves handles through `/products/{handle}.js`, and serialises its own
 *      request body — no hand-written payload anywhere in this file;
 *   2. that EXACT captured body string, with the client's own `Content-Type`, is
 *      injected into the REAL Fastify route — the real
 *      {@link WISHLIST_RECONCILE_SCHEMA}, the real handler, the real
 *      `PgProfilePreferenceStore`, the real `reconcileWishlist` SQL;
 *   3. the shared {@link WishlistReconcileRequest} / {@link WishlistReconcileResponse}
 *      types are used on both sides, so a future rename is a `tsc` error rather
 *      than a silent `400`.
 *
 * The contract boundary is NOT mocked away. `fetch` is stubbed only for the
 * storefront's `/products/{handle}.js` catalogue lookups, which are a different
 * boundary (Shopify's storefront, not our API) and are not what broke.
 *
 * CONFIRMED RED AGAINST THE PRODUCTION BUG. Both fixes were individually
 * reverted and this suite was observed failing, then restored:
 *   - restoring the `JSON.parse` of `shopify-wishlist` (W1) → the client issues
 *     no request at all, so `capturedBody` is null and every contract test fails;
 *   - restoring the `{ productIds }` body (W2) → the real schema `.strip()`s the
 *     unknown key, `deviceLocal` is absent, `safeParse` fails and the real route
 *     answers `400 invalid_request`, which these tests assert against.
 *
 * SAFETY: in-memory only. No Postgres, no Shopify, no network, no production.
 *
 * Validates: Requirements 7.1, 7.8, 7.9, 20.6, 26.7
 */
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import type { QueryResult, QueryResultRow } from "pg";
import type { Queryable } from "../ledger/repository.js";
import { registerProfileRoutes, PgProfilePreferenceStore } from "../routes/profile.js";
import {
  WISHLIST_RECONCILE_SCHEMA,
  type WishlistReconcileRequest,
  type WishlistReconcileResponse,
} from "./wishlistReconcileContract.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = join(__dirname, "..", "..", "..", "theme", "assets", "athoor-loyalty.js");
const SCRIPT_SOURCE = readFileSync(SCRIPT_PATH, "utf8");

const STORAGE_KEY = "shopify-wishlist";
const CUSTOMER = "cust-boundary-0001";

// ---------------------------------------------------------------------------
// Side A — the REAL client. Produces a real request body.
// ---------------------------------------------------------------------------

/** Exactly what the shipped client put on the wire. Nothing here is hand-written. */
interface CapturedRequest {
  /** The serialised JSON body string, byte-for-byte as the client sent it. */
  body: string;
  headers: Record<string, string>;
  url: string;
  /** How many reconcile POSTs the client issued during the load. */
  callCount: number;
}

/** A resolved `/products/{handle}.js` response. */
function productResponse(id: number, handle: string): Response {
  return {
    ok: true,
    status: 200,
    redirected: false,
    url: `/products/${handle}.js`,
    headers: { get: (h: string) => (h === "content-type" ? "text/javascript; charset=utf-8" : null) },
    text: () => Promise.resolve(JSON.stringify({ id, handle, title: "Test Product" })),
  } as unknown as Response;
}

/** A 404 `/products/{handle}.js` response — archived, draft or deleted. */
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

/** A password-gate redirect — the `environmental` classification. */
function passwordGateResponse(): Response {
  return {
    ok: true,
    status: 200,
    redirected: true,
    url: "https://athoor-loyalty-staging.myshopify.com/password",
    headers: { get: (h: string) => (h === "content-type" ? "text/html; charset=utf-8" : null) },
    text: () => Promise.resolve("<!DOCTYPE html><html></html>"),
  } as unknown as Response;
}

function fixture(): string {
  return `
<div class="loyalty-dashboard" data-loyalty-dashboard data-loyalty-customer="true"
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

async function flush(times = 12): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 0));
}

/**
 * Runs the SHIPPED client against a `localStorage` value written the way
 * production writes it, and returns the request it actually produced.
 *
 * @param rawStorageValue the literal `shopify-wishlist` value; callers build it
 *   with `handles.join(",")`, never `JSON.stringify`.
 * @param catalogue handle → product id for handles the storefront resolves;
 *   anything absent 404s unless `environmental` names it.
 */
async function captureClientRequest(
  rawStorageValue: string | null,
  catalogue: Record<string, number>,
  environmental: string[] = [],
): Promise<CapturedRequest | null> {
  let captured: CapturedRequest | null = null;
  let callCount = 0;

  if (rawStorageValue !== null) localStorage.setItem(STORAGE_KEY, rawStorageValue);

  // Diagnostics are console-only; silence them so the boundary output stays readable.
  vi.spyOn(console, "warn").mockImplementation(() => {});

  (window as unknown as { fetch: unknown }).fetch = vi.fn((url: string, init: RequestInit = {}) => {
    if (
      url.includes("/v1/profile/wishlist/reconcile") &&
      (init.method ?? "GET").toUpperCase() === "POST"
    ) {
      callCount += 1;
      captured = {
        body: init.body as string,
        headers: init.headers as Record<string, string>,
        url,
        callCount,
      };
      // The client's own success path; the REAL server answer is asserted by
      // injecting the captured body below, not by this stub.
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ wishlist: [] }),
      } as unknown as Response);
    }

    // Storefront catalogue lookups — a different boundary, and not what broke.
    if (url.startsWith("/products/")) {
      const handle = decodeURIComponent(url.replace(/^\/products\//, "").replace(/\.js$/, ""));
      if (environmental.includes(handle)) return Promise.resolve(passwordGateResponse());
      const id = catalogue[handle];
      return Promise.resolve(id === undefined ? notFoundResponse(handle) : productResponse(id, handle));
    }

    // Unrelated dashboard reads.
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ spendableBalance: 0, tier: "bronze", entries: [], firstVisit: false, referralCode: "X", wasReferred: true }),
    } as unknown as Response);
  });

  document.body.innerHTML = fixture();
  new Function(SCRIPT_SOURCE)();
  await flush();

  if (captured) (captured as CapturedRequest).callCount = callCount;
  return captured;
}

// ---------------------------------------------------------------------------
// Side B — the REAL server. Real schema, real handler, real SQL text.
// ---------------------------------------------------------------------------

/** Answers the real `reconcileWishlist` / `getWishlist` SQL, scoped by customer. */
class FakeDb implements Queryable {
  /** customerId → product ids. Scoping is modelled, so a leak would show up. */
  readonly wishlists = new Map<string, Set<string>>();
  readonly statements: string[] = [];

  private setFor(customerId: string): Set<string> {
    let set = this.wishlists.get(customerId);
    if (!set) {
      set = new Set<string>();
      this.wishlists.set(customerId, set);
    }
    return set;
  }

  async query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values: unknown[] = [],
  ): Promise<QueryResult<R>> {
    this.statements.push(text.trim().split("\n")[0]!.trim());
    const ok = (rows: QueryResultRow[], command = "SELECT", rowCount?: number): QueryResult<R> => ({
      rows: rows as R[],
      rowCount: rowCount ?? rows.length,
      command,
      oid: 0,
      fields: [],
    });

    const customerId = String(values[0]);
    if (text.includes("INSERT INTO customer_wishlist")) {
      this.setFor(customerId).add(String(values[1]));
      return ok([], "INSERT", 1);
    }
    if (text.includes("FROM customer_wishlist")) {
      const ids = [...this.setFor(customerId)].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));
      return ok(ids.map((id) => ({ shopify_product_id: id })));
    }
    if (text.includes("FROM customer_favourites")) return ok([]);
    if (text.includes("FROM customer_recently_viewed")) return ok([]);
    throw new Error(`Unexpected query: ${text}`);
  }
}

interface ServerHarness {
  app: FastifyInstance;
  db: FakeDb;
}

async function serverHarness(customerId = CUSTOMER): Promise<ServerHarness> {
  const db = new FakeDb();
  const app = Fastify({ logger: false });
  app.addHook("preHandler", async (req) => {
    req.authCtx = { customerId, source: "app_proxy", channel: "web" };
  });
  registerProfileRoutes(app, { preferenceStore: new PgProfilePreferenceStore(db) });
  await app.ready();
  return { app, db };
}

/**
 * THE BOUNDARY CROSSING. Takes the client's own bytes and headers and puts them
 * through the real route. Nothing is re-serialised or reshaped in between.
 */
function injectCapturedRequest(app: FastifyInstance, captured: CapturedRequest) {
  return app.inject({
    method: "POST",
    url: "/profile/wishlist/reconcile",
    headers: { "content-type": captured.headers["Content-Type"]! },
    payload: captured.body,
  });
}

beforeEach(() => {
  localStorage.clear();
  document.body.innerHTML = "";
});

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  document.body.innerHTML = "";
});

// ---------------------------------------------------------------------------

describe("client↔server wishlist reconcile contract (the test whose absence hid W1 and W2)", () => {
  it("the client's own payload is ACCEPTED by the real schema and merged by the real handler", async () => {
    // Seeded exactly as production writes it — `join(',')`, not JSON.
    const captured = await captureClientRequest("oud-royale,amber-nuit", {
      "oud-royale": 7654321,
      "amber-nuit": 8765432,
    });

    // W1: if the client still JSON.parse'd this value, it would have sent nothing.
    expect(captured, "the client issued no reconcile request at all (W1 regression)").not.toBeNull();

    const { app, db } = await serverHarness();
    const res = await injectCapturedRequest(app, captured!);

    // W2: if the client still sent `{ productIds }`, the real `.strip()` schema
    // would drop it, `deviceLocal` would be absent, and this would be a 400.
    expect(res.statusCode, `real route rejected the real client payload: ${res.body}`).toBe(200);

    const merged = res.json() as WishlistReconcileResponse;
    expect(merged.wishlist).toEqual(["7654321", "8765432"]);
    expect([...db.wishlists.get(CUSTOMER)!].sort()).toEqual(["7654321", "8765432"]);
    await app.close();
  });

  it("the captured body parses as the SHARED request type under the SHARED schema", async () => {
    const captured = await captureClientRequest("single-handle", { "single-handle": 4242 });
    expect(captured).not.toBeNull();

    const parsed = WISHLIST_RECONCILE_SCHEMA.safeParse(JSON.parse(captured!.body));

    expect(parsed.success, `client body failed the shared schema: ${captured!.body}`).toBe(true);
    // Typed with the shared type — a rename on either side breaks compilation here.
    const request: WishlistReconcileRequest = parsed.data!;
    expect(request.deviceLocal).toEqual(["4242"]);
  });

  it("the client sends the canonical field and no stripped-away alternative", async () => {
    const captured = await captureClientRequest("h", { h: 99 });
    const raw = JSON.parse(captured!.body) as Record<string, unknown>;

    expect(Object.keys(raw)).toEqual(["deviceLocal"]);
    // The exact W2 shape must never come back.
    expect(raw).not.toHaveProperty("productIds");
  });

  it("a merge driven end to end is visible on the paired read endpoint", async () => {
    const captured = await captureClientRequest("a-handle,b-handle", { "a-handle": 11, "b-handle": 22 });
    const { app } = await serverHarness();

    await injectCapturedRequest(app, captured!);
    const read = await app.inject({ method: "GET", url: "/profile/wishlist" });

    expect(read.statusCode).toBe(200);
    expect(read.json().wishlist).toEqual(["11", "22"]);
    await app.close();
  });

  it("UNION, not replace: an existing account entry survives the client's merge", async () => {
    const captured = await captureClientRequest("new-handle", { "new-handle": 300 });
    const { app, db } = await serverHarness();
    db.wishlists.set(CUSTOMER, new Set(["100"])); // pre-existing account entry

    const res = await injectCapturedRequest(app, captured!);

    expect(res.json().wishlist).toEqual(["100", "300"]);
    await app.close();
  });

  it("duplicate local entries create exactly one server record (Req 7.9)", async () => {
    // Duplicates in the real storage format.
    const captured = await captureClientRequest("dup,dup,dup", { dup: 77 });
    const { app, db } = await serverHarness();

    const res = await injectCapturedRequest(app, captured!);

    expect(res.json().wishlist).toEqual(["77"]);
    expect(db.wishlists.get(CUSTOMER)!.size).toBe(1);
    await app.close();
  });

  it("a retry of the same captured request is idempotent — no duplicate record", async () => {
    const captured = await captureClientRequest("retry-handle", { "retry-handle": 555 });
    const { app, db } = await serverHarness();

    const first = await injectCapturedRequest(app, captured!);
    const retry = await injectCapturedRequest(app, captured!);

    expect(first.statusCode).toBe(200);
    expect(retry.statusCode).toBe(200);
    expect(retry.body).toBe(first.body);
    expect(db.wishlists.get(CUSTOMER)!.size).toBe(1);
    await app.close();
  });

  it("reconciliation never DELETES — the real SQL issued contains no delete", async () => {
    const captured = await captureClientRequest("h", { h: 1 });
    const { app, db } = await serverHarness();
    db.wishlists.set(CUSTOMER, new Set(["100"]));

    await injectCapturedRequest(app, captured!);

    expect(db.statements.some((s) => /DELETE/i.test(s))).toBe(false);
    expect(db.wishlists.get(CUSTOMER)!.has("100")).toBe(true);
    await app.close();
  });
});

describe("unresolved handles: excluded from the payload, and the local list stays intact", () => {
  it("a MISSING (404) handle is excluded, its sibling is merged, and storage is unchanged", async () => {
    const raw = "live-handle,dead-handle";
    const captured = await captureClientRequest(raw, { "live-handle": 9999 });
    const { app } = await serverHarness();

    const res = await injectCapturedRequest(app, captured!);

    expect(res.statusCode).toBe(200);
    // Only the resolvable one crossed the boundary...
    expect((res.json() as WishlistReconcileResponse).wishlist).toEqual(["9999"]);
    // ...and the unresolved one was NOT pruned from the device (§8.4 rule 4).
    expect(localStorage.getItem(STORAGE_KEY)).toBe(raw);
    await app.close();
  });

  it("an ENVIRONMENTAL handle is excluded safely and causes no false prune", async () => {
    const raw = "good-handle,gated-handle";
    const captured = await captureClientRequest(raw, { "good-handle": 42 }, ["gated-handle"]);
    const { app } = await serverHarness();

    const res = await injectCapturedRequest(app, captured!);

    expect((res.json() as WishlistReconcileResponse).wishlist).toEqual(["42"]);
    expect(localStorage.getItem(STORAGE_KEY)).toBe(raw);
    await app.close();
  });

  it("no request is issued when NOTHING resolves, and the local list survives", async () => {
    const raw = "gone-one,gone-two";
    const captured = await captureClientRequest(raw, {});

    expect(captured).toBeNull(); // no POST — there was nothing valid to merge
    expect(localStorage.getItem(STORAGE_KEY)).toBe(raw);
  });

  it("storage is unchanged after a SUCCESSFUL fully-resolved merge (read-only reconciliation)", async () => {
    // This IS design §8.4 rule 3, not a deviation from it and not a deferral:
    // `localStorage['shopify-wishlist']` is never cleared, and rule 3 names the
    // fully-resolved `200` explicitly as the path that is still not allowed to
    // clear it. Reconciliation is read-only with respect to device storage.
    //
    // Why: the merge is add-only, so nothing is deleted server-side, whereas
    // clearing device state is irreversible — preserving customer state is
    // safer than destructive convergence.
    //
    // The accepted cost, recorded so it is not mistaken for an oversight: a
    // product removed via `PUT /v1/profile/wishlist/:productId {on:false}` is
    // re-added on the next reconcile, once per page load, for as long as the
    // handle remains in localStorage. The fix is an explicit-removal tombstone
    // (task 6 schema, task 9.1 write path) and is out of scope here.
    //
    // LOAD-BEARING: this assertion, and the three like it above, are the pin on
    // rule 3. They must not be weakened, skipped or retitled away. If a future
    // change makes one fail, the change is wrong until rule 3 itself changes.
    const raw = "all-good-a,all-good-b";
    const captured = await captureClientRequest(raw, { "all-good-a": 1, "all-good-b": 2 });
    const { app } = await serverHarness();

    const res = await injectCapturedRequest(app, captured!);

    expect(res.statusCode).toBe(200);
    expect(localStorage.getItem(STORAGE_KEY)).toBe(raw);
    await app.close();
  });
});

describe("exactly one reconciliation per authenticated page load", () => {
  it("the client issues one POST for a multi-handle list", async () => {
    const captured = await captureClientRequest("h1,h2,h3", { h1: 1, h2: 2, h3: 3 });
    expect(captured!.callCount).toBe(1);
  });

  it("the single request carries every resolved id", async () => {
    const captured = await captureClientRequest("h1,h2,h3", { h1: 1, h2: 2, h3: 3 });
    const request = JSON.parse(captured!.body) as WishlistReconcileRequest;
    expect([...request.deviceLocal].sort()).toEqual(["1", "2", "3"]);
  });

  it("the request carries an Idempotency-Key, so the retry above is safe by contract", async () => {
    const captured = await captureClientRequest("h", { h: 1 });
    expect(captured!.headers["Idempotency-Key"]).toMatch(/^wl-reconcile-/);
  });
});

describe("the real schema's bounds apply to the real client's shape", () => {
  it("accepts a large but in-bounds device-local list produced by the client", async () => {
    const handles = Array.from({ length: 40 }, (_, i) => `handle-${i}`);
    const catalogue = Object.fromEntries(handles.map((h, i) => [h, 1000 + i]));
    const captured = await captureClientRequest(handles.join(","), catalogue);
    const { app } = await serverHarness();

    const res = await injectCapturedRequest(app, captured!);

    expect(res.statusCode).toBe(200);
    expect((res.json() as WishlistReconcileResponse).wishlist).toHaveLength(40);
    await app.close();
  });

  it("still refuses the OLD client shape, so no compatibility shim has crept in", async () => {
    const { app } = await serverHarness();

    const res = await app.inject({
      method: "POST",
      url: "/profile/wishlist/reconcile",
      payload: { productIds: ["123"] },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_request");
    await app.close();
  });

  it("still refuses an over-long array and an over-long id (schema stays strict)", async () => {
    const { app } = await serverHarness();

    const tooMany = await app.inject({
      method: "POST",
      url: "/profile/wishlist/reconcile",
      payload: { deviceLocal: Array.from({ length: 501 }, (_, i) => String(i + 1)) },
    });
    const tooLong = await app.inject({
      method: "POST",
      url: "/profile/wishlist/reconcile",
      payload: { deviceLocal: ["1".repeat(33)] },
    });

    expect(tooMany.statusCode).toBe(400);
    expect(tooLong.statusCode).toBe(400);
    await app.close();
  });

  it("strips an unknown key rather than trusting it (no arbitrary payload accepted)", async () => {
    const { app } = await serverHarness();

    const res = await app.inject({
      method: "POST",
      url: "/profile/wishlist/reconcile",
      payload: { deviceLocal: ["123"], customerId: "someone-else", productIds: ["999"] },
    });

    expect(res.statusCode).toBe(200);
    // The injected `productIds` was stripped, not merged.
    expect((res.json() as WishlistReconcileResponse).wishlist).toEqual(["123"]);
    await app.close();
  });
});
