/**
 * Regression test for the wiring defect that made lazy enrollment unreachable in
 * production while `/health` reported it as live.
 *
 * WHAT HAPPENED
 * -------------
 * `index.ts` cannot construct the enrollment gate until AFTER `buildApp` returns,
 * because the gate wants the app's logger for its failure hook. So it passes a
 * GETTER over a variable it assigns a moment later:
 *
 *     let lazyEnroller: LazyEnrollmentGate | undefined;
 *     const app = buildApp(config, { get lazyEnroller() { return lazyEnroller; } });
 *     ...
 *     lazyEnroller = new LazyEnrollmentGate({ ... });   // assigned here
 *
 * `app.ts` forwarded that property into the `/v1` router's options with a plain
 * read, which EVALUATED the getter during `buildApp` — while it still returned
 * `undefined`. That `undefined` was captured in the router options and handed to
 * `registerAuth`, so the auth plugin held no enroller for the life of the
 * process, whatever was assigned afterwards.
 *
 * WHY IT SURVIVED REVIEW AND TESTS
 * --------------------------------
 * Every existing test passes the enroller as a plain object, so the getter's
 * timing never came into play and all of them passed. And `/health` read the SAME
 * property from inside a request handler — where the getter does return the real
 * gate — so the service cheerfully reported `lazyEnrollerWired: true` while auth
 * had `undefined`. Two honest answers about different instants, and nothing
 * compared them. Production therefore showed a flag switched on, a health check
 * confirming it, and customers still receiving 401 `identity_resolution_failed`.
 *
 * These tests reproduce the DEFERRED ASSIGNMENT specifically, because that timing
 * is the whole defect — a test using a plain object cannot fail on it.
 */
import { describe, expect, it } from "vitest";
import { buildApp } from "../app.js";
import { loadConfig } from "../config.js";
import { computeAppProxySignature, type QueryParams } from "../auth/appProxy.js";
import { InMemoryCustomerResolver } from "../auth/identity.js";
import type { VerifiedCustomerEnroller } from "../enrollment/ensureCustomerEnrollment.js";
import type { AuthChainCountersSnapshot } from "./authChainCounters.js";

const SECRET = "app-proxy-shared-secret";
const CUSTOMER_A = "9395357876563"; // shape of the real deferred-cohort customer

function signedQuery(params: QueryParams): string {
  const withSignature = { ...params, signature: computeAppProxySignature(params, SECRET) };
  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(withSignature)) {
    if (typeof v === "string") search.set(k, v);
  }
  return search.toString();
}

/**
 * Builds the app EXACTLY as `index.ts` does: the dependency is exposed through a
 * getter that returns `undefined` at build time, and the real collaborator is
 * assigned only afterwards.
 */
function buildWithDeferredEnroller() {
  const config = loadConfig({
    NODE_ENV: "test",
    SHOPIFY_SHOP_DOMAIN: "myathoorlondon.myshopify.com",
    SHOPIFY_APP_PROXY_SECRET: SECRET,
    ENROLLMENT_LAZY_FALLBACK_ENABLED: "true",
  } as NodeJS.ProcessEnv);

  let deferred: VerifiedCustomerEnroller | undefined;
  let enrollCalls = 0;

  const app = buildApp(config, {
    customerResolver: new InMemoryCustomerResolver({}),
    get lazyEnroller() {
      return deferred;
    },
  });

  // The assignment `index.ts` performs after buildApp returns.
  const assignEnroller = () => {
    deferred = {
      async enrollVerifiedCustomer() {
        enrollCalls += 1;
        return "local-new";
      },
    };
  };

  return { app, assignEnroller, calls: () => enrollCalls };
}

async function authChainOf(app: ReturnType<typeof buildApp>): Promise<AuthChainCountersSnapshot> {
  const res = await app.inject({ method: "GET", url: "/health" });
  return (res.json() as { authChain: AuthChainCountersSnapshot }).authChain;
}

