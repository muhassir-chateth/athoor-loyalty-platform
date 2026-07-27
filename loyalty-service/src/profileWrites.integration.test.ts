/**
 * Profile preference writes — RUNTIME PATH integration test (task 31).
 *
 * Drives signed App Proxy requests through the FULL `buildApp` application, so
 * the whole production chain is exercised: signature verification → identity
 * resolution → the idempotency gate → the `/v1` router → the real
 * `PgProfilePreferenceStore` / `RecentlyViewedStore` → SQL. The route-level
 * tests mount the routes directly and would still pass if `buildApp` failed to
 * forward the stores — which is the exact class of gap that left these
 * implementations unreachable, so this file exists to close it.
 *
 * Also asserted here because they are properties of the WIRED app:
 *   - a write reaching the store is visible in the next `GET /v1/profile`
 *     (Req 17.2 "reflected on the next profile read");
 *   - the `/v1` `Idempotency-Key` contract applies to every new POST/PUT
 *     (Req 9.6/9.7), including replay without re-running the handler;
 *   - an unsigned request reaches no store at all (Req 11.4).
 *
 * SAFETY: in-memory only. No Postgres, no Shopify, no network.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { QueryResult, QueryResultRow } from "pg";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { InMemoryCustomerResolver } from "./auth/identity.js";
import { computeAppProxySignature, type QueryParams } from "./auth/appProxy.js";
import { PgProfilePreferenceStore } from "./routes/profile.js";
import { RecentlyViewedStore } from "./profile/recentlyViewed.js";
import { PgFragranceProfileDataSource } from "./profile/fragranceProfile.js";
import { RulesBasedSuggestionEngine } from "./profile/suggestions.js";
import type { Queryable } from "./ledger/repository.js";

const APP_PROXY_SECRET = "app-proxy-shared-secret";
const SHOPIFY_CUSTOMER_ID = "987654321";
const LOCAL_CUSTOMER_ID = "11111111-1111-4111-8111-111111111111";

function proxyUrl(path: string): string {
  const params: QueryParams = {
    shop: "myathoorlondon.myshopify.com",
    logged_in_customer_id: SHOPIFY_CUSTOMER_ID,
    path_prefix: "/apps/loyalty",
    timestamp: "1700000000",
  };
  const withSig = { ...params, signature: computeAppProxySignature(params, APP_PROXY_SECRET) };
  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(withSig)) if (typeof v === "string") search.set(k, v);
  return `${path}?${search.toString()}`;
}

/** Models the preference tables plus the reads the profile composition issues. */
class FakeDb implements Queryable {
  readonly favourites = new Set<string>();
  readonly wishlist = new Set<string>();
  readonly views = new Map<string, Date>();
  readonly ledgerWrites: string[] = [];
  viewInserts = 0;

  async query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values: unknown[] = [],
  ): Promise<QueryResult<R>> {
    const ok = (rows: QueryResultRow[], command = "SELECT", rowCount?: number): QueryResult<R> => ({
      rows: rows as R[],
      rowCount: rowCount ?? rows.length,
      command,
      oid: 0,
      fields: [],
    });
    if (text.includes("ledger_entries") || text.includes("point_lots")) {
      this.ledgerWrites.push(text);
      return ok([]);
    }
    if (text.includes("INSERT INTO customer_favourites")) {
      this.favourites.add(String(values[1]));
      return ok([], "INSERT", 1);
    }
    if (text.includes("DELETE FROM customer_favourites")) {
      this.favourites.delete(String(values[1]));
      return ok([], "DELETE", 1);
    }
    if (text.includes("FROM customer_favourites")) {
      const rows = [...this.favourites].sort();
      // The profile composition selects `product_id`/`created_at`; the
      // preference store selects `shopify_product_id`. Answer both shapes.
      return ok(
        rows.map((id) => ({
          shopify_product_id: id,
          product_id: id,
          created_at: new Date("2026-07-01T00:00:00Z"),
        })),
      );
    }
    if (text.includes("INSERT INTO customer_wishlist")) {
      this.wishlist.add(String(values[1]));
      return ok([], "INSERT", 1);
    }
    if (text.includes("FROM customer_wishlist")) {
      const rows = [...this.wishlist].sort();
      return ok(rows.map((id) => ({ shopify_product_id: id, product_id: id })));
    }
    if (text.includes("INSERT INTO customer_recently_viewed")) {
      this.viewInserts += 1;
      this.views.set(String(values[1]), values[2] as Date);
      return ok([], "INSERT", 1);
    }
    if (text.includes("FROM customer_recently_viewed")) {
      return ok(
        [...this.views.entries()].map(([id, viewedAt]) => ({
          product_id: id,
          shopify_product_id: id,
          viewed_at: viewedAt,
        })),
      );
    }
    if (text.includes("FROM tier_change_history")) return ok([]);
    if (text.includes("FROM portal_visits")) return ok([{ first_visit: false }]);
    return ok([]);
  }
}

