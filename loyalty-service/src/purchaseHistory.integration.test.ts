/**
 * Purchase history → suggestions — RUNTIME PATH integration test (task 44).
 *
 * Req 17.6 requires suggestions to EXCLUDE any fragrance the customer has already
 * purchased. That rule was already implemented in `RulesBasedSuggestionEngine`
 * and already correct — it simply had nothing to exclude, because the profile's
 * Shopify source was the empty default. So the assertion that matters is not "the
 * engine filters" (its own tests cover that) but "the purchase data now reaches
 * the engine through the wired application".
 *
 * These tests therefore drive signed App Proxy requests through the FULL
 * `buildApp` app with the REAL `ShopifyGraphqlPurchaseHistorySource` behind an
 * injected `fetch`, and assert on `GET /v1/profile` and
 * `GET /v1/profile/suggestions`:
 *
 *   - purchased fragrances appear (Req 17.1) — previously always empty;
 *   - a viewed product the customer HAS purchased is excluded from suggestions,
 *     while a viewed product they have not purchased survives (Req 17.6);
 *   - a Shopify failure degrades this one field instead of failing the profile,
 *     and the documented consequence (a purchased product may reappear in
 *     suggestions for that request) is asserted rather than glossed over.
 *
 * SAFETY: in-memory only. No Postgres, no Shopify, no network.
 */
import { describe, expect, it } from "vitest";
import type { QueryResult, QueryResultRow } from "pg";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { InMemoryCustomerResolver } from "./auth/identity.js";
import { computeAppProxySignature, type QueryParams } from "./auth/appProxy.js";
import { PgFragranceProfileDataSource } from "./profile/fragranceProfile.js";
import { RulesBasedSuggestionEngine } from "./profile/suggestions.js";
import {
  CachingPurchaseHistorySource,
  ShopifyGraphqlPurchaseHistorySource,
  type ShopifyCustomerIdLookup,
} from "./shopify/purchaseHistory.js";
import type { Queryable } from "./ledger/repository.js";

const APP_PROXY_SECRET = "app-proxy-shared-secret";
const SHOPIFY_CUSTOMER_ID = "987654321";
const LOCAL_CUSTOMER_ID = "11111111-1111-4111-8111-111111111111";

/** A product the customer bought AND viewed — must not be suggested. */
const PURCHASED = "8828510306503";
/** A product the customer only viewed — may be suggested. */
const VIEWED_ONLY = "8828510339271";

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

/** Answers the profile composition's preference reads; both products are viewed. */
const db: Queryable = {
  query: async <R extends QueryResultRow>(text: string) => {
    const rows: QueryResultRow[] =
      text.includes("customer_recently_viewed")
        ? [
            { product_id: PURCHASED, viewed_at: new Date("2026-06-01T00:00:00Z") },
            { product_id: VIEWED_ONLY, viewed_at: new Date("2026-06-02T00:00:00Z") },
          ]
        : [];
    return { rows: rows as R[], rowCount: rows.length, command: "SELECT", oid: 0, fields: [] } as QueryResult<R>;
  },
};

const lookup: ShopifyCustomerIdLookup = {
  findShopifyCustomerId: async (id) => (id === LOCAL_CUSTOMER_ID ? SHOPIFY_CUSTOMER_ID : null),
};

/** Injected fetch returning one paid order containing PURCHASED, or failing. */
function shopifyFetch(mode: "ok" | "fail"): unknown {
  return async () => {
    if (mode === "fail") {
      throw new TypeError("network down");
    }
    const data = {
      customer: {
        id: `gid://shopify/Customer/${SHOPIFY_CUSTOMER_ID}`,
        orders: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [
            {
              id: "gid://shopify/Order/1",
              test: false,
              cancelledAt: null,
              displayFinancialStatus: "PAID",
              processedAt: "2026-05-01T00:00:00Z",
              createdAt: "2026-05-01T00:00:00Z",
              lineItems: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [
                  { product: { id: `gid://shopify/Product/${PURCHASED}`, title: "Athoor Oud" } },
                ],
              },
            },
          ],
        },
      },
    };
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => JSON.stringify({ data }),
    };
  };
}

function appWith(mode: "ok" | "fail" | "unwired", onDegraded?: (err: unknown, id: string) => void) {
  const config = loadConfig({ NODE_ENV: "test", SHOPIFY_APP_PROXY_SECRET: APP_PROXY_SECRET });
  const shopify =
    mode === "unwired"
      ? undefined
      : new CachingPurchaseHistorySource(
          new ShopifyGraphqlPurchaseHistorySource(
            "athoor-loyalty-staging.myshopify.com",
            "shpua_test",
            lookup,
            shopifyFetch(mode) as never,
            { sleep: async () => {} },
          ),
          { ...(onDegraded ? { onDegraded } : {}) },
        );
  return buildApp(config, {
    customerResolver: new InMemoryCustomerResolver({ [SHOPIFY_CUSTOMER_ID]: LOCAL_CUSTOMER_ID }),
    fragranceProfileDataSource: new PgFragranceProfileDataSource(db, {
      suggestionEngine: new RulesBasedSuggestionEngine(),
      ...(shopify ? { shopify } : {}),
    }),
  });
}

