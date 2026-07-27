/**
 * VIP benefits — RUNTIME PATH integration test (task 30).
 *
 * WHY THIS FILE EXISTS SEPARATELY FROM `routes/benefits.test.ts`: the route tests
 * mount the benefit routes directly. That would still pass if `buildApp` failed
 * to forward the resolver — which is precisely the class of gap that left
 * Requirement 18 unreachable for four phases. This test therefore drives
 * **signed App Proxy requests through the FULL `buildApp` application**, so the
 * whole production chain is exercised: App Proxy signature verification →
 * identity resolution to a local `customers.id` → the idempotency gate on the
 * POST → the `/v1` router → the real `DbEntitlementResolver` → SQL.
 *
 * If any link is missing the requests 401/404 instead of answering, so this test
 * is the standing proof that the benefit surface is genuinely reachable rather
 * than merely implemented.
 *
 * Also asserted here because they are properties of the WIRED app, not of a
 * route in isolation:
 *   - `GET /v1/balance` carries the qualifying benefits (Req 18.2);
 *   - the POST is subject to the scope-level `Idempotency-Key` contract
 *     (Req 9.6/9.7) — a missing key is refused and a repeated key replays without
 *     recording a second `benefit_requests` row;
 *   - an unauthenticated/unsigned request reaches no resolver at all (Req 11.4).
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
import { InMemoryCustomerBalanceSource } from "./routes/balance.js";
import { DbEntitlementResolver } from "./benefits/entitlementResolver.js";
import type { Queryable } from "./ledger/repository.js";

const APP_PROXY_SECRET = "app-proxy-shared-secret";
const SHOPIFY_CUSTOMER_ID = "987654321";
const LOCAL_CUSTOMER_ID = "11111111-1111-4111-8111-111111111111";

function signedQuery(params: QueryParams): string {
  const withSig = { ...params, signature: computeAppProxySignature(params, APP_PROXY_SECRET) };
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(withSig)) {
    if (typeof value === "string") search.set(key, value);
  }
  return search.toString();
}

function proxyUrl(path: string): string {
  return `${path}?${signedQuery({
    shop: "myathoorlondon.myshopify.com",
    logged_in_customer_id: SHOPIFY_CUSTOMER_ID,
    path_prefix: "/apps/loyalty",
    timestamp: "1700000000",
  })}`;
}

/** Answers the SQL the real resolver issues; records every write. */
class FakeDb implements Queryable {
  readonly requests: Array<{ customer_id: string; benefit_id: string }> = [];
  constructor(
    private readonly spend: number,
    private readonly benefits: Array<{
      id: string;
      key: string;
      name: string;
      min_qualifying_tier: string;
      config: Record<string, unknown>;
      active: boolean;
    }>,
  ) {}

  async query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values: unknown[] = [],
  ): Promise<QueryResult<R>> {
    const ok = (rows: QueryResultRow[], command = "SELECT"): QueryResult<R> => ({
      rows: rows as R[],
      rowCount: rows.length,
      command,
      oid: 0,
      fields: [],
    });
    if (text.includes("FROM customers")) {
      return ok(
        (values[0] as string) === LOCAL_CUSTOMER_ID
          ? [{ lifetime_spend_gbp: this.spend, tier: null }]
          : [],
      );
    }
    if (text.includes("FROM benefits") && text.includes("active = true")) {
      return ok(this.benefits.filter((b) => b.active));
    }
    if (text.includes("FROM benefits") && text.includes("key = $1")) {
      const row = this.benefits.find((b) => b.key === values[0]);
      return ok(row ? [row] : []);
    }
    if (text.includes("INSERT INTO benefit_requests")) {
      this.requests.push({ customer_id: values[0] as string, benefit_id: values[1] as string });
      return ok(
        [
          {
            id: `req-${this.requests.length}`,
            customer_id: values[0],
            benefit_id: values[1],
            status: "requested",
            requested_at: new Date("2026-07-27T00:00:00Z"),
          },
        ],
        "INSERT",
      );
    }
    throw new Error(`Unexpected query: ${text}`);
  }
}

const benefit = (
  key: string,
  minTier: string,
  active = true,
  config: Record<string, unknown> = {},
) => ({ id: `b-${key}`, key, name: key, min_qualifying_tier: minTier, config, active });

