/**
 * Tests for `GET /v1/membership-card` and `GET /v1/membership-card/verify`
 * (task 19.2, Req 19.5/19.6, additive-only Req 19.7).
 *
 * Exercises the routes through a real Fastify app wired with the actual `/v1`
 * auth layer and an in-memory Membership-Credential service — so NO live
 * Shopify or Postgres is touched. Verifies:
 *   - an authenticated customer is issued a signed, opaque, non-PII credential
 *     carrying member id + tier for wallet-pass readiness (Req 19.6);
 *   - the issue endpoint is identity-source agnostic (App Proxy vs CAA, Req 9.2);
 *   - an unauthenticated issue request is rejected before any work (Req 9.3);
 *   - the verify endpoint is PUBLIC and returns `{ valid, tier? }` ONLY, never
 *     any customer data (Req 19.5);
 *   - a forged/tampered credential fails verification (Req 19.5);
 *   - the surface fails closed (503) when the dedicated key is unconfigured;
 *   - existing endpoints are unaffected (Req 19.7).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { registerVersioning } from "../plugins/versioning.js";
import { v1Routes } from "./v1.js";
import { InMemoryCustomerResolver, FakeTokenVerifier } from "../auth/identity.js";
import { computeAppProxySignature, type QueryParams } from "../auth/appProxy.js";
import {
  DefaultMembershipCredentialService,
  InMemoryMembershipTierSource,
  type MembershipCredentialService,
} from "../membership/credential.js";
import type { Tier } from "../tier/tier.js";

const APP_PROXY_SECRET = "app-proxy-shared-secret";
const MEMBERSHIP_KEY = "dedicated-membership-signing-key";
const SHOPIFY_CUSTOMER_ID = "987654321";
const LOCAL_CUSTOMER_ID = "11111111-1111-4111-8111-111111111111";
const BEARER_TOKEN = "valid-caa-token";

function buildApp(opts: {
  service?: MembershipCredentialService;
  signingKey?: string;
  tier?: Tier;
}): FastifyInstance {
  const app = Fastify({ logger: false });
  registerVersioning(app);
  const service =
    opts.service ??
    new DefaultMembershipCredentialService(
      opts.signingKey ?? MEMBERSHIP_KEY,
      new InMemoryMembershipTierSource(
        opts.tier ? { [LOCAL_CUSTOMER_ID]: opts.tier } : {},
      ),
    );
  app.register(v1Routes, {
    prefix: "/v1",
    customerResolver: new InMemoryCustomerResolver({ [SHOPIFY_CUSTOMER_ID]: LOCAL_CUSTOMER_ID }),
    tokenVerifier: new FakeTokenVerifier({ [BEARER_TOKEN]: SHOPIFY_CUSTOMER_ID }),
    appProxySecret: APP_PROXY_SECRET,
    membershipCredentialService: service,
  });
  return app;
}

function bearer(): Record<string, string> {
  return { authorization: `Bearer ${BEARER_TOKEN}` };
}

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

describe("GET /v1/membership-card (Req 19.5/19.6)", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app?.close();
  });

  it("issues a signed, opaque, non-PII credential with member id + tier", async () => {
    app = buildApp({ tier: "gold" });
    await app.ready();

    const res = await app.inject({
      method: "GET",
      url: "/v1/membership-card",
      headers: bearer(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.tier).toBe("gold");
    expect(typeof body.memberId).toBe("string");
    expect(body.memberId).not.toBe(LOCAL_CUSTOMER_ID);
    expect(body.memberId).not.toContain(LOCAL_CUSTOMER_ID);
    expect(typeof body.signature).toBe("string");
    expect(typeof body.qrPayload).toBe("string");
    // Version envelope injected additively.
    expect(body.apiVersion).toBe("v1");
  });

  it("issues identically via App Proxy identity (Req 9.2)", async () => {
    app = buildApp({ tier: "silver" });
    await app.ready();

    const qs = signedQuery({
      shop: "myathoorlondon.myshopify.com",
      logged_in_customer_id: SHOPIFY_CUSTOMER_ID,
      path_prefix: "/apps/loyalty",
      timestamp: "1700000000",
    });
    const res = await app.inject({ method: "GET", url: `/v1/membership-card?${qs}` });
    expect(res.statusCode).toBe(200);
    expect(res.json().tier).toBe("silver");
  });

  it("returns 404 when the resolved customer is not a member", async () => {
    app = buildApp({}); // empty tier source
    await app.ready();
    const res = await app.inject({
      method: "GET",
      url: "/v1/membership-card",
      headers: bearer(),
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: "customer_not_found" });
  });

  it("rejects an unauthenticated issue request (Req 9.3)", async () => {
    app = buildApp({ tier: "gold" });
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/v1/membership-card" });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: "identity_resolution_failed" });
  });

  it("fails closed (503) when the dedicated signing key is unconfigured (Req 19.5)", async () => {
    app = buildApp({
      service: new DefaultMembershipCredentialService(
        undefined,
        new InMemoryMembershipTierSource({ [LOCAL_CUSTOMER_ID]: "gold" }),
      ),
    });
    await app.ready();
    const res = await app.inject({
      method: "GET",
      url: "/v1/membership-card",
      headers: bearer(),
    });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ error: "membership_service_unavailable" });
  });
});

describe("GET /v1/membership-card/verify (Req 19.5)", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app?.close();
  });

  it("is public and verifies a presented credential returning tier ONLY", async () => {
    const service = new DefaultMembershipCredentialService(
      MEMBERSHIP_KEY,
      new InMemoryMembershipTierSource({ [LOCAL_CUSTOMER_ID]: "royal_vip" }),
    );
    const cred = await service.issueCredential(LOCAL_CUSTOMER_ID);
    app = buildApp({ service });
    await app.ready();

    // No auth headers → confirms the endpoint is public.
    const res = await app.inject({
      method: "GET",
      url: `/v1/membership-card/verify?credential=${encodeURIComponent(cred.qrPayload)}`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.valid).toBe(true);
    expect(body.tier).toBe("royal_vip");
    // Never leaks the member id or customer id.
    expect(JSON.stringify(body)).not.toContain(cred.memberId);
    expect(JSON.stringify(body)).not.toContain(LOCAL_CUSTOMER_ID);
  });

  it("returns valid:false for a forged credential", async () => {
    app = buildApp({ tier: "gold" });
    await app.ready();
    const res = await app.inject({
      method: "GET",
      url: "/v1/membership-card/verify?credential=AML1.fakeid.royal_vip.fakesig",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ valid: false });
  });

  it("rejects a missing credential query param", async () => {
    app = buildApp({ tier: "gold" });
    await app.ready();
    const res = await app.inject({ method: "GET", url: "/v1/membership-card/verify" });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "missing_credential" });
  });

  it("fails closed (503) when the dedicated signing key is unconfigured", async () => {
    app = buildApp({
      service: new DefaultMembershipCredentialService(undefined, new InMemoryMembershipTierSource()),
    });
    await app.ready();
    const res = await app.inject({
      method: "GET",
      url: "/v1/membership-card/verify?credential=AML1.a.gold.b",
    });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ error: "membership_service_unavailable" });
  });
});

describe("additive-only: existing endpoints unaffected (Req 19.7)", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = buildApp({ tier: "gold" });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it("leaves the public /v1/rewards contract unchanged", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/rewards" });
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json().rewards)).toBe(true);
  });
});
