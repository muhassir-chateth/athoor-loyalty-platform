/**
 * ROUTE CENSUS — the contract test that makes forgetting customer scoping fail.
 *
 * WHY THIS EXISTS
 * ---------------
 * Task 5.1 made a verified `CustomerScope` the only way to name a customer, and
 * 5.2 collapsed nineteen hand-written guards onto one scope-level handler. Both
 * are compile-time guarantees about code that EXISTS. Neither says anything about
 * a route added next month that quietly reads its own id, or one registered
 * outside the `/v1` auth scope. This test closes that: it enumerates whatever
 * Fastify actually registered and drives every protected route through three
 * unauthorised scenarios. A new endpoint is included automatically, so forgetting
 * to scope it fails an EXISTING test rather than needing a new one.
 *
 * TWO SUBTLETIES THAT MAKE OR BREAK THE COVERAGE
 * ----------------------------------------------
 * 1. ROUTES ARE CONDITIONALLY REGISTERED. `/v1/referral` needs `referralDeps`,
 *    `/v1/benefits` needs `entitlementResolver`, the favourites/wishlist routes
 *    need `preferenceStore`, `/v1/profile/recently-viewed` needs
 *    `recentlyViewedRecorder`. Building the app with `{}` registers 33 routes and
 *    silently omits nine of the most sensitive ones — a census that did that would
 *    pass while testing nothing about them. So the app is built with a FULL
 *    dependency set, and {@link REQUIRED_PRESENT} asserts the gated routes really
 *    did register, so a future wiring regression that drops them fails here too.
 *
 * 2. `onRoute` MUST BE INSTALLED BEFORE `ready()`. `buildApp` registers the `/v1`
 *    router with `app.register`, which Fastify defers until `ready()`. Adding the
 *    hook to the returned instance before awaiting `ready()` therefore observes
 *    every route with its FULL prefixed URL. Parsing `printRoutes()` was the
 *    alternative and was rejected: it emits a nested tree whose children are
 *    relative to their parent, so reassembling paths is exactly the kind of
 *    fiddly string work that fails silently and under-reports.
 *
 * THE MUTATION LOG IS A TRIPWIRE, NOT A RECORD
 * --------------------------------------------
 * Every request here is unauthorised, so NO handler body should run and NO
 * dependency should be touched — not just no writes. Each injected dependency is
 * therefore a Proxy whose every method records its name and throws. An empty log
 * is proof that nothing was reached; a non-empty one names the exact method that
 * was, which is far more diagnostic than asserting a row count stayed at zero.
 */
import { describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { computeAppProxySignature, type QueryParams } from "./auth/appProxy.js";
import { InMemoryCustomerResolver } from "./auth/identity.js";

const APP_PROXY_SECRET = "app-proxy-shared-secret";
const SHOPIFY_CUSTOMER_ID = "9395357876563";
const LOCAL_CUSTOMER_ID = "11111111-1111-4111-8111-111111111111";

/**
 * Routes intentionally served WITHOUT customer auth. Every entry needs a reason,
 * because this set is the entire deliberate exception surface — anything added
 * here is an authorisation decision, not a convenience.
 */
const PUBLIC_ROUTES = new Map<string, string>([
  ["/v1/version", "returns only the API version identifier; no customer data"],
  ["/v1/rewards", "the fixed reward catalogue; identical for every customer"],
  [
    "/v1/membership-card/verify",
    "a scanner presents a signed identifier and receives { valid, tier? } only — " +
      "a valid response requires a token our dedicated signing key produced",
  ],
]);

/**
 * The ADMIN surface is protected, but by a shared-secret admin credential rather
 * than by customer identity, so it fails with its own error rather than
 * `identity_resolution_failed`. It is still asserted to reject: no admin route may
 * ever answer 2xx unauthenticated, and none may touch a dependency.
 */
const ADMIN_PREFIX = "/v1/admin/";

/**
 * Dependency-gated routes that MUST appear in the census. If a future change stops
 * forwarding a dependency, these vanish from the app and would silently stop being
 * covered — so their absence is a failure here, not a smaller test run.
 */
const REQUIRED_PRESENT = [
  "/v1/balance",
  "/v1/history",
  // Orders (task 8.1/8.2). Registered unconditionally, like balance and history,
  // so a wiring change that dropped them would silently remove the two endpoints
  // that read a customer's own purchase history from Shopify.
  "/v1/orders",
  "/v1/orders/:orderId",
  // N3/N4 (task 8.3/8.4). Both register unconditionally too. The reorder plan is
  // the portal's only state-changing POST that reads an order, and the catalogue
  // route is the only /v1 endpoint backed by a Shopify Admin token that is NOT
  // customer-scoped — if either silently stopped registering, the 401 census would
  // shrink rather than fail, which is the failure this list exists to prevent.
  "/v1/orders/:orderId/reorder-plan",
  "/v1/catalog/products",
  "/v1/redeem",
  // N16 (task 10.2). Registered unconditionally, like balance and history.
  "/v1/redemptions",
  "/v1/profile",
  "/v1/profile/visit",
  "/v1/profile/favourites",
  // N10/N11 (task 12.2).
  "/v1/profile/birthday",
  "/v1/profile/wishlist",
  // N5 (task 9.1). The wishlist's only removal authority and the only writer of
  // the explicit-removal tombstone: if it silently stopped registering, removals
  // would go back to being undone by the next reconcile.
  "/v1/profile/wishlist/:productId",
  "/v1/profile/wishlist/reconcile",
  "/v1/profile/recently-viewed",
  "/v1/referral",
  "/v1/benefits",
  "/v1/devices",
  "/v1/membership-card",
];

/**
 * Concrete values for path parameters, so a parameterised route is reachable.
 *
 * MUST BE SINGLE-SEGMENT. An earlier version used `gid://shopify/Product/1` for
 * `:id`; the slashes made the path span several segments, so Fastify answered 404
 * and the request never reached the auth layer at all — the route silently went
 * untested while appearing to be covered. Values are validated below.
 */
const PARAM_VALUES: Record<string, string> = {
  ":token": "device-token-1",
  ":customerId": LOCAL_CUSTOMER_ID,
  ":id": "9999195275603",
  ":key": "perk",
  // A WELL-FORMED order reference (`^\d{1,20}$`), not a placeholder. With a
  // malformed value the census would still see 401 — but only because the id
  // never passed validation, which proves nothing about the route's auth. A
  // valid reference means the 401 must come from the auth layer itself.
  ":orderId": "6543210987",
};

function concretise(url: string): string {
  return url
    .split("/")
    .map((seg) => (seg.startsWith(":") ? (PARAM_VALUES[seg] ?? "x") : seg))
    .join("/");
}

/* ------------------------------------------------------------------------- */
/* Tripwire dependencies                                                      */
/* ------------------------------------------------------------------------- */

type Log = string[];

/**
 * Any property access returns a function that records `name.method` and throws.
 * Reaching business logic on an unauthorised request is the failure this whole
 * test exists to detect, so the fake refuses rather than pretending to work.
 */
function tripwire<T>(name: string, log: Log): T {
  return new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === "then") return undefined; // not a thenable
        return (...args: unknown[]) => {
          log.push(`${name}.${String(prop)}(${args.length} args)`);
          throw new Error(`tripwire: ${name}.${String(prop)} must not be reached unauthenticated`);
        };
      },
    },
  ) as T;
}

