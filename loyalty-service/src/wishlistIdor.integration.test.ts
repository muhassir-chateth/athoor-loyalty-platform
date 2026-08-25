/**
 * Wishlist authorisation / IDOR verification over the WIRED request surface
 * (spec tasks 1.3–1.6, design §4.3 Rule 1, §4.5, §4.6 item 3).
 *
 * WHY NOW
 * -------
 * The W1/W2 repair made `POST /v1/profile/wishlist/reconcile` reachable for the
 * first time in production — until now it returned `400` to every real call, so
 * `customer_wishlist` received nothing. An endpoint that starts writing rows for
 * the first time is exactly when its ownership model needs proving, not assuming.
 *
 * WHAT IS ASSERTED
 * ----------------
 * Customer **A** is authenticated throughout; **B** is the victim. A cannot:
 *   - reconcile into B's wishlist;
 *   - retrieve B's wishlist;
 *   - remove B's wishlist entries;
 *   - influence ownership by supplying another customer identifier or Shopify id
 *     in the body, the query string, the headers or the cookies.
 *
 * Ownership derives SOLELY from the server-side authenticated identity
 * (`req.authCtx` → `customers.id`, resolved from the App-Proxy-signed
 * `logged_in_customer_id`). Every request below carries a VALID signature for A,
 * so these tests isolate the authorisation question from the authentication one —
 * a `401` would not prove scoping, it would only prove the signature check works.
 *
 * NO PARALLEL MACHINERY. The signing helper, `buildApp` wiring and
 * `InMemoryCustomerResolver` usage are the established patterns of
 * `app.customer-sources.test.ts` and `profileWrites.integration.test.ts`. The one
 * addition is a `FakeDb` that models `customer_id` scoping, so a statement
 * missing its `WHERE customer_id = $1` predicate cannot pass.
 *
 * The DATA-LAYER counterpart is the two-customer isolation property in
 * `src/profile/behaviouralIsolation.property.test.ts`.
 *
 * SAFETY: in-memory only. No Postgres, no Shopify, no network, no production.
 *
 * Validates: Requirements 7.1, 7.8, 7.10
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { QueryResult, QueryResultRow } from "pg";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { InMemoryCustomerResolver } from "./auth/identity.js";
import { computeAppProxySignature, type QueryParams } from "./auth/appProxy.js";
import { PgProfilePreferenceStore } from "./routes/profile.js";
import { PgFragranceProfileDataSource } from "./profile/fragranceProfile.js";
import { RulesBasedSuggestionEngine } from "./profile/suggestions.js";
import type { Queryable } from "./ledger/repository.js";
import type { WishlistReconcileResponse } from "./profile/wishlistReconcileContract.js";

const APP_PROXY_SECRET = "app-proxy-shared-secret";

/** Customer A — the authenticated caller in every test below. */
const A_SHOPIFY_ID = "111111111";
const A_LOCAL_ID = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
/** Customer B — the victim. Never authenticates in this file. */
const B_SHOPIFY_ID = "222222222";
const B_LOCAL_ID = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";

/** B's private wishlist entries, seeded directly so no B request is needed. */
const B_PRODUCT_IDS = ["901", "902", "903"];

/**
 * A validly signed App Proxy URL for customer A.
 *
 * `extraSigned` params are folded into the signed message, so the request stays
 * authentic — that is what makes the outcome an AUTHORISATION result rather than
 * a signature rejection. `extraUnsigned` params are appended AFTER signing, which
 * is the design §4.5 row 2 case and must break the signature.
 */
function signedUrlFor(
  path: string,
  opts: { extraSigned?: Record<string, string>; extraUnsigned?: Record<string, string> } = {},
): string {
  const params: QueryParams = {
    shop: "myathoorlondon.myshopify.com",
    logged_in_customer_id: A_SHOPIFY_ID,
    path_prefix: "/apps/loyalty",
    timestamp: String(Math.floor(Date.now() / 1000)),
    ...(opts.extraSigned ?? {}),
  };
  const withSig = { ...params, signature: computeAppProxySignature(params, APP_PROXY_SECRET) };
  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(withSig)) if (typeof v === "string") search.set(k, v);
  for (const [k, v] of Object.entries(opts.extraUnsigned ?? {})) search.append(k, v);
  return `${path}?${search.toString()}`;
}

/**
 * Models `customer_wishlist` / `customer_favourites` WITH customer scoping, so a
 * statement that omitted its `customer_id` predicate would visibly cross
 * customers instead of silently passing.
 */
