/**
 * Tests for `GET /v1/profile` and `GET /v1/profile/journey` (task 14.5,
 * Requirement 17).
 *
 * Exercises the routes through a real Fastify app wired with the actual `/v1`
 * auth layer and an in-memory Fragrance_Profile data source — so NO live
 * Shopify Admin API or Postgres is touched. Verifies:
 *   - an authenticated request returns the composed profile + journey (Req 17.1,
 *     17.8);
 *   - a customer with no data gets empty categories, not an error (Req 17.9);
 *   - the payload is identical across App Proxy and Customer Account API
 *     identity, and only the requesting customer's data is returned (Req 17.10);
 *   - an unauthenticated request is rejected before the handler runs (Req 9.3).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { registerVersioning } from "../plugins/versioning.js";
import { v1Routes } from "./v1.js";
import { InMemoryCustomerResolver, FakeTokenVerifier } from "../auth/identity.js";
import { computeAppProxySignature, type QueryParams } from "../auth/appProxy.js";
import {
  InMemoryFragranceProfileDataSource,
  type FragranceProfileDataSource,
} from "../profile/fragranceProfile.js";
import { InMemoryPortalVisitRecorder, type PortalVisitRecorder } from "./profile.js";

const APP_PROXY_SECRET = "app-proxy-shared-secret";
const SHOPIFY_CUSTOMER_ID = "987654321";
const LOCAL_CUSTOMER_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_LOCAL_ID = "22222222-2222-4222-8222-222222222222";
const BEARER_TOKEN = "valid-caa-token";

function seededSource(): FragranceProfileDataSource {
  return new InMemoryFragranceProfileDataSource({
    purchasedFragrances: {
      [LOCAL_CUSTOMER_ID]: [
        {
          productId: "100",
          title: "Oud Royale",
          firstPurchasedAt: "2024-01-01T00:00:00.000Z",
          lastPurchasedAt: "2024-01-01T00:00:00.000Z",
          purchaseCount: 1,
        },
      ],
      [OTHER_LOCAL_ID]: [
        {
          productId: "999",
          title: "Secret",
          firstPurchasedAt: "2024-01-01T00:00:00.000Z",
          lastPurchasedAt: "2024-01-01T00:00:00.000Z",
          purchaseCount: 1,
        },
      ],
    },
    favourites: {
      [LOCAL_CUSTOMER_ID]: [{ productId: "200", addedAt: "2024-02-01T00:00:00.000Z" }],
    },
    wishlist: { [LOCAL_CUSTOMER_ID]: ["300"], [OTHER_LOCAL_ID]: ["888"] },
    recentlyViewed: {
      [LOCAL_CUSTOMER_ID]: [{ productId: "500", viewedAt: "2024-03-01T00:00:00.000Z" }],
    },
    suggestions: { [LOCAL_CUSTOMER_ID]: ["600"] },
    tierChanges: {
      [LOCAL_CUSTOMER_ID]: [
        { fromTier: "bronze", toTier: "silver", at: "2024-02-15T00:00:00.000Z", reason: "order" },
      ],
    },
  });
}

function buildApp(
  fragranceProfileDataSource: FragranceProfileDataSource,
  portalVisitRecorder?: PortalVisitRecorder,
): FastifyInstance {
  const app = Fastify({ logger: false });
  registerVersioning(app);
  app.register(v1Routes, {
    prefix: "/v1",
    customerResolver: new InMemoryCustomerResolver({ [SHOPIFY_CUSTOMER_ID]: LOCAL_CUSTOMER_ID }),
    tokenVerifier: new FakeTokenVerifier({ [BEARER_TOKEN]: SHOPIFY_CUSTOMER_ID }),
    appProxySecret: APP_PROXY_SECRET,
    fragranceProfileDataSource,
    portalVisitRecorder,
  });
  return app;
}

function signedQuery(params: QueryParams, extra: Record<string, string> = {}): string {
  const signable = { ...params, ...extra };
  const withSig = { ...signable, signature: computeAppProxySignature(signable, APP_PROXY_SECRET) };
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(withSig)) {
    if (typeof value === "string") {
      search.set(key, value);
    }
  }
  return search.toString();
}

describe("GET /v1/profile (Req 17.1, 17.2, 17.4, 17.5, 17.6, 17.8, 17.10)", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = buildApp(seededSource());
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it("returns the composed profile for an authenticated customer", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/profile",
      headers: { authorization: `Bearer ${BEARER_TOKEN}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.customerId).toBe(LOCAL_CUSTOMER_ID);
    expect(body.purchasedFragrances.map((p: { productId: string }) => p.productId)).toEqual(["100"]);
    expect(body.favourites).toEqual(["200"]);
    expect(body.wishlist).toEqual(["300"]);
    expect(body.recentlyViewed.map((r: { productId: string }) => r.productId)).toEqual(["500"]);
    expect(body.suggestions).toEqual(["600"]);
    // Chronological: purchase 01-01, favourite 02-01, tier change 02-15.
    expect(body.journey.map((m: { type: string }) => m.type)).toEqual([
      "first_purchase",
      "favourite_added",
      "tier_change",
    ]);
  });

  it("returns empty categories (not an error) for a customer with no data (Req 17.9)", async () => {
    const emptyApp = buildApp(new InMemoryFragranceProfileDataSource());
    await emptyApp.ready();

    const res = await emptyApp.inject({
      method: "GET",
      url: "/v1/profile",
      headers: { authorization: `Bearer ${BEARER_TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.purchasedFragrances).toEqual([]);
    expect(body.favourites).toEqual([]);
    expect(body.wishlist).toEqual([]);
    expect(body.recentlyViewed).toEqual([]);
    expect(body.suggestions).toEqual([]);
    expect(body.journey).toEqual([]);

    await emptyApp.close();
  });

  it("returns identical data via App Proxy and Customer Account API identity (Req 17.10)", async () => {
    const bearerRes = await app.inject({
      method: "GET",
      url: "/v1/profile",
      headers: { authorization: `Bearer ${BEARER_TOKEN}` },
    });

    const qs = signedQuery({
      shop: "myathoorlondon.myshopify.com",
      logged_in_customer_id: SHOPIFY_CUSTOMER_ID,
      path_prefix: "/apps/loyalty",
      timestamp: String(Math.floor(Date.now() / 1000)),
    });
    const proxyRes = await app.inject({ method: "GET", url: `/v1/profile?${qs}` });

    expect(bearerRes.statusCode).toBe(200);
    expect(proxyRes.statusCode).toBe(200);
    expect(proxyRes.json()).toEqual(bearerRes.json());
  });

  it("rejects an unauthenticated request before the handler runs (Req 9.3)", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/profile" });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: "identity_resolution_failed" });
  });
});

describe("GET /v1/profile/journey (Req 17.8, 17.9)", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = buildApp(seededSource());
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it("returns the chronological journey milestones", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/profile/journey",
      headers: { authorization: `Bearer ${BEARER_TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // Chronological: purchase 01-01, favourite 02-01, tier change 02-15.
    expect(body.milestones.map((m: { type: string }) => m.type)).toEqual([
      "first_purchase",
      "favourite_added",
      "tier_change",
    ]);
    const times = body.milestones.map((m: { at: string }) => Date.parse(m.at));
    expect(times).toEqual([...times].sort((a: number, b: number) => a - b));
  });

  it("returns an empty milestone list (not an error) for a customer with no history (Req 17.9)", async () => {
    const emptyApp = buildApp(new InMemoryFragranceProfileDataSource());
    await emptyApp.ready();

    const res = await emptyApp.inject({
      method: "GET",
      url: "/v1/profile/journey",
      headers: { authorization: `Bearer ${BEARER_TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().milestones).toEqual([]);

    await emptyApp.close();
  });

  it("rejects an unauthenticated request (Req 9.3)", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/profile/journey" });
    expect(res.statusCode).toBe(401);
  });
});

describe("POST /v1/profile/visit (Req 16.1, 16.2)", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    // A shared in-memory recorder so first-vs-returning persists across calls.
    app = buildApp(new InMemoryFragranceProfileDataSource(), new InMemoryPortalVisitRecorder());
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it("reports firstVisit=true on the first visit and false thereafter (Req 16.1/16.2)", async () => {
    const first = await app.inject({
      method: "POST",
      url: "/v1/profile/visit",
      headers: { authorization: `Bearer ${BEARER_TOKEN}`, "idempotency-key": "visit-key-1" },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toMatchObject({ firstVisit: true });

    // A distinct page load sends a distinct key, so this is a fresh operation.
    const second = await app.inject({
      method: "POST",
      url: "/v1/profile/visit",
      headers: { authorization: `Bearer ${BEARER_TOKEN}`, "idempotency-key": "visit-key-2" },
    });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ firstVisit: false });
  });

  it("replays the stored result for a repeated idempotency key without re-recording (Req 9.6)", async () => {
    const first = await app.inject({
      method: "POST",
      url: "/v1/profile/visit",
      headers: { authorization: `Bearer ${BEARER_TOKEN}`, "idempotency-key": "same-key" },
    });
    expect(first.json()).toMatchObject({ firstVisit: true });

    // Same key within the window replays verbatim — still firstVisit=true.
    const replay = await app.inject({
      method: "POST",
      url: "/v1/profile/visit",
      headers: { authorization: `Bearer ${BEARER_TOKEN}`, "idempotency-key": "same-key" },
    });
    expect(replay.json()).toMatchObject({ firstVisit: true });
    expect(replay.headers["idempotent-replay"]).toBe("true");
  });

  it("rejects a state-changing visit with no idempotency key (Req 9.7)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/profile/visit",
      headers: { authorization: `Bearer ${BEARER_TOKEN}` },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "invalid_idempotency_key" });
  });

  it("rejects an unauthenticated visit before recording anything (Req 9.3)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/profile/visit",
      headers: { "idempotency-key": "visit-key-anon" },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: "identity_resolution_failed" });
  });

  it("returns identical shape via App Proxy identity (Req 16.1)", async () => {
    const qs = signedQuery({
      shop: "myathoorlondon.myshopify.com",
      logged_in_customer_id: SHOPIFY_CUSTOMER_ID,
      path_prefix: "/apps/loyalty",
      timestamp: String(Math.floor(Date.now() / 1000)),
    });
    const res = await app.inject({
      method: "POST",
      url: `/v1/profile/visit?${qs}`,
      headers: { "idempotency-key": "visit-proxy-1" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ firstVisit: true });
  });
});