/** Full dependency set, so every conditionally-registered route exists. */
function buildCensusApp(log: Log): FastifyInstance {
  const config = loadConfig({
    NODE_ENV: "test",
    SHOPIFY_APP_PROXY_SECRET: APP_PROXY_SECRET,
    ADMIN_AUTH_SECRET: "admin-secret-for-registration-only",
    MEMBERSHIP_SIGNING_KEY: "membership-key-for-registration-only",
  } as NodeJS.ProcessEnv);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const t = (name: string): any => tripwire(name, log);

  return buildApp(config, {
    // The resolver is REAL: identity resolution must be allowed to run, because
    // the point is to prove it REFUSES. A tripwire here would mask the behaviour
    // under test by throwing before the auth decision was made.
    customerResolver: new InMemoryCustomerResolver({ [SHOPIFY_CUSTOMER_ID]: LOCAL_CUSTOMER_ID }),
    idempotencyStore: t("idempotencyStore"),
    balanceSource: t("balanceSource"),
    historySource: t("historySource"),
    // A tripwire rather than the routes' default in-memory source, so an
    // unauthorised orders request that somehow reached the handler NAMES the
    // method it touched instead of quietly returning an empty page.
    portalOrderSource: t("portalOrderSource"),
    entitlementResolver: t("entitlementResolver"),
    fragranceProfileDataSource: t("fragranceProfileDataSource"),
    portalVisitRecorder: t("portalVisitRecorder"),
    preferenceStore: t("preferenceStore"),
    recentlyViewedRecorder: t("recentlyViewedRecorder"),
    deviceTokenStore: t("deviceTokenStore"),
    membershipCredentialService: t("membershipCredentialService"),
    redeemDeps: t("redeemDeps"),
    referralDeps: t("referralDeps"),
    adminAuthenticator: t("adminAuthenticator"),
    adminAdjustmentService: t("adminAdjustmentService"),
    adminCustomerLedgerSource: t("adminCustomerLedgerSource"),
    fraudReviewSource: t("fraudReviewSource"),
    adminOperationsService: t("adminOperationsService"),
    analyticsService: t("analyticsService"),
    adminBenefitRequestService: t("adminBenefitRequestService"),
  });
}

interface Route {
  method: string;
  url: string;
}

/** Enumerate what Fastify actually registered. See subtlety 2 in the header. */
async function census(log: Log): Promise<{ app: FastifyInstance; routes: Route[] }> {
  const app = buildCensusApp(log);
  const routes: Route[] = [];
  app.addHook("onRoute", (r) => {
    const methods = Array.isArray(r.method) ? r.method : [r.method];
    for (const method of methods) routes.push({ method, url: r.url });
  });
  await app.ready();
  return { app, routes };
}

function signedQuery(params: QueryParams): string {
  // NB-13: every App Proxy request Shopify signs carries a `timestamp`, and the
  // auth layer now enforces a +/-5 minute freshness window and FAILS CLOSED when it
  // is absent. Defaulting it here keeps fixtures realistic; an explicit timestamp in
  // `params` still wins, so a staleness test can override it.
  const withTimestamp = { timestamp: String(Math.floor(Date.now() / 1000)), ...params };
  const withSig = { ...withTimestamp, signature: computeAppProxySignature(withTimestamp, APP_PROXY_SECRET) };
  const search = new URLSearchParams();
  for (const [k, v] of Object.entries(withSig)) if (typeof v === "string") search.set(k, v);
  return search.toString();
}

/** Scenario B: a genuinely signed request whose customer is anonymous (`0`). */
function anonymousSignedQuery(): string {
  return signedQuery({
    shop: "myathoorlondon.myshopify.com",
    logged_in_customer_id: "0",
    path_prefix: "/apps/loyalty",
    timestamp: String(Math.floor(Date.now() / 1000)),
  });
}

/** Scenario C: a valid signature over DIFFERENT params than those sent. */
function tamperedQuery(): string {
  const qs = signedQuery({
    shop: "myathoorlondon.myshopify.com",
    logged_in_customer_id: SHOPIFY_CUSTOMER_ID,
    path_prefix: "/apps/loyalty",
    timestamp: String(Math.floor(Date.now() / 1000)),
  });
  // Swap the id AFTER signing, so the signature no longer matches the payload.
  return qs.replace(SHOPIFY_CUSTOMER_ID, "1234567890123");
}

