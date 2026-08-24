/**
 * GAP 1 wiring regression: `buildApp` must FORWARD the injected customer data
 * sources into the `/v1` router so authenticated consumer endpoints serve real
 * data instead of failing closed.
 *
 * `V1RouterOptions` already accepted `balanceSource`/`historySource`, but
 * `buildApp`/`AppDependencies` previously did not forward them. This test drives
 * a signed App Proxy request through the FULL `buildApp` app (not `v1Routes`
 * directly) and asserts the injected `balanceSource` and `historySource` are
 * reached — proving the additive forwarding is in place.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { InMemoryCustomerResolver } from "./auth/identity.js";
import { computeAppProxySignature, type QueryParams } from "./auth/appProxy.js";
import { InMemoryCustomerBalanceSource } from "./routes/balance.js";
import { InMemoryLedgerHistorySource, type RawHistoryEntry } from "./routes/history.js";

const APP_PROXY_SECRET = "app-proxy-shared-secret";
const SHOPIFY_CUSTOMER_ID = "987654321";
const LOCAL_CUSTOMER_ID = "11111111-1111-4111-8111-111111111111";

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

function proxyUrl(path: string): string {
  const qs = signedQuery({
    shop: "myathoorlondon.myshopify.com",
    logged_in_customer_id: SHOPIFY_CUSTOMER_ID,
    path_prefix: "/apps/loyalty",
    timestamp: String(Math.floor(Date.now() / 1000)),
  });
  return `${path}?${qs}`;
}

describe("buildApp forwards the injected customer sources into /v1 (GAP 1)", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    const config = loadConfig({ NODE_ENV: "test", SHOPIFY_APP_PROXY_SECRET: APP_PROXY_SECRET });

    const balanceSource = new InMemoryCustomerBalanceSource({
      [LOCAL_CUSTOMER_ID]: { lifetimeSpendGBP: 450, tier: "silver", spendableBalance: 275 },
    });
    const historyEntries: RawHistoryEntry[] = [
      {
        id: "led-1",
        entryType: "earn_order",
        points: 120,
        reason: "order",
        orderReference: 5001,
        createdAt: new Date("2024-01-02T00:00:00.000Z"),
      },
    ];
    const historySource = new InMemoryLedgerHistorySource({ [LOCAL_CUSTOMER_ID]: historyEntries });

    app = buildApp(config, {
      customerResolver: new InMemoryCustomerResolver({ [SHOPIFY_CUSTOMER_ID]: LOCAL_CUSTOMER_ID }),
      balanceSource,
      historySource,
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it("serves injected balance data on GET /v1/balance via a signed App Proxy request", async () => {
    const res = await app.inject({ method: "GET", url: proxyUrl("/v1/balance") });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      spendableBalance: 275,
      tier: "silver",
      lifetimeSpendGBP: 450,
    });
  });

  it("serves injected history data on GET /v1/history via a signed App Proxy request", async () => {
    const res = await app.inject({ method: "GET", url: proxyUrl("/v1/history") });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      entries: Array<{ type: string; points: number; orderReference: number | null }>;
      totalCount: number;
    };
    expect(body.totalCount).toBe(1);
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0]).toMatchObject({ type: "earned", points: 120, orderReference: 5001 });
  });

  it("still fails closed (404) for balance when NO source is injected", async () => {
    const config = loadConfig({ NODE_ENV: "test", SHOPIFY_APP_PROXY_SECRET: APP_PROXY_SECRET });
    const bare = buildApp(config, {
      customerResolver: new InMemoryCustomerResolver({ [SHOPIFY_CUSTOMER_ID]: LOCAL_CUSTOMER_ID }),
    });
    await bare.ready();
    const res = await bare.inject({ method: "GET", url: proxyUrl("/v1/balance") });
    expect(res.statusCode).toBe(404);
    await bare.close();
  });
});