describe("an enroller assigned after buildApp still reaches the auth plugin", () => {
  it("attempts enrollment and resolves — the production path that used to 401", async () => {
    const { app, assignEnroller, calls } = buildWithDeferredEnroller();
    assignEnroller();
    try {
      const res = await app.inject({
        method: "GET",
        url: `/v1/balance?${signedQuery({ shop: "athoor", logged_in_customer_id: CUSTOMER_A })}`,
      });

      // BEFORE THE FIX this was 401 with `no_local_row_fallback_not_wired`,
      // because auth had captured `undefined` during buildApp.
      expect(res.statusCode).not.toBe(401);
      expect(calls()).toBe(1);
      expect((await authChainOf(app)).stopPoints).toEqual({ resolved_via_enrollment: 1 });
    } finally {
      await app.close();
    }
  });

  it("/health and the auth plugin cannot disagree about whether the fallback is live", async () => {
    // THE CORE INVARIANT. The defect was not just "unwired" — it was `/health`
    // reporting wired while auth held undefined, which is what made the
    // production symptom unattributable.
    const { app, assignEnroller } = buildWithDeferredEnroller();
    assignEnroller();
    try {
      const health = await app.inject({ method: "GET", url: "/health" });
      const runtime = (health.json() as { runtime: { lazyEnrollerWired: boolean } }).runtime;
      expect(runtime.lazyEnrollerWired).toBe(true);

      const res = await app.inject({
        method: "GET",
        url: `/v1/balance?${signedQuery({ shop: "athoor", logged_in_customer_id: CUSTOMER_A })}`,
      });

      // If /health claims wired, the chain must NOT report the fallback missing.
      const stopPoints = (await authChainOf(app)).stopPoints;
      expect(stopPoints.no_local_row_fallback_not_wired ?? 0).toBe(0);
      expect(res.statusCode).not.toBe(401);
    } finally {
      await app.close();
    }
  });

  it("reports the fallback as missing while it genuinely is, and recovers once assigned", async () => {
    // The lookup must be live in BOTH directions: an honest `false` before
    // assignment, and a real enroller after. A fix that simply hardcoded `true`
    // would pass the tests above and fail this one.
    const { app, assignEnroller } = buildWithDeferredEnroller();
    try {
      const before = await app.inject({
        method: "GET",
        url: `/v1/balance?${signedQuery({ shop: "athoor", logged_in_customer_id: CUSTOMER_A })}`,
      });
      expect(before.statusCode).toBe(401);
      expect((await authChainOf(app)).stopPoints).toEqual({
        no_local_row_fallback_not_wired: 1,
      });

      assignEnroller();

      const after = await app.inject({
        method: "GET",
        url: `/v1/balance?${signedQuery({ shop: "athoor", logged_in_customer_id: CUSTOMER_A })}`,
      });
      expect(after.statusCode).not.toBe(401);
      expect((await authChainOf(app)).stopPoints).toEqual({
        no_local_row_fallback_not_wired: 1,
        resolved_via_enrollment: 1,
      });
    } finally {
      await app.close();
    }
  });

  it("still accepts a plain enroller object, so existing call sites keep working", async () => {
    const config = loadConfig({
      NODE_ENV: "test",
      SHOPIFY_SHOP_DOMAIN: "myathoorlondon.myshopify.com",
      SHOPIFY_APP_PROXY_SECRET: SECRET,
    } as NodeJS.ProcessEnv);
    const app = buildApp(config, {
      customerResolver: new InMemoryCustomerResolver({}),
      lazyEnroller: {
        async enrollVerifiedCustomer() {
          return "local-new";
        },
      },
    });
    try {
      const res = await app.inject({
        method: "GET",
        url: `/v1/balance?${signedQuery({ shop: "athoor", logged_in_customer_id: CUSTOMER_A })}`,
      });
      expect(res.statusCode).not.toBe(401);
    } finally {
      await app.close();
    }
  });
});