class ScopedFakeDb implements Queryable {
  readonly wishlists = new Map<string, Set<string>>();
  readonly favourites = new Map<string, Set<string>>();
  readonly statements: Array<{ text: string; values: unknown[] }> = [];

  private setIn(map: Map<string, Set<string>>, customerId: string): Set<string> {
    let set = map.get(customerId);
    if (!set) {
      set = new Set<string>();
      map.set(customerId, set);
    }
    return set;
  }

  seedWishlist(customerId: string, ids: string[]): void {
    this.wishlists.set(customerId, new Set(ids));
  }

  snapshot(customerId: string): string {
    return JSON.stringify({
      wishlist: [...this.setIn(this.wishlists, customerId)].sort(),
      favourites: [...this.setIn(this.favourites, customerId)].sort(),
    });
  }

  async query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values: unknown[] = [],
  ): Promise<QueryResult<R>> {
    this.statements.push({ text: text.trim(), values });
    const ok = (rows: QueryResultRow[], command = "SELECT", rowCount?: number): QueryResult<R> => ({
      rows: rows as R[],
      rowCount: rowCount ?? rows.length,
      command,
      oid: 0,
      fields: [],
    });

    const customerId = String(values[0]);

    if (text.includes("INSERT INTO customer_wishlist")) {
      this.setIn(this.wishlists, customerId).add(String(values[1]));
      return ok([], "INSERT", 1);
    }
    if (text.includes("FROM customer_wishlist")) {
      const ids = [...this.setIn(this.wishlists, customerId)].sort((a, b) =>
        BigInt(a) < BigInt(b) ? -1 : 1,
      );
      return ok(ids.map((id) => ({ shopify_product_id: id, product_id: id })));
    }
    if (text.includes("INSERT INTO customer_favourites")) {
      this.setIn(this.favourites, customerId).add(String(values[1]));
      return ok([], "INSERT", 1);
    }
    if (text.includes("DELETE FROM customer_favourites")) {
      const had = this.setIn(this.favourites, customerId).delete(String(values[1]));
      return ok([], "DELETE", had ? 1 : 0);
    }
    if (text.includes("FROM customer_favourites")) {
      const ids = [...this.setIn(this.favourites, customerId)].sort();
      return ok(
        ids.map((id) => ({
          shopify_product_id: id,
          product_id: id,
          created_at: new Date("2026-07-01T00:00:00Z"),
        })),
      );
    }
    if (text.includes("FROM customer_recently_viewed")) return ok([]);
    if (text.includes("FROM tier_change_history")) return ok([]);
    if (text.includes("FROM portal_visits")) return ok([{ first_visit: false }]);
    return ok([]);
  }
}

let app: FastifyInstance;
let db: ScopedFakeDb;

