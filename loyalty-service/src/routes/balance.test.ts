/**
 * Tests for `GET /v1/balance` (task 6.3, Requirements 7.5, 7.6, 8.5).
 *
 * Two layers:
 *   1. Unit tests for the pure {@link buildBalanceSummary} — verifies the
 *      response carries spendable balance, tier + multiplier, lifetime spend to
 *      2dp, progress-to-next-tier (or top-tier indicator), and the available
 *      rewards.
 *   2. HTTP tests through a real Fastify app wired with the actual `/v1` auth
 *      layer — verifies an authenticated request returns the summary, that a
 *      not-yet-known customer yields 404, and (the key property of task 6.3)
 *      that the SAME local customer yields byte-identical data whether the
 *      request arrives via App Proxy (web) or a Customer Account API bearer
 *      token (mobile/portal).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { registerVersioning } from "../plugins/versioning.js";
import { v1Routes } from "./v1.js";
import {
  InMemoryCustomerResolver,
  FakeTokenVerifier,
} from "../auth/identity.js";
import { computeAppProxySignature, type QueryParams } from "../auth/appProxy.js";
import { REWARD_CATALOG } from "../rewards/catalog.js";
import {
  buildBalanceSummary,
  InMemoryCustomerBalanceSource,
  type CustomerBalanceSnapshot,
} from "./balance.js";

describe("buildBalanceSummary (Req 7.5/7.6/8.5)", () => {
  it("returns spendable balance, tier + progress, and available rewards for a mid-tier customer", () => {
    // £450 lifetime → Silver (£300–749.99); next tier Gold at £750 → £300 to go.
    const snapshot: CustomerBalanceSnapshot = {
      lifetimeSpendGBP: 450,
      tier: "silver",
      spendableBalance: 275,
    };

    const summary = buildBalanceSummary(snapshot);

    expect(summary).toMatchObject({
      spendableBalance: 275,
      tier: "silver",
      tierMultiplier: 1.5,
      lifetimeSpendGBP: 450,
      isTopTier: false,
      nextTier: "gold",
      nextTierThresholdGBP: 750,
      progressToNextTierGBP: 300,
    });
    // Available rewards are exactly the four-entry catalog (Req 8.5).
    expect(summary.availableRewards).toEqual(REWARD_CATALOG);
  });

  it("reports a top-tier indicator (null progress) for Royal_VIP (Req 7.6)", () => {
    const snapshot: CustomerBalanceSnapshot = {
      lifetimeSpendGBP: 2000,
      tier: "royal_vip",
      spendableBalance: 1000,
    };

    const summary = buildBalanceSummary(snapshot);

    expect(summary).toMatchObject({
      tier: "royal_vip",
      tierMultiplier: 3,
      isTopTier: true,
      nextTier: null,
      nextTierThresholdGBP: null,
      progressToNextTierGBP: null,
    });
  });

  it("never reports below the retained tier and rounds lifetime spend to 2dp (Req 7.3/7.5)", () => {
    // Retained Gold but spend only £100 (Bronze band) → summary keeps Gold.
    const snapshot: CustomerBalanceSnapshot = {
      lifetimeSpendGBP: 100.005,
      tier: "gold",
      spendableBalance: 0,
    };

    const summary = buildBalanceSummary(snapshot);

    expect(summary.tier).toBe("gold");
    expect(summary.lifetimeSpendGBP).toBe(100.01);
  });

  it("defaults an unknown/null tier to Bronze (Req 7.4)", () => {
    const summary = buildBalanceSummary({ lifetimeSpendGBP: 0, tier: null, spendableBalance: 0 });
    expect(summary).toMatchObject({
      tier: "bronze",
      tierMultiplier: 1,
      nextTier: "silver",
      progressToNextTierGBP: 300,
    });
  });
});

const APP_PROXY_SECRET = "app-proxy-shared-secret";
const SHOPIFY_CUSTOMER_ID = "987654321";
const LOCAL_CUSTOMER_ID = "11111111-1111-4111-8111-111111111111";
const BEARER_TOKEN = "valid-caa-token";

/** Builds a `/v1`-mounted app wired with the real auth layer and a fake balance source. */
function buildApp(): FastifyInstance {
  const app = Fastify({ logger: false });
  registerVersioning(app);

  const customerResolver = new InMemoryCustomerResolver({ [SHOPIFY_CUSTOMER_ID]: LOCAL_CUSTOMER_ID });
  const tokenVerifier = new FakeTokenVerifier({ [BEARER_TOKEN]: SHOPIFY_CUSTOMER_ID });
  const balanceSource = new InMemoryCustomerBalanceSource({
    [LOCAL_CUSTOMER_ID]: { lifetimeSpendGBP: 450, tier: "silver", spendableBalance: 275 },
  });

  app.register(v1Routes, {
    prefix: "/v1",
    customerResolver,
    tokenVerifier,
    appProxySecret: APP_PROXY_SECRET,
    balanceSource,
  });

  return app;
}