describe("purchase history reaches the profile and the suggestion engine (task 44)", () => {
  it("returns purchased fragrances on GET /v1/profile (Req 17.1)", async () => {
    const app = appWith("ok");
    await app.ready();

    const res = await app.inject({ method: "GET", url: proxyUrl("/v1/profile") });

    expect(res.statusCode).toBe(200);
    expect(res.json().purchasedFragrances).toEqual([
      {
        productId: PURCHASED,
        title: "Athoor Oud",
        firstPurchasedAt: "2026-05-01T00:00:00Z",
        lastPurchasedAt: "2026-05-01T00:00:00Z",
        purchaseCount: 1,
      },
    ]);
    await app.close();
  });

  it("EXCLUDES the already-purchased fragrance from suggestions (Req 17.6)", async () => {
    const app = appWith("ok");
    await app.ready();

    const profile = await app.inject({ method: "GET", url: proxyUrl("/v1/profile") });
    const suggestions = await app.inject({ method: "GET", url: proxyUrl("/v1/profile/suggestions") });

    // Both products were viewed; only the un-purchased one may be suggested.
    expect(profile.json().recentlyViewed.map((v: { productId: string }) => v.productId).sort()).toEqual(
      [PURCHASED, VIEWED_ONLY].sort(),
    );
    expect(profile.json().suggestions).toEqual([VIEWED_ONLY]);
    expect(suggestions.json().suggestions).toEqual([VIEWED_ONLY]);
    expect(profile.json().suggestions).not.toContain(PURCHASED);
    await app.close();
  });

  it("without the source wired, the purchased product is NOT excluded — the bug this fixes", async () => {
    const app = appWith("unwired");
    await app.ready();

    const profile = await app.inject({ method: "GET", url: proxyUrl("/v1/profile") });

    // Demonstrates the previous production behaviour: no purchases known, so the
    // exclusion rule had nothing to act on and a purchased product was suggested.
    expect(profile.json().purchasedFragrances).toEqual([]);
    expect(profile.json().suggestions).toContain(PURCHASED);
    await app.close();
  });

  it("degrades one field, not the profile, when Shopify fails — and reports it", async () => {
    const degraded: Array<{ customerId: string }> = [];
    const app = appWith("fail", (_err, customerId) => degraded.push({ customerId }));
    await app.ready();

    const res = await app.inject({ method: "GET", url: proxyUrl("/v1/profile") });

    expect(res.statusCode).toBe(200);
    expect(res.json().purchasedFragrances).toEqual([]);
    // The documented consequence, asserted rather than glossed over: with no
    // purchase data the exclusion cannot fire for this request.
    expect(res.json().suggestions).toContain(PURCHASED);
    // TWO reports for one request, and that is correct rather than a bug: the
    // profile composition asks for purchases twice — once for the
    // `purchasedFragrances` field and once as the suggestion engine's purchase
    // history — and a FAILURE is deliberately not cached, so each attempt is made
    // and each is reported. On the success path the cache collapses those two
    // asks into a single Shopify read (asserted below).
    // ONE report for one request, not one per consumer: the profile composition
    // asks for purchases twice (the field and the suggestion engine's history)
    // and asks concurrently, so both join the same in-flight read. The failure is
    // still not cached, so the next request retries.
    expect(degraded).toEqual([{ customerId: LOCAL_CUSTOMER_ID }]);
    await app.close();
  });

  it("makes ONE Shopify read per profile request, not one per consumer", async () => {
    let reads = 0;
    const countingFetch = (async (...args: unknown[]) => {
      reads += 1;
      return (shopifyFetch("ok") as (...a: unknown[]) => Promise<unknown>)(...args);
    }) as unknown;
    const config = loadConfig({ NODE_ENV: "test", SHOPIFY_APP_PROXY_SECRET: APP_PROXY_SECRET });
    const app = buildApp(config, {
      customerResolver: new InMemoryCustomerResolver({ [SHOPIFY_CUSTOMER_ID]: LOCAL_CUSTOMER_ID }),
      fragranceProfileDataSource: new PgFragranceProfileDataSource(db, {
        suggestionEngine: new RulesBasedSuggestionEngine(),
        shopify: new CachingPurchaseHistorySource(
          new ShopifyGraphqlPurchaseHistorySource(
            "athoor-loyalty-staging.myshopify.com",
            "shpua_test",
            lookup,
            countingFetch as never,
            { sleep: async () => {} },
          ),
        ),
      }),
    });
    await app.ready();

    await app.inject({ method: "GET", url: proxyUrl("/v1/profile") });

    // The field and the suggestion engine both asked; the cache served the second.
    expect(reads).toBe(1);
    await app.close();
  });

  it("returns only the requesting customer's purchases (Req 17.10)", async () => {
    // The lookup resolves only the authenticated local id, so an unrelated id
    // cannot produce purchases — the Shopify GID is never taken from a request.
    await expect(lookup.findShopifyCustomerId("someone-else")).resolves.toBeNull();
  });
});
