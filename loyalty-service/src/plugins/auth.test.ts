/**
 * Behavioural tests for the reusable auth middleware (task 6.2, Requirements
 * 9.2, 9.3, 11.3, 11.4).
 *
 * The middleware is exercised through a real Fastify instance with a protected
 * customer route that echoes the resolved `AuthCtx`, plus a public route. This
 * asserts:
 *   - a valid App Proxy signature resolves to the local customer id (Req 11.3);
 *   - a tampered/missing signature is rejected and logged_in_customer_id is
 *     ignored (Req 11.4);
 *   - a Customer Account API bearer token resolves via the injected fake
 *     verifier (Req 9.2, 11.5);
 *   - an unresolvable identity is rejected with no handler run (Req 9.3);
 *   - public routes are served without authentication.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { registerAuth } from "./auth.js";
import { computeAppProxySignature, type QueryParams } from "../auth/appProxy.js";
import { FakeTokenVerifier, InMemoryCustomerResolver } from "../auth/identity.js";

const APP_PROXY_SECRET = "app-proxy-shared-secret";
const SHOPIFY_CUSTOMER_ID = "987654321";
const LOCAL_CUSTOMER_ID = "11111111-1111-4111-8111-111111111111";
const BEARER_TOKEN = "valid-caa-token";

interface TestHarness {
  app: FastifyInstance;
  getSecureHits: () => number;
}

/**
 * Builds an app whose GET /secure is a protected customer endpoint (echoing the
 * resolved AuthCtx and counting invocations), and GET /public is unauthenticated.
 */
function buildTestApp(): TestHarness {
  const app = Fastify({ logger: false });
  let secureHits = 0;

  const resolver = new InMemoryCustomerResolver({ [SHOPIFY_CUSTOMER_ID]: LOCAL_CUSTOMER_ID });
  const tokenVerifier = new FakeTokenVerifier({ [BEARER_TOKEN]: SHOPIFY_CUSTOMER_ID });

  app.register(async (scope) => {
    registerAuth(scope, {
      resolver,
      tokenVerifier,
      appProxySecret: APP_PROXY_SECRET,
      // Match on the unprefixed route since this harness registers no /v1 prefix.
      publicRoutes: ["/public"],
    });

    scope.get("/secure", async (req) => {
      secureHits += 1;
      return { authCtx: req.authCtx };
    });

    scope.get("/public", async () => {
      return { ok: true };
    });
  });

  return { app, getSecureHits: () => secureHits };
}

/** Build the query string for a validly signed App Proxy request. */
function signedQuery(params: QueryParams): string {
  const withSig = { ...params, signature: computeAppProxySignature(params, APP_PROXY_SECRET) };
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(withSig)) {
    if (typeof value === "string") {
      search.set(key, value);
    }
  }
  return search.toString();
}

describe("auth middleware (Req 9.2/9.3/11.3/11.4)", () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = buildTestApp();
    await harness.app.ready();
  });

  afterEach(async () => {
    await harness.app.close();
  });

  it("resolves the local customer id from a valid App Proxy signature (Req 11.3)", async () => {
    const qs = signedQuery({
      shop: "myathoorlondon.myshopify.com",
      logged_in_customer_id: SHOPIFY_CUSTOMER_ID,
      path_prefix: "/apps/loyalty",
      timestamp: "1700000000",
    });
    const res = await harness.app.inject({ method: "GET", url: `/secure?${qs}` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      authCtx: { customerId: LOCAL_CUSTOMER_ID, source: "app_proxy", channel: "web" },
    });
  });

  it("rejects a tampered App Proxy signature and ignores logged_in_customer_id (Req 11.4)", async () => {
    // Sign for one customer, then swap the injected id — signature no longer matches.
    const qs = signedQuery({ shop: "athoor", logged_in_customer_id: SHOPIFY_CUSTOMER_ID });
    const tampered = qs.replace(
      `logged_in_customer_id=${SHOPIFY_CUSTOMER_ID}`,
      "logged_in_customer_id=123123123",
    );
    const res = await harness.app.inject({ method: "GET", url: `/secure?${tampered}` });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: "app_proxy_signature_invalid" });
    // Handler never ran → no state change / no trust in the injected id.
    expect(harness.getSecureHits()).toBe(0);
  });

  it("rejects an App Proxy request with a missing signature (Req 11.4)", async () => {
    const res = await harness.app.inject({
      method: "GET",
      url: `/secure?logged_in_customer_id=${SHOPIFY_CUSTOMER_ID}`,
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: "identity_resolution_failed" });
    expect(harness.getSecureHits()).toBe(0);
  });

  it("treats an anonymous (logged_in_customer_id=0) verified request as unresolvable (Req 9.3)", async () => {
    const qs = signedQuery({ shop: "athoor", logged_in_customer_id: "0" });
    const res = await harness.app.inject({ method: "GET", url: `/secure?${qs}` });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: "identity_resolution_failed" });
    expect(harness.getSecureHits()).toBe(0);
  });

  it("resolves the local customer id from a valid Customer Account API bearer token (Req 9.2)", async () => {
    const res = await harness.app.inject({
      method: "GET",
      url: "/secure",
      headers: { authorization: `Bearer ${BEARER_TOKEN}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      authCtx: { customerId: LOCAL_CUSTOMER_ID, source: "customer_account_api", channel: "app" },
    });
  });

  it("rejects an invalid bearer token with an identity-resolution failure (Req 9.3)", async () => {
    const res = await harness.app.inject({
      method: "GET",
      url: "/secure",
      headers: { authorization: "Bearer not-a-real-token" },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: "identity_resolution_failed" });
    expect(harness.getSecureHits()).toBe(0);
  });

  it("rejects a verified identity that maps to no local customer (Req 9.3)", async () => {
    // Sign a request for a Shopify id the resolver does not know.
    const qs = signedQuery({ shop: "athoor", logged_in_customer_id: "555000555" });
    const res = await harness.app.inject({ method: "GET", url: `/secure?${qs}` });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: "identity_resolution_failed" });
    expect(harness.getSecureHits()).toBe(0);
  });

  it("rejects a request bearing neither a signature nor a token (Req 9.3)", async () => {
    const res = await harness.app.inject({ method: "GET", url: "/secure" });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: "identity_resolution_failed" });
    expect(harness.getSecureHits()).toBe(0);
  });

  it("serves a public route without authentication", async () => {
    const res = await harness.app.inject({ method: "GET", url: "/public" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true });
  });
});

describe("auth middleware fails closed without an App Proxy secret (Req 11.4)", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = Fastify({ logger: false });
    app.register(async (scope) => {
      registerAuth(scope, {
        resolver: new InMemoryCustomerResolver({ [SHOPIFY_CUSTOMER_ID]: LOCAL_CUSTOMER_ID }),
        // No appProxySecret configured.
        publicRoutes: ["/public"],
      });
      scope.get("/secure", async (req) => ({ authCtx: req.authCtx }));
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it("rejects an App Proxy request when no shared secret is configured", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/secure?logged_in_customer_id=${SHOPIFY_CUSTOMER_ID}&signature=abc123`,
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: "app_proxy_verification_unavailable" });
  });
});