describe("profile preference writes are reachable through the wired app (task 31)", () => {
  let app: FastifyInstance;
  let db: FakeDb;

  beforeEach(async () => {
    const config = loadConfig({ NODE_ENV: "test", SHOPIFY_APP_PROXY_SECRET: APP_PROXY_SECRET });
    db = new FakeDb();
    app = buildApp(config, {
      customerResolver: new InMemoryCustomerResolver({ [SHOPIFY_CUSTOMER_ID]: LOCAL_CUSTOMER_ID }),
      fragranceProfileDataSource: new PgFragranceProfileDataSource(db, {
        suggestionEngine: new RulesBasedSuggestionEngine(),
      }),
      preferenceStore: new PgProfilePreferenceStore(db),
      recentlyViewedRecorder: new RecentlyViewedStore(db),
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it("a favourite written over the signed surface appears in the next GET /v1/profile (Req 17.2)", async () => {
    const put = await app.inject({
      method: "PUT",
      url: proxyUrl("/v1/profile/favourites/4242"),
      headers: { "Idempotency-Key": "fav-1" },
      payload: { on: true },
    });

    expect(put.statusCode).toBe(200);
    const profile = await app.inject({ method: "GET", url: proxyUrl("/v1/profile") });
    expect(profile.statusCode).toBe(200);
    expect(profile.json().favourites).toEqual(["4242"]);
  });

  it("reconciles the device-local wishlist as a union and reflects it on the profile (Req 17.4)", async () => {
    db.wishlist.add("100");

    const res = await app.inject({
      method: "POST",
      url: proxyUrl("/v1/profile/wishlist/reconcile"),
      headers: { "Idempotency-Key": "wl-1" },
      payload: { deviceLocal: ["200", "300"] },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().wishlist).toEqual(["100", "200", "300"]);
    const profile = await app.inject({ method: "GET", url: proxyUrl("/v1/profile") });
    expect(profile.json().wishlist).toEqual(["100", "200", "300"]);
  });

  it("records a view off-ledger and reflects it on the profile (Req 17.5)", async () => {
    const res = await app.inject({
      method: "POST",
      url: proxyUrl("/v1/profile/recently-viewed"),
      headers: { "Idempotency-Key": "rv-1" },
      payload: { productId: "777" },
    });

    expect(res.statusCode).toBe(200);
    const profile = await app.inject({ method: "GET", url: proxyUrl("/v1/profile") });
    expect(profile.json().recentlyViewed.map((v: { productId: string }) => v.productId)).toEqual(["777"]);
    expect(db.ledgerWrites).toEqual([]);
  });

  it("serves GET /v1/profile/suggestions from the now-wired engine (Req 17.6)", async () => {
    // A view with no matching purchase is the engine's input; the assertion that
    // matters is that the endpoint answers rather than 404ing, and that it
    // returns an array — the ranking rules are the engine's own unit tests.
    await app.inject({
      method: "POST",
      url: proxyUrl("/v1/profile/recently-viewed"),
      headers: { "Idempotency-Key": "rv-sugg" },
      payload: { productId: "888" },
    });

    const res = await app.inject({ method: "GET", url: proxyUrl("/v1/profile/suggestions") });

    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json().suggestions)).toBe(true);
  });

  it("applies the /v1 idempotency contract to the new writes (Req 9.6/9.7)", async () => {
    const url = proxyUrl("/v1/profile/favourites/4242");

    const noKey = await app.inject({ method: "PUT", url, payload: { on: true } });
    expect(noKey.statusCode).toBe(400);
    expect(noKey.json().error).toBe("invalid_idempotency_key");
    expect(db.favourites.size).toBe(0);

    const first = await app.inject({
      method: "PUT",
      url,
      headers: { "Idempotency-Key": "same-key" },
      payload: { on: true },
    });
    const replay = await app.inject({
      method: "PUT",
      url,
      headers: { "Idempotency-Key": "same-key" },
      payload: { on: false },
    });

    expect(first.statusCode).toBe(200);
    expect(replay.headers["idempotent-replay"]).toBe("true");
    expect(replay.body).toBe(first.body);
    // The replay did not run the handler, so the `on: false` was never applied.
    expect(db.favourites.has("4242")).toBe(true);
  });

  it("reaches no store on an UNSIGNED request (Req 11.4)", async () => {
    const put = await app.inject({
      method: "PUT",
      url: "/v1/profile/favourites/4242",
      headers: { "Idempotency-Key": "unsigned" },
      payload: { on: true },
    });
    const view = await app.inject({
      method: "POST",
      url: "/v1/profile/recently-viewed",
      headers: { "Idempotency-Key": "unsigned-2" },
      payload: { productId: "777" },
    });

    expect(put.statusCode).toBe(401);
    expect(view.statusCode).toBe(401);
    expect(db.favourites.size).toBe(0);
    expect(db.views.size).toBe(0);
  });

  it("does not register the write routes when the stores are not wired", async () => {
    const config = loadConfig({ NODE_ENV: "test", SHOPIFY_APP_PROXY_SECRET: APP_PROXY_SECRET });
    const bare = buildApp(config, {
      customerResolver: new InMemoryCustomerResolver({ [SHOPIFY_CUSTOMER_ID]: LOCAL_CUSTOMER_ID }),
    });
    await bare.ready();

    const res = await bare.inject({
      method: "PUT",
      url: proxyUrl("/v1/profile/favourites/4242"),
      headers: { "Idempotency-Key": "bare" },
      payload: { on: true },
    });

    expect(res.statusCode).toBe(404);
    // The pre-existing read endpoint still works, unchanged.
    expect((await bare.inject({ method: "GET", url: proxyUrl("/v1/profile") })).statusCode).toBe(200);
    await bare.close();
  });
});