const BODY_METHODS = new Set(["POST", "PUT", "PATCH"]);

/* ------------------------------------------------------------------------- */

describe("route census — every protected /v1 route rejects unauthorised access", () => {
  it("uses single-segment parameter values, so no route is skipped as a 404", () => {
    // Guards the mistake described on PARAM_VALUES: a slash-bearing substitute
    // turns a 401 assertion into an unnoticed 404 and the route goes untested.
    for (const [param, value] of Object.entries(PARAM_VALUES)) {
      expect(value, `${param} substitute must not contain "/"`).not.toContain("/");
      expect(value.length, `${param} substitute must be non-empty`).toBeGreaterThan(0);
    }
  });


  it("enumerates the app's real routes, including dependency-gated ones", async () => {
    const log: Log = [];
    const { app, routes } = await census(log);
    try {
      const urls = new Set(routes.map((r) => r.url));
      for (const required of REQUIRED_PRESENT) {
        expect(urls.has(required), `route ${required} did not register — dependency wiring regressed`).toBe(true);
      }
      // Guards against the opposite failure: a census that silently shrinks.
      expect(routes.length).toBeGreaterThanOrEqual(40);
    } finally {
      await app.close();
    }
  });

  it("rejects EVERY protected route in all three unauthorised scenarios, touching nothing", async () => {
    const log: Log = [];
    const { app, routes } = await census(log);
    try {
      const protectedRoutes = routes.filter(
        (r) =>
          r.url.startsWith("/v1") &&
          r.method !== "HEAD" && // Fastify derives HEAD from GET; no body to assert
          r.method !== "OPTIONS" &&
          !PUBLIC_ROUTES.has(r.url),
      );

      expect(protectedRoutes.length).toBeGreaterThan(0);

      const failures: string[] = [];

      for (const route of protectedRoutes) {
        const path = concretise(route.url);
        const isAdmin = route.url.startsWith(ADMIN_PREFIX);

        const scenarios: { name: string; url: string; expectCode?: string }[] = [
          { name: "no auth", url: path, expectCode: "identity_resolution_failed" },
          {
            name: "signed but anonymous (logged_in_customer_id=0)",
            url: `${path}?${anonymousSignedQuery()}`,
            expectCode: "identity_resolution_failed",
          },
          {
            // A tampered signature is reported as its own, MORE SPECIFIC failure.
            // Forcing it to `identity_resolution_failed` would discard the
            // distinction between "you are nobody" and "this request was altered",
            // which is exactly the ambiguity Phase 0 spent days untangling.
            name: "invalid signature",
            url: `${path}?${tamperedQuery()}`,
            expectCode: "app_proxy_signature_invalid",
          },
        ];

        for (const s of scenarios) {
          const res = await app.inject({
            method: route.method as "GET",
            url: s.url,
            ...(BODY_METHODS.has(route.method)
              ? { payload: {}, headers: { "content-type": "application/json" } }
              : {}),
          });

          if (res.statusCode !== 401) {
            failures.push(`${route.method} ${route.url} [${s.name}] -> ${res.statusCode}, expected 401`);
            continue;
          }
          if (isAdmin) continue; // admin rejects with its own credential error

          const body = res.json() as { error?: string };
          if (body.error !== s.expectCode) {
            failures.push(
              `${route.method} ${route.url} [${s.name}] -> error "${body.error}", expected "${s.expectCode}"`,
            );
          }
        }
      }

      expect(failures, `unauthorised access was not correctly rejected:\n${failures.join("\n")}`).toEqual([]);

      // THE TRIPWIRE. No handler body ran, so no dependency was touched at all —
      // a strictly stronger claim than "no rows were written".
      expect(log, `dependencies were reached on unauthorised requests:\n${log.join("\n")}`).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it("the app's own auth allowlist is EXACTLY the three intended public routes", async () => {
    // THE DIRECT GUARD. Adding a route to `DEFAULT_PUBLIC_ROUTES` widens the
    // unauthenticated surface. Verified experimentally: allowlisting `/v1/balance`
    // does NOT leak data — `requireCustomerScope` still refuses, so it degrades to
    // a 401 with a less specific error code. That defence in depth is exactly what
    // 5.1/5.2 bought, but relying on the census noticing a subtle code change would
    // be luck. This compares the real allowlist against the intended one, so the
    // failure names the offending entry.
    const { DEFAULT_PUBLIC_ROUTES } = await import("./plugins/auth.js");
    const prefixed = DEFAULT_PUBLIC_ROUTES.filter((r) => r.startsWith("/v1/")).sort();
    expect(prefixed).toEqual([...PUBLIC_ROUTES.keys()].sort());

    // The allowlist also carries unprefixed twins so it matches whether or not the
    // matched route pattern includes the mount prefix. Each must have a /v1 twin,
    // so an unprefixed entry cannot smuggle in an un-reviewed public route.
    const unprefixed = DEFAULT_PUBLIC_ROUTES.filter((r) => !r.startsWith("/v1/"));
    for (const bare of unprefixed) {
      expect(
        DEFAULT_PUBLIC_ROUTES,
        `unprefixed allowlist entry ${bare} has no /v1 twin`,
      ).toContain(`/v1${bare}`);
    }
  });

  it("serves the public allowlist without auth, and it is exactly three routes", async () => {
    const log: Log = [];
    const { app, routes } = await census(log);
    try {
      const publicUrls = routes.filter((r) => PUBLIC_ROUTES.has(r.url)).map((r) => r.url);
      // Every allowlist entry must correspond to a route that exists, so the list
      // cannot rot into permitting something that was renamed.
      for (const url of PUBLIC_ROUTES.keys()) {
        expect(publicUrls, `allowlisted ${url} is not a registered route`).toContain(url);
      }
      expect(PUBLIC_ROUTES.size).toBe(3);

      // /v1/version and /v1/rewards answer with no credentials at all.
      for (const url of ["/v1/version", "/v1/rewards"]) {
        const res = await app.inject({ method: "GET", url });
        expect(res.statusCode, `${url} should be public`).toBe(200);
      }
    } finally {
      await app.close();
    }
  });

  it("a genuine internal fault stays 500 and is never relabelled as an auth failure", async () => {
    // The scope error handler must map ONLY ScopeUnavailableError. If it swallowed
    // everything, a real outage would surface as 401 and be misdiagnosed as an
    // auth problem — expensive, and exactly the confusion Phase 0 already paid for.
    const log: Log = [];
    const { app, routes } = await census(log);
    try {
      // `/v1/rewards` is public, so it reaches its handler with no identity needed.
      // Give it a dependency that throws to simulate an internal fault downstream.
      expect(routes.some((r) => r.url === "/v1/rewards")).toBe(true);

      await app.close();

      // Rebuild with a route whose handler throws, inside the same /v1 scope.
      const faultLog: Log = [];
      const faulty = buildCensusApp(faultLog);
      faulty.addHook("onRoute", () => {});
      await faulty.ready();

      // The membership-card verify route is public and delegates to the tripwire
      // service, which throws — an internal fault, not an auth failure.
      const res = await faulty.inject({ method: "GET", url: "/v1/membership-card/verify?token=abc" });
      expect(res.statusCode).not.toBe(401);
      expect(res.statusCode).toBeGreaterThanOrEqual(400);
      expect(JSON.stringify(res.json())).not.toContain("identity_resolution_failed");
      await faulty.close();
    } finally {
      // `app` already closed above in the happy path; closing twice is safe.
      await app.close().catch(() => {});
    }
  });
});