/** Build the query string for a validly signed App Proxy request. */
function signedQuery(params: QueryParams): string {
  // NB-13: every App Proxy request Shopify signs carries a `timestamp`, and the
  // auth layer now enforces a +/-5 minute freshness window and FAILS CLOSED when it
  // is absent. Defaulting it here keeps fixtures realistic; an explicit timestamp in
  // `params` still wins, so a staleness test can override it.
  const withTimestamp = { timestamp: String(Math.floor(Date.now() / 1000)), ...params };
  const withSig = { ...withTimestamp, signature: computeAppProxySignature(withTimestamp, APP_PROXY_SECRET) };
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(withSig)) {
    if (typeof value === "string") {
      search.set(key, value);
    }
  }
  return search.toString();
}

describe("GET /v1/balance (Req 7.5/7.6/8.5, 9.2/9.3)", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = buildApp();
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it("returns spendable balance, tier, progress, and rewards for an authenticated customer", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/v1/balance",
      headers: { authorization: `Bearer ${BEARER_TOKEN}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({
      spendableBalance: 275,
      tier: "silver",
      tierMultiplier: 1.5,
      lifetimeSpendGBP: 450,
      isTopTier: false,
      nextTier: "gold",
      nextTierThresholdGBP: 750,
      progressToNextTierGBP: 300,
    });
    expect(body.availableRewards).toEqual(REWARD_CATALOG);
  });

  it("returns identical data via App Proxy and Customer Account API identity (Req 8.5, 9.2)", async () => {
    const bearerRes = await app.inject({
      method: "GET",
      url: "/v1/balance",
      headers: { authorization: `Bearer ${BEARER_TOKEN}` },
    });

    const qs = signedQuery({
      shop: "myathoorlondon.myshopify.com",
      logged_in_customer_id: SHOPIFY_CUSTOMER_ID,
      path_prefix: "/apps/loyalty",
      timestamp: String(Math.floor(Date.now() / 1000)),
    });
    const proxyRes = await app.inject({ method: "GET", url: `/v1/balance?${qs}` });

    expect(bearerRes.statusCode).toBe(200);
    expect(proxyRes.statusCode).toBe(200);
    // The loyalty payload must be identical regardless of identity source.
    expect(proxyRes.json()).toEqual(bearerRes.json());
  });

  it("rejects an unauthenticated request before the handler runs (Req 9.3)", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/balance" });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: "identity_resolution_failed" });
  });

  it("returns 404 when the resolved customer has no loyalty row", async () => {
    // Resolve to a local id the balance source does not know.
    const app2 = Fastify({ logger: false });
    registerVersioning(app2);
    app2.register(v1Routes, {
      prefix: "/v1",
      customerResolver: new InMemoryCustomerResolver({ [SHOPIFY_CUSTOMER_ID]: "unknown-local-id" }),
      tokenVerifier: new FakeTokenVerifier({ [BEARER_TOKEN]: SHOPIFY_CUSTOMER_ID }),
      appProxySecret: APP_PROXY_SECRET,
      balanceSource: new InMemoryCustomerBalanceSource(),
    });
    await app2.ready();

    const res = await app2.inject({
      method: "GET",
      url: "/v1/balance",
      headers: { authorization: `Bearer ${BEARER_TOKEN}` },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: "customer_not_found" });

    await app2.close();
  });
});