describe("the VIP benefit surface is reachable through the wired app (task 30)", () => {
  let app: FastifyInstance;
  let db: FakeDb;

  beforeEach(async () => {
    const config = loadConfig({ NODE_ENV: "test", SHOPIFY_APP_PROXY_SECRET: APP_PROXY_SECRET });
    // £1600 lifetime spend → royal_vip, derived by the resolver from this row.
    db = new FakeDb(1600, [
      benefit("welcome_note", "bronze"),
      benefit("silver_perk", "silver"),
      benefit("private_consultation", "royal_vip"),
      benefit("roadmap_perk", "royal_vip", false),
    ]);
    app = buildApp(config, {
      customerResolver: new InMemoryCustomerResolver({ [SHOPIFY_CUSTOMER_ID]: LOCAL_CUSTOMER_ID }),
      balanceSource: new InMemoryCustomerBalanceSource({
        [LOCAL_CUSTOMER_ID]: { lifetimeSpendGBP: 1600, tier: "royal_vip", spendableBalance: 900 },
      }),
      entitlementResolver: new DbEntitlementResolver(db),
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it("serves GET /v1/benefits over a signed App Proxy request", async () => {
    const res = await app.inject({ method: "GET", url: proxyUrl("/v1/benefits") });

    expect(res.statusCode).toBe(200);
    const keys = (res.json().benefits as Array<{ key: string }>).map((b) => b.key).sort();
    // Every active benefit at or below royal_vip; the disabled one is absent.
    expect(keys).toEqual(["private_consultation", "silver_perk", "welcome_note"]);
    expect(res.json().apiVersion).toBe("v1");
  });

  it("includes the same benefits in GET /v1/balance (Req 18.2)", async () => {
    const balance = await app.inject({ method: "GET", url: proxyUrl("/v1/balance") });
    const benefits = await app.inject({ method: "GET", url: proxyUrl("/v1/benefits") });

    expect(balance.statusCode).toBe(200);
    expect(balance.json().benefits).toEqual(benefits.json().benefits);
    expect(balance.json().spendableBalance).toBe(900);
  });

  it("records a benefit request through the full chain, attributed to the resolved customer", async () => {
    const res = await app.inject({
      method: "POST",
      url: proxyUrl("/v1/benefits/private_consultation/request"),
      headers: { "Idempotency-Key": "bench-1" },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ benefitKey: "private_consultation", status: "requested" });
    expect(db.requests).toEqual([
      { customer_id: LOCAL_CUSTOMER_ID, benefit_id: "b-private_consultation" },
    ]);
  });

  it("is subject to the /v1 idempotency contract: a missing key is refused (Req 9.6)", async () => {
    const res = await app.inject({
      method: "POST",
      url: proxyUrl("/v1/benefits/private_consultation/request"),
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_idempotency_key");
    expect(db.requests).toEqual([]);
  });

  it("replays a repeated Idempotency-Key without recording a second request (Req 9.7)", async () => {
    const url = proxyUrl("/v1/benefits/private_consultation/request");
    const first = await app.inject({ method: "POST", url, headers: { "Idempotency-Key": "same" } });
    const second = await app.inject({ method: "POST", url, headers: { "Idempotency-Key": "same" } });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.headers["idempotent-replay"]).toBe("true");
    expect(second.body).toBe(first.body);
    // The handler did not run again: still exactly one recorded request.
    expect(db.requests).toHaveLength(1);
  });

  it("refuses a benefit the tier does not reach, reporting the required tier (Req 18.6)", async () => {
    const config = loadConfig({ NODE_ENV: "test", SHOPIFY_APP_PROXY_SECRET: APP_PROXY_SECRET });
    const bronzeDb = new FakeDb(0, [benefit("private_consultation", "royal_vip")]);
    const bronzeApp = buildApp(config, {
      customerResolver: new InMemoryCustomerResolver({ [SHOPIFY_CUSTOMER_ID]: LOCAL_CUSTOMER_ID }),
      entitlementResolver: new DbEntitlementResolver(bronzeDb),
    });
    await bronzeApp.ready();

    const res = await bronzeApp.inject({
      method: "POST",
      url: proxyUrl("/v1/benefits/private_consultation/request"),
      headers: { "Idempotency-Key": "bronze-attempt" },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ requiredTier: "royal_vip", currentTier: "bronze" });
    expect(bronzeDb.requests).toEqual([]);
    await bronzeApp.close();
  });

  it("reaches no resolver at all on an UNSIGNED request (Req 11.4)", async () => {
    const get = await app.inject({ method: "GET", url: "/v1/benefits" });
    const post = await app.inject({
      method: "POST",
      url: "/v1/benefits/private_consultation/request",
      headers: { "Idempotency-Key": "unsigned" },
    });

    expect(get.statusCode).toBe(401);
    expect(post.statusCode).toBe(401);
    expect(db.requests).toEqual([]);
  });

  it("does not register the benefit routes when no resolver is wired", async () => {
    const config = loadConfig({ NODE_ENV: "test", SHOPIFY_APP_PROXY_SECRET: APP_PROXY_SECRET });
    const bare = buildApp(config, {
      customerResolver: new InMemoryCustomerResolver({ [SHOPIFY_CUSTOMER_ID]: LOCAL_CUSTOMER_ID }),
      balanceSource: new InMemoryCustomerBalanceSource({
        [LOCAL_CUSTOMER_ID]: { lifetimeSpendGBP: 1600, tier: "royal_vip", spendableBalance: 900 },
      }),
    });
    await bare.ready();

    const res = await bare.inject({ method: "GET", url: proxyUrl("/v1/benefits") });
    const balance = await bare.inject({ method: "GET", url: proxyUrl("/v1/balance") });

    expect(res.statusCode).toBe(404);
    // And the balance body is exactly the pre-task-30 shape.
    expect("benefits" in balance.json()).toBe(false);
    await bare.close();
  });
});
