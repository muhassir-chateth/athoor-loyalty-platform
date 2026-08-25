/**
 * Proves `/health` publishes what the AUTH MIDDLEWARE actually recorded.
 *
 * WHY THIS EXISTS. The counters and the health route are correct in isolation and
 * still useless if they are not the same instance — `/health` would report a
 * permanent `gatedRequests: 0` while real requests failed, and the diagnosis
 * drawn from it would be "no requests are arriving", which is false and sends
 * the investigation to the wrong layer entirely. That shared-instance wiring is
 * the thing under test here, and it is exactly the kind of wiring the unit tests
 * for each piece cannot see.
 *
 * Uses the real `buildApp`, the real auth middleware and the real signing helper
 * against in-memory fakes — no Postgres, no Shopify, no network.
 */
import { describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { computeAppProxySignature, type QueryParams } from "../auth/appProxy.js";
import { InMemoryCustomerResolver } from "../auth/identity.js";
import type { AuthChainCountersSnapshot } from "./authChainCounters.js";

const SECRET = "app-proxy-shared-secret";
const CUSTOMER_A = "9395357876563"; // shape of the real deferred-cohort customer

function buildHarness(over: { knownCustomers?: Record<string, string>; lazy?: boolean } = {}) {
  const config = loadConfig({
    NODE_ENV: "test",
    SHOPIFY_SHOP_DOMAIN: "myathoorlondon.myshopify.com",
    SHOPIFY_APP_PROXY_SECRET: SECRET,
    ...(over.lazy ? { ENROLLMENT_LAZY_FALLBACK_ENABLED: "true" } : {}),
  } as NodeJS.ProcessEnv);

  return buildApp(config, {
    customerResolver: new InMemoryCustomerResolver(over.knownCustomers ?? {}),
    ...(over.lazy
      ? {
          lazyEnroller: {
            async enrollVerifiedCustomer() {
              return "local-new";
            },
          },
        }
      : {}),
  });
}

function signedQuery(params: QueryParams): string {
  // NB-13: every App Proxy request Shopify signs carries a `timestamp`, and the
  // auth layer now enforces a +/-5 minute freshness window and FAILS CLOSED when it
  // is absent. Defaulting it here keeps fixtures realistic; an explicit timestamp in
  // `params` still wins, so a staleness test can override it.
  const withTimestamp = { timestamp: String(Math.floor(Date.now() / 1000)), ...params };
  const withSignature = { ...withTimestamp, signature: computeAppProxySignature(withTimestamp, SECRET) };
  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(withSignature)) {
    if (typeof v === "string") search.set(k, v);
  }
  return search.toString();
}

async function readAuthChain(app: ReturnType<typeof buildApp>): Promise<AuthChainCountersSnapshot> {
  const res = await app.inject({ method: "GET", url: "/health" });
  expect(res.statusCode).toBe(200);
  const body = res.json() as { authChain?: AuthChainCountersSnapshot };
  expect(body.authChain, "/health did not publish an authChain block").toBeDefined();
  return body.authChain!;
}

describe("/health publishes the auth-chain tally the middleware recorded", () => {
  it("starts at zero and counts a verified request that carried no customer id", async () => {
    const app = buildHarness();
    try {
      expect((await readAuthChain(app)).gatedRequests).toBe(0);

      const res = await app.inject({
        method: "GET",
        url: `/v1/balance?${signedQuery({ shop: "athoor", path_prefix: "/apps/loyalty" })}`,
      });
      expect(res.statusCode).toBe(401);

      const snap = await readAuthChain(app);
      expect(snap.gatedRequests).toBe(1);
      expect(snap.stopPoints).toEqual({ verified_but_no_customer_id: 1 });
    } finally {
      await app.close();
    }
  });

  it("reports the fallback-not-wired stop point separately from a missing id", async () => {
    // The two production candidates must be distinguishable on /health alone,
    // since that is the whole reason this block exists.
    const app = buildHarness();
    try {
      const res = await app.inject({
        method: "GET",
        url: `/v1/balance?${signedQuery({ shop: "athoor", logged_in_customer_id: CUSTOMER_A })}`,
      });
      expect(res.statusCode).toBe(401);

      expect((await readAuthChain(app)).stopPoints).toEqual({
        no_local_row_fallback_not_wired: 1,
      });
    } finally {
      await app.close();
    }
  });

  it("reports a resolution via lazy enrollment when the fallback is wired", async () => {
    const app = buildHarness({ lazy: true });
    try {
      const res = await app.inject({
        method: "GET",
        url: `/v1/balance?${signedQuery({ shop: "athoor", logged_in_customer_id: CUSTOMER_A })}`,
      });
      expect(res.statusCode).not.toBe(401);

      expect((await readAuthChain(app)).stopPoints).toEqual({ resolved_via_enrollment: 1 });
    } finally {
      await app.close();
    }
  });

  it("does not count public routes, so the tally means 'gated requests'", async () => {
    const app = buildHarness();
    try {
      const rewards = await app.inject({ method: "GET", url: "/v1/rewards" });
      expect(rewards.statusCode).toBe(200);
      const version = await app.inject({ method: "GET", url: "/v1/version" });
      expect(version.statusCode).toBe(200);

      const snap = await readAuthChain(app);
      expect(snap.gatedRequests).toBe(0);
      expect(snap.stopPoints).toEqual({});
    } finally {
      await app.close();
    }
  });

  it("publishes no customer identifier alongside the tally", async () => {
    const app = buildHarness();
    try {
      await app.inject({
        method: "GET",
        url: `/v1/balance?${signedQuery({ shop: "athoor", logged_in_customer_id: CUSTOMER_A })}`,
      });

      const res = await app.inject({ method: "GET", url: "/health" });
      const serialised = JSON.stringify(res.json());
      expect(serialised).not.toContain(CUSTOMER_A);
      expect(serialised).not.toContain("6563");
      expect(serialised).not.toContain(SECRET);
    } finally {
      await app.close();
    }
  });
});