beforeEach(async () => {
  const config = loadConfig({ NODE_ENV: "test", SHOPIFY_APP_PROXY_SECRET: APP_PROXY_SECRET });
  db = new ScopedFakeDb();
  db.seedWishlist(B_LOCAL_ID, B_PRODUCT_IDS);
  app = buildApp(config, {
    customerResolver: new InMemoryCustomerResolver({
      [A_SHOPIFY_ID]: A_LOCAL_ID,
      [B_SHOPIFY_ID]: B_LOCAL_ID,
    }),
    fragranceProfileDataSource: new PgFragranceProfileDataSource(db, {
      suggestionEngine: new RulesBasedSuggestionEngine(),
    }),
    preferenceStore: new PgProfilePreferenceStore(db),
  });
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

/** Reconcile as A, optionally with extra body keys / query params / headers. */
function reconcileAsA(opts: {
  payload?: Record<string, unknown>;
  extraSigned?: Record<string, string>;
  extraUnsigned?: Record<string, string>;
  headers?: Record<string, string>;
  key?: string;
} = {}) {
  return app.inject({
    method: "POST",
    url: signedUrlFor("/v1/profile/wishlist/reconcile", {
      extraSigned: opts.extraSigned,
      extraUnsigned: opts.extraUnsigned,
    }),
    headers: { "Idempotency-Key": opts.key ?? `idor-${Math.random()}`, ...(opts.headers ?? {}) },
    payload: opts.payload ?? { deviceLocal: ["500"] },
  });
}

// ---------------------------------------------------------------------------

describe("A cannot reconcile into B's wishlist", () => {
  it("A's reconcile writes only to A, leaving B byte-identical", async () => {
    const bBefore = db.snapshot(B_LOCAL_ID);

    const res = await reconcileAsA({ payload: { deviceLocal: ["500", "501"] } });

    expect(res.statusCode).toBe(200);
    expect((res.json() as WishlistReconcileResponse).wishlist).toEqual(["500", "501"]);
    expect(db.snapshot(B_LOCAL_ID)).toBe(bBefore);
    expect([...db.wishlists.get(B_LOCAL_ID)!].sort()).toEqual(B_PRODUCT_IDS);
  });

  it("every wishlist statement A's request issued was bound to A's customer id", async () => {
    await reconcileAsA({ payload: { deviceLocal: ["500"] } });

    const wishlistStatements = db.statements.filter((s) => s.text.includes("customer_wishlist"));
    expect(wishlistStatements.length).toBeGreaterThan(0);
    for (const statement of wishlistStatements) {
      // `$1` is the customer id in every one of these statements, and it is
      // always bound from `req.authCtx`, never from anything the caller sent.
      expect(statement.text).toContain("customer_id");
      expect(statement.values[0]).toBe(A_LOCAL_ID);
      expect(statement.values[0]).not.toBe(B_LOCAL_ID);
      // The scoping SHAPE differs by statement kind and both must be present:
      // an INSERT scopes by writing `customer_id` as its first column, a
      // read/delete scopes with a `WHERE customer_id = $1` predicate.
      if (/^INSERT/i.test(statement.text)) {
        expect(statement.text).toMatch(/INSERT INTO customer_wishlist \(customer_id,/);
      } else {
        expect(statement.text).toContain("customer_id = $1");
      }
    }
    // Both shapes were actually exercised, so neither branch above is vacuous.
    expect(wishlistStatements.some((s) => /^INSERT/i.test(s.text))).toBe(true);
    expect(wishlistStatements.some((s) => /^SELECT/i.test(s.text))).toBe(true);
  });

  it("naming B's product ids in A's own device list adds them to A only, never moves B's rows", async () => {
    const bBefore = db.snapshot(B_LOCAL_ID);

    const res = await reconcileAsA({ payload: { deviceLocal: B_PRODUCT_IDS } });

    // A legitimately ends up wishlisting the same products — as A's OWN rows.
    expect((res.json() as WishlistReconcileResponse).wishlist).toEqual(B_PRODUCT_IDS);
    // B's rows are entirely unaffected.
    expect(db.snapshot(B_LOCAL_ID)).toBe(bBefore);
  });
});

describe("A cannot retrieve B's wishlist", () => {
  it("GET /v1/profile/wishlist returns A's wishlist, never B's", async () => {
    await reconcileAsA({ payload: { deviceLocal: ["500"] } });

    const res = await app.inject({ method: "GET", url: signedUrlFor("/v1/profile/wishlist") });

    expect(res.statusCode).toBe(200);
    expect(res.json().wishlist).toEqual(["500"]);
    for (const bId of B_PRODUCT_IDS) expect(res.json().wishlist).not.toContain(bId);
  });

  it("a signed `customerId=B` query parameter is ignored — A's wishlist is returned", async () => {
    await reconcileAsA({ payload: { deviceLocal: ["500"] } });

    const res = await app.inject({
      method: "GET",
      url: signedUrlFor("/v1/profile/wishlist", { extraSigned: { customerId: B_LOCAL_ID } }),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().wishlist).toEqual(["500"]);
  });

  it("GET /v1/profile exposes A's wishlist only", async () => {
    await reconcileAsA({ payload: { deviceLocal: ["500"] } });

    const res = await app.inject({ method: "GET", url: signedUrlFor("/v1/profile") });

    expect(res.statusCode).toBe(200);
    expect(res.json().wishlist).toEqual(["500"]);
    for (const bId of B_PRODUCT_IDS) expect(res.json().wishlist).not.toContain(bId);
  });

  it("an empty wishlist for A is an empty array, not an existence oracle about B", async () => {
    const res = await app.inject({ method: "GET", url: signedUrlFor("/v1/profile/wishlist") });

    expect(res.statusCode).toBe(200);
    expect(res.json().wishlist).toEqual([]);
  });
});

describe("A cannot remove B's wishlist entries", () => {
  it("reconciliation is add-only: A's request issues no DELETE against the wishlist", async () => {
    await reconcileAsA({ payload: { deviceLocal: ["500"] } });

    const deletes = db.statements.filter(
      (s) => /DELETE/i.test(s.text) && s.text.includes("customer_wishlist"),
    );
    expect(deletes).toEqual([]);
  });

  it("no route exists that A could use to delete a wishlist row", async () => {
    // The dedicated removal endpoint (`PUT /v1/profile/wishlist/:productId`) is
    // spec task 9.1 and does not exist yet. Asserted here so that when it lands,
    // this test fails and forces its own IDOR coverage rather than shipping
    // unexamined.
    for (const [method, url] of [
      ["PUT", `/v1/profile/wishlist/${B_PRODUCT_IDS[0]}`],
      ["DELETE", `/v1/profile/wishlist/${B_PRODUCT_IDS[0]}`],
    ] as const) {
      const res = await app.inject({
        method,
        url: signedUrlFor(url),
        headers: { "Idempotency-Key": `no-route-${method}` },
        payload: { on: false },
      });
      expect(res.statusCode).toBe(404);
    }
    expect([...db.wishlists.get(B_LOCAL_ID)!].sort()).toEqual(B_PRODUCT_IDS);
  });

  it("the delete-shaped preference path is customer-scoped: A cannot unset B's favourite", async () => {
    // Favourites is the one preference table with a production DELETE, so it is
    // where the `WHERE customer_id = $1 AND <resource> = $2` shape is provable.
    db.favourites.set(B_LOCAL_ID, new Set(["901"]));
    const bBefore = db.snapshot(B_LOCAL_ID);

    const res = await app.inject({
      method: "PUT",
      url: signedUrlFor("/v1/profile/favourites/901"),
      headers: { "Idempotency-Key": "fav-idor" },
      payload: { on: false },
    });

    expect(res.statusCode).toBe(200);
    expect(db.snapshot(B_LOCAL_ID)).toBe(bBefore);
    const deletes = db.statements.filter((s) => /^DELETE/i.test(s.text));
    expect(deletes.length).toBeGreaterThan(0);
    for (const statement of deletes) {
      expect(statement.text).toContain("customer_id = $1");
      expect(statement.values[0]).toBe(A_LOCAL_ID);
    }
  });
});

describe("A cannot influence ownership by supplying an identifier anywhere", () => {
  const bIdentifiers: Array<[string, Record<string, unknown>]> = [
    ["customerId", { customerId: B_LOCAL_ID }],
    ["customer_id", { customer_id: B_LOCAL_ID }],
    ["shopifyCustomerId", { shopifyCustomerId: B_SHOPIFY_ID }],
    ["logged_in_customer_id", { logged_in_customer_id: B_SHOPIFY_ID }],
    ["targetCustomerId", { targetCustomerId: B_LOCAL_ID }],
  ];

  for (const [label, extra] of bIdentifiers) {
    it(`a \`${label}\` in the BODY is stripped — the merge lands on A`, async () => {
      const bBefore = db.snapshot(B_LOCAL_ID);

      const res = await reconcileAsA({ payload: { deviceLocal: ["500"], ...extra } });

      expect(res.statusCode).toBe(200);
      expect((res.json() as WishlistReconcileResponse).wishlist).toEqual(["500"]);
      expect(db.snapshot(B_LOCAL_ID)).toBe(bBefore);
      expect([...db.wishlists.get(A_LOCAL_ID)!]).toEqual(["500"]);
    });
  }

  it("a SIGNED `logged_in_customer_id` duplicate cannot redirect the merge to B", async () => {
    // Folded into the signed message, so the request is authentic — the only
    // question left is whether the handler trusts the extra value. It must not.
    const bBefore = db.snapshot(B_LOCAL_ID);

    const res = await reconcileAsA({ extraSigned: { customerId: B_LOCAL_ID } });

    expect(res.statusCode).toBe(200);
    expect(db.snapshot(B_LOCAL_ID)).toBe(bBefore);
    expect([...db.wishlists.get(A_LOCAL_ID)!]).toEqual(["500"]);
  });

  it("an UNSIGNED added query parameter breaks the signature (design §4.5 row 2)", async () => {
    const bBefore = db.snapshot(B_LOCAL_ID);

    const res = await reconcileAsA({ extraUnsigned: { customerId: B_LOCAL_ID } });

    expect(res.statusCode).toBe(401);
    expect(db.snapshot(B_LOCAL_ID)).toBe(bBefore);
    expect(db.wishlists.has(A_LOCAL_ID)).toBe(false); // nothing written at all
  });

  it("B-identifying HEADERS are ignored — the merge lands on A", async () => {
    const bBefore = db.snapshot(B_LOCAL_ID);

    const res = await reconcileAsA({
      headers: {
        "x-shopify-customer-id": B_SHOPIFY_ID,
        "x-customer-id": B_LOCAL_ID,
        "x-logged-in-customer-id": B_SHOPIFY_ID,
      },
    });

    expect(res.statusCode).toBe(200);
    expect(db.snapshot(B_LOCAL_ID)).toBe(bBefore);
    expect([...db.wishlists.get(A_LOCAL_ID)!]).toEqual(["500"]);
  });

  it("B-identifying COOKIES are ignored — the merge lands on A", async () => {
    const bBefore = db.snapshot(B_LOCAL_ID);

    const res = await reconcileAsA({
      headers: {
        cookie: `customer_id=${B_LOCAL_ID}; logged_in_customer_id=${B_SHOPIFY_ID}; secure_customer_sig=forged`,
      },
    });

    expect(res.statusCode).toBe(200);
    expect(db.snapshot(B_LOCAL_ID)).toBe(bBefore);
    expect([...db.wishlists.get(A_LOCAL_ID)!]).toEqual(["500"]);
  });

  it("a body, query, header and cookie attack COMBINED still lands on A", async () => {
    const bBefore = db.snapshot(B_LOCAL_ID);

    const res = await reconcileAsA({
      payload: { deviceLocal: ["500"], customerId: B_LOCAL_ID, customer_id: B_SHOPIFY_ID },
      extraSigned: { customerId: B_LOCAL_ID },
      headers: {
        "x-shopify-customer-id": B_SHOPIFY_ID,
        cookie: `customer_id=${B_LOCAL_ID}`,
      },
    });

    expect(res.statusCode).toBe(200);
    expect((res.json() as WishlistReconcileResponse).wishlist).toEqual(["500"]);
    expect(db.snapshot(B_LOCAL_ID)).toBe(bBefore);
  });

  it("no statement in ANY of the above ever bound B's customer id", async () => {
    await reconcileAsA({
      payload: { deviceLocal: ["500"], customerId: B_LOCAL_ID },
      headers: { "x-shopify-customer-id": B_SHOPIFY_ID, cookie: `customer_id=${B_LOCAL_ID}` },
    });
    await app.inject({ method: "GET", url: signedUrlFor("/v1/profile/wishlist") });

    for (const statement of db.statements) {
      expect(statement.values).not.toContain(B_LOCAL_ID);
      expect(statement.values).not.toContain(B_SHOPIFY_ID);
    }
  });
});

describe("unauthenticated and identity-less requests reach no wishlist at all", () => {
  it("an unsigned reconcile is 401 and writes nothing", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/profile/wishlist/reconcile",
      headers: { "Idempotency-Key": "unsigned" },
      payload: { deviceLocal: ["500"] },
    });

    expect(res.statusCode).toBe(401);
    expect(db.wishlists.has(A_LOCAL_ID)).toBe(false);
    expect([...db.wishlists.get(B_LOCAL_ID)!].sort()).toEqual(B_PRODUCT_IDS);
  });

  it("a signed request with logged_in_customer_id=0 is 401 and writes nothing", async () => {
    const params: QueryParams = {
      shop: "myathoorlondon.myshopify.com",
      logged_in_customer_id: "0",
      path_prefix: "/apps/loyalty",
      timestamp: String(Math.floor(Date.now() / 1000)),
    };
    const withSig = { ...params, signature: computeAppProxySignature(params, APP_PROXY_SECRET) };
    const search = new URLSearchParams();
    for (const [k, v] of Object.entries(withSig)) if (typeof v === "string") search.set(k, v);

    const res = await app.inject({
      method: "POST",
      url: `/v1/profile/wishlist/reconcile?${search.toString()}`,
      headers: { "Idempotency-Key": "anon" },
      payload: { deviceLocal: ["500"] },
    });

    expect(res.statusCode).toBe(401);
    expect(db.wishlists.has(A_LOCAL_ID)).toBe(false);
  });

  it("a forged signature naming B is 401 and B's wishlist is untouched", async () => {
    const bBefore = db.snapshot(B_LOCAL_ID);

    const res = await app.inject({
      method: "POST",
      url:
        "/v1/profile/wishlist/reconcile?shop=myathoorlondon.myshopify.com" +
        `&logged_in_customer_id=${B_SHOPIFY_ID}&path_prefix=/apps/loyalty` +
        "&timestamp=1700000000&signature=deadbeef",
      headers: { "Idempotency-Key": "forged" },
      payload: { deviceLocal: ["999"] },
    });

    expect(res.statusCode).toBe(401);
    expect(db.snapshot(B_LOCAL_ID)).toBe(bBefore);
  });
});
